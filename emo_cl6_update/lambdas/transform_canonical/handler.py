"""Step 2 — transform a validated source event into the canonical record, and validate it.

One universal mapping for every source (they all send the same source_event shape). The
result is checked against canonical_consent.schema.json before it's returned: validating
our own output belongs with the code that produced it — a failure either way means *our*
transform is wrong (design.md -> "Why step 1 is separate from step 2").
Raises on anything unexpected, including an off-contract result; the state machine
records that as a logic failure. Taxonomy and schema are read from S3 on every invocation.
"""
import json
import os
import re
from datetime import datetime, timezone

import boto3
from jsonschema import Draft202012Validator, FormatChecker

s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("PREFIX", "cpms")
CANONICAL_SCHEMA_VERSION = "1.0"
# Sources may spell identifier types inconsistently ('member_id', 'MemberID'); canonical uses one spelling.
IDENTIFIER_TYPES = {"email": "email", "memberid": "memberId", "clientid": "clientId"}


class CanonicalContractError(Exception):
    """The transform produced a record that doesn't match canonical_consent.schema.json."""


def read_json(key):
    return json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())


def normalize_identifier_type(value):
    return IDENTIFIER_TYPES.get(re.sub(r"[^a-z]", "", value.lower()), value)


def transform(event, taxonomy, processed_at):
    legal_basis = {p["code"]: p.get("legalBasis") for p in taxonomy["purposeCodes"]}
    src_prov = event["provenance"]

    consent = []
    for item in event.get("consent", []):
        out = {"purposeCode": item["purpose"], "status": item["status"], "capturedAt": item["capturedAt"],
               "captureMethod": item["captureMethod"]}
        if legal_basis.get(item["purpose"]):  # derived from the taxonomy — sources never send it
            out["legalBasis"] = legal_basis[item["purpose"]]
        consent.append(out)

    provenance = {"sourceEventId": src_prov["sourceEventId"], "captureChannel": src_prov["captureChannel"]}
    for key in ("locale", "policyVersion"):
        if key in src_prov:
            provenance[key] = src_prov[key]

    return {
        "header": {
            "schemaVersion": CANONICAL_SCHEMA_VERSION,
            "eventId": event["eventId"],
            "eventType": event["eventType"],
            "sourceSystem": event["sourceSystem"],
            "occurredAt": event["occurredAt"],
            "correlationId": src_prov.get("correlationId") or event["eventId"],
            "processedAt": processed_at,
        },
        "subject": {
            "subjectId": event["subject"]["identifierValue"],  # already lowercased/trimmed for emails (schema-enforced)
            "identifierType": normalize_identifier_type(event["subject"]["identifierType"]),
        },
        "consent": consent,
        "preferences": [
            {"topicCode": p["topic"], "channel": p["channel"], "status": p["status"], "capturedAt": p["capturedAt"]}
            for p in event.get("preferences", [])
        ],
        "provenance": provenance,
    }


def contract_errors(record, schema):
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    return [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in validator.iter_errors(record)]


def handler(event, context):
    taxonomy = read_json(f"{PREFIX}/taxonomy/taxonomy.json")
    record = transform(event, taxonomy, datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    schema = read_json(f"{PREFIX}/schemas/canonical_consent/{CANONICAL_SCHEMA_VERSION}/canonical_consent.schema.json")
    errors = contract_errors(record, schema)
    if errors:
        raise CanonicalContractError(json.dumps(errors))
    return record
