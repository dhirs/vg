"""Step 6 — record the sent items' capturedAt in the subject's watermark.

Read -> merge -> conditional PutObject (If-Match the ETag just read, or If-None-Match '*'
for a new subject). On 412/409 someone wrote in between: re-read, re-merge, retry. The
merge is monotonic — a watermark never moves backwards — so retrying or racing with
another run can't undo a newer decision. Runs only after the payload is enqueued.
"""
import json
import os

import boto3
from botocore.exceptions import ClientError

import watermark

s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("PREFIX", "cpms")
MAX_ATTEMPTS = 5
CONFLICT_CODES = {"PreconditionFailed", "ConditionalRequestConflict"}


def merge(marks, record):
    merged, advanced = dict(marks), []
    for key, item, _ in watermark.item_keys(record):
        current = merged.get(key)
        if not current or watermark.parse_time(item["capturedAt"]) > watermark.parse_time(current["capturedAt"]):
            merged[key] = {"capturedAt": item["capturedAt"], "eventId": record["header"]["eventId"]}
            advanced.append(key)
    return merged, advanced


def handler(event, context):
    record, etag_at_filter = event["record"], event.get("etag")
    key = watermark.object_key(PREFIX, record["subject"]["subjectId"])
    for attempt in range(1, MAX_ATTEMPTS + 1):
        marks, etag = watermark.read(s3, BUCKET, key)
        merged, advanced = merge(marks, record)
        condition = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
        try:
            s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(merged, indent=2),
                          ContentType="application/json", **condition)
        except ClientError as e:
            if e.response["Error"]["Code"] in CONFLICT_CODES and attempt < MAX_ATTEMPTS:
                continue
            raise
        return {"advanced": advanced, "attempts": attempt,
                # True means another write landed between step 3 and here — expected only if
                # the one-run-per-subject FIFO guarantee was bypassed (e.g. a manual reprocess)
                "changedSinceFilter": etag != etag_at_filter}
