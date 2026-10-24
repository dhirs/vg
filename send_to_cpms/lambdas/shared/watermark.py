"""Watermark helpers shared by step 3 (filter stale) and step 6 (advance watermark).

One JSON object per subject at <prefix>/watermarks/<sha256(subjectId)>.json, mapping each
consent/preference item key to the capturedAt of the newest decision already sent.
Both steps must derive item keys identically, which is why this lives in one place.
See design.md -> "Out-of-order arrival".
"""
import hashlib
import json
from datetime import datetime


def object_key(prefix, subject_id):
    # hashed so raw identifiers (emails) never appear in object keys, logs or S3 inventory
    return f"{prefix}/watermarks/{hashlib.sha256(subject_id.encode()).hexdigest()}.json"


def item_keys(record):
    """Yield (item key, item, list name) for every consent and preference item in a canonical record."""
    for item in record.get("consent", []):
        yield f"purpose#{item['purposeCode']}", item, "consent"
    for item in record.get("preferences", []):
        yield f"pref#{item['topicCode']}#{item['channel']}", item, "preferences"


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def read(s3, bucket, key):
    """Return (marks, etag); ({}, None) when the subject has no watermark yet."""
    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
    except s3.exceptions.NoSuchKey:
        return {}, None
    return json.loads(obj["Body"].read()), obj["ETag"]
