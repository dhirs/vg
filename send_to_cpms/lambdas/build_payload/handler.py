"""Step 4 — build complete OneTrust Consent Receipt requests from the canonical record, and validate them.

One receipt per distinct capturedAt (a receipt carries a single interactionDate, which is
what lets OneTrust ignore out-of-order receipts), at most 20 purposes each, returned oldest
first. Every request is validated against onetrust_request.schema.json before returning —
OneTrust's API does no data-type validation, so this is the only check before OneTrust.
Raises on anything unexpected or off-contract (= our code or taxonomy config is wrong).
Mapping: design.md -> "Outbound message format".
"""
import json
import os
from collections import defaultdict
from datetime import datetime

import boto3
from jsonschema import Draft202012Validator, FormatChecker

s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("PREFIX", "cpms")
ONETRUST_HOST = os.environ["ONETRUST_HOST"]
COLLECTION_POINT_JWT = os.environ["ONETRUST_COLLECTION_POINT_JWT"]
REQUEST_SCHEMA_VERSION = "1.0"
MAX_PURPOSES_PER_RECEIPT = 20  # OneTrust's absolute maximum

PURPOSE_TRANSACTION = {"opt_in": "CONFIRMED", "granted": "CONFIRMED", "opt_out": "OPT_OUT", "withdrawn": "WITHDRAWN"}
OPTION_TRANSACTION = {"opt_in": "OPT_IN", "granted": "OPT_IN", "opt_out": "OPT_OUT", "withdrawn": "OPT_OUT"}
IDENTIFIER_TYPES = {"email": "Email"}
# Purpose carried only because its topics changed (no consent decision on the purpose itself).
PREFERENCES_ONLY = "CHANGE_PREFERENCES"


class TaxonomyMappingError(Exception):
    """A code has no OneTrust mapping in the taxonomy (config problem, not bad source data)."""


class OneTrustContractError(Exception):
    """A built request doesn't match onetrust_request.schema.json."""


def read_json(key):
    return json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def lookup(taxonomy, kind, code):
    for entry in taxonomy[kind]:
        if entry["code"] == code:
            return entry
    raise TaxonomyMappingError(f"{kind}: no taxonomy entry for '{code}'")


def topic_transaction(items, all_channels):
    """Topic-level OPT_IN if any channel is opted in; OPT_OUT only when *every* channel is
    present and opted out. Otherwise omit it — a partial set of channel opt-outs says
    nothing about the topic as a whole, and must not switch the topic off."""
    statuses = {i["channel"]: OPTION_TRANSACTION[i["status"]] for i in items}
    if "OPT_IN" in statuses.values():
        return "OPT_IN"
    if set(statuses) >= set(all_channels):
        return "OPT_OUT"
    return None


def build_purposes(consent, preferences, taxonomy):
    purposes = {}  # purposeCode -> DsPurpose, insertion-ordered
    for item in consent:
        purpose = lookup(taxonomy, "purposeCodes", item["purposeCode"])
        purposes[item["purposeCode"]] = {"Id": purpose["oneTrustPurposeId"], "TransactionType": PURPOSE_TRANSACTION[item["status"]]}

    by_topic = defaultdict(list)
    for item in preferences:
        by_topic[item["topicCode"]].append(item)
    all_channels = [c["code"] for c in taxonomy["channels"]]
    for topic_code, items in by_topic.items():
        topic = lookup(taxonomy, "topicCodes", topic_code)
        parent_code = topic["purposeCode"]
        purpose = purposes.setdefault(parent_code, {
            "Id": lookup(taxonomy, "purposeCodes", parent_code)["oneTrustPurposeId"], "TransactionType": PREFERENCES_ONLY})
        try:
            choices = [{"OptionId": topic["oneTrustChannelOptions"][i["channel"]], "TransactionType": OPTION_TRANSACTION[i["status"]]}
                       for i in items]
        except KeyError as e:
            raise TaxonomyMappingError(f"topicCodes: '{topic_code}' has no OneTrust option for channel {e}") from None
        custom = {"Id": topic["oneTrustChannelPreferenceId"]}
        if purpose["TransactionType"] == PREFERENCES_ONLY:
            custom["Choices"] = choices  # explicit per-option in/out: a partial update
        else:
            custom["Options"] = [c["OptionId"] for c in choices if c["TransactionType"] == "OPT_IN"]  # opted-in options only
        purpose.setdefault("CustomPreferences", []).append(custom)
        tx = topic_transaction(items, all_channels)
        if tx:
            purpose.setdefault("Preferences", []).append({"TopicId": topic["oneTrustTopicId"], "TransactionType": tx})
    return list(purposes.values())


def request(record, interaction_date, purposes):
    body = {
        "identifier": record["subject"]["subjectId"],
        "requestInformation": COLLECTION_POINT_JWT,
        "interactionDate": interaction_date,
        "purposes": purposes,
    }
    identifier_type = IDENTIFIER_TYPES.get(record["subject"]["identifierType"])
    if identifier_type:
        body["identifierType"] = identifier_type
    if record["provenance"].get("locale"):
        body["language"] = record["provenance"]["locale"]
    return {
        "method": "POST",
        "url": f"https://{ONETRUST_HOST}/request/v1/consentreceipts",
        "headers": {"Content-Type": "application/json"},
        "correlationId": record["header"]["correlationId"],
        "body": body,
    }


def build_requests(record, taxonomy):
    groups = defaultdict(lambda: {"consent": [], "preferences": []})
    for kind in ("consent", "preferences"):
        for item in record.get(kind, []):
            groups[item["capturedAt"]][kind].append(item)
    requests = []
    for captured_at in sorted(groups, key=parse_time):  # oldest first
        purposes = build_purposes(groups[captured_at]["consent"], groups[captured_at]["preferences"], taxonomy)
        for i in range(0, len(purposes), MAX_PURPOSES_PER_RECEIPT):
            requests.append(request(record, captured_at, purposes[i:i + MAX_PURPOSES_PER_RECEIPT]))
    return requests


def contract_errors(requests, schema):
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    return [f"requests/{n}/{'/'.join(map(str, e.path))}: {e.message}" for n, r in enumerate(requests) for e in validator.iter_errors(r)]


def handler(event, context):
    requests = build_requests(event, read_json(f"{PREFIX}/taxonomy/taxonomy.json"))
    errors = contract_errors(requests, read_json(f"{PREFIX}/schemas/onetrust_request/{REQUEST_SCHEMA_VERSION}/onetrust_request.schema.json"))
    if errors:
        raise OneTrustContractError(json.dumps(errors))
    return {"requests": requests}
