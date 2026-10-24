"""Ingestion FIFO consumer: runs one Step Function execution per message and waits for it.

Waiting is what serializes processing per email: SQS won't release the next message in
this message group until this invocation returns. Raising makes SQS retry the message
(and move it to the ingestion DLQ after 5 receives), so we raise only when the run itself
broke (FAILED / TIMED_OUT). A rejected event is not a broken run — the state machine
records it and ends SUCCEEDED with outcome "rejected".
"""
import json
import os
import re

import boto3

sfn = boto3.client("stepfunctions")
STATE_MACHINE_ARN = os.environ["STATE_MACHINE_ARN"]


def record_id(detail):
    """Folder name for this event's success/fail records: cpms/{success,fail}/<record_id>/<run>.json.
    The eventId when there is a usable one (so results can be looked up by it), else a fixed bucket."""
    event_id = detail.get("eventId") if isinstance(detail, dict) else None
    if not isinstance(event_id, str) or not event_id.strip():
        return "no-event-id"
    return re.sub(r"[^A-Za-z0-9._-]", "_", event_id)[:200]  # keep it a safe single S3 key segment


def handler(event, context):
    for record in event["Records"]:  # batch size is 1
        envelope = json.loads(record["body"])
        run_input = {
            "sourceEvent": envelope.get("detail"),
            "eventBridge": {k: envelope.get(k) for k in ("id", "source", "detail-type", "time")},
            "recordId": record_id(envelope.get("detail")),
        }
        resp = sfn.start_sync_execution(stateMachineArn=STATE_MACHINE_ARN, input=json.dumps(run_input))
        output = json.loads(resp.get("output") or "{}")
        print(json.dumps({
            "messageGroupId": record["attributes"].get("MessageGroupId"),
            "eventBridgeId": envelope.get("id"),
            "executionArn": resp["executionArn"],
            "status": resp["status"],
            "outcome": output.get("outcome"),
        }))
        if resp["status"] != "SUCCEEDED":
            raise RuntimeError(f"Step Function run {resp['status']}: {resp.get('error')} — {resp.get('cause')}")
