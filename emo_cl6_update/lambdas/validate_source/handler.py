"""Step 1 — validate a source event: structural (JSON Schema) + content (taxonomy, timestamps).

Returns {valid, errors} and never raises on bad data: a rejected event is an expected
outcome, not an exception. Schema and taxonomy are read from S3 on every invocation — dev
has no cache, so a taxonomy change is visible to the very next event
(design.md -> "Development environment").
"""
import json
import os
from datetime import datetime, timedelta, timezone

import boto3
from jsonschema import Draft202012Validator, FormatChecker

s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("PREFIX", "cpms")
CLOCK_SKEW = timedelta(minutes=5)  # tolerated source clock drift for "not in the future"


def read_json(key):
    return json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def structural_errors(event, schema):
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    return [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in validator.iter_errors(event)]


def content_errors(event, taxonomy, now):
    purposes = {p["code"] for p in taxonomy["purposeCodes"]}
    topics = {t["code"] for t in taxonomy["topicCodes"]}
    channels = {c["code"] for c in taxonomy["channels"]}
    errors = []
    for i, item in enumerate(event.get("consent", [])):
        if item["purpose"] not in purposes:
            errors.append(f"consent/{i}/purpose: unknown purpose code '{item['purpose']}'")
    for i, item in enumerate(event.get("preferences", [])):
        if item["topic"] not in topics:
            errors.append(f"preferences/{i}/topic: unknown topic code '{item['topic']}'")
        if item["channel"] not in channels:
            errors.append(f"preferences/{i}/channel: unknown channel '{item['channel']}'")
    stamps = [("occurredAt", event["occurredAt"])]
    stamps += [(f"{k}/{i}/capturedAt", it["capturedAt"]) for k in ("consent", "preferences") for i, it in enumerate(event.get(k, []))]
    for path, value in stamps:
        if parse_time(value) > now + CLOCK_SKEW:
            errors.append(f"{path}: '{value}' is in the future")
    return errors


def handler(event, context):
    version = event.get("schemaVersion") if isinstance(event, dict) else None
    if not isinstance(version, str):
        return {"valid": False, "errors": ["schemaVersion: missing or not a string"]}
    try:
        schema = read_json(f"{PREFIX}/schemas/source_event/{version}/source_event.schema.json")
    except s3.exceptions.NoSuchKey:
        return {"valid": False, "errors": [f"schemaVersion: no published source_event schema for version '{version}'"]}

    errors = structural_errors(event, schema)
    if not errors:  # content checks assume the structure is right
        errors = content_errors(event, read_json(f"{PREFIX}/taxonomy/taxonomy.json"), datetime.now(timezone.utc))
    return {"valid": not errors, "errors": errors}
