"""Step 3 — drop consent/preference items that aren't newer than what was already sent.

An item is stale when its capturedAt is <= the subject's watermark for that item ('<=' so
a replay of the same decision is dropped too). Read-only: the watermark is advanced by
step 6, only after the payload is safely enqueued (design.md -> "Out-of-order arrival").
"""
import os

import boto3

import watermark

s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("PREFIX", "cpms")


def handler(event, context):
    record = event
    marks, etag = watermark.read(s3, BUCKET, watermark.object_key(PREFIX, record["subject"]["subjectId"]))

    kept = {"consent": [], "preferences": []}
    dropped = []
    for key, item, list_name in watermark.item_keys(record):
        mark = marks.get(key)
        if mark and watermark.parse_time(item["capturedAt"]) <= watermark.parse_time(mark["capturedAt"]):
            dropped.append({"item": key, "capturedAt": item["capturedAt"], "watermark": mark["capturedAt"]})
        else:
            kept[list_name].append(item)

    return {
        "record": {**record, **kept},
        "dropped": dropped,
        "allStale": not kept["consent"] and not kept["preferences"],
        "etag": etag,  # passed to step 6 so it can tell whether the watermark changed in between
    }
