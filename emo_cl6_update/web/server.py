"""Local preference-centre test page: builds a source_event, sends it to EventBridge, and
shows what CPMS made of it.

Usage: python3 emo_cl6_update/web/server.py   then open http://localhost:8600

The browser never sees AWS credentials — it posts choices here, this server builds and
validates the source_event, and sends it with boto3 using the keys in .env.prod. The
result (OneTrust requests / skipped / rejected) is read back from the run's success or
fail record in S3: cpms/{success,fail}/<eventId>/<run>.json.
"""
import json
import re
import sys
import uuid
from urllib.parse import parse_qs, urlparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
from aws_env import BUS_NAME, FLOW_DIR, PREFIX, bucket_name, events_client, s3_client  # noqa: E402

PORT = 8600
STATIC = Path(__file__).resolve().parent / "static"
SCHEMA = json.loads((FLOW_DIR / "schemas/source_event.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
TAXONOMY = json.loads((FLOW_DIR / "taxonomy/taxonomy.sample.json").read_text())

SOURCE_SYSTEM = "vanguard-portal"
EVENT_TYPE = "account_registration"  # the form models a new registration
POLICY_VERSION = "privacy-2026-01"


def build_event(email, choices, locale):
    """choices: [{topic, channel, optedIn}] — only what the user selected (new registration: no implicit opt-outs)."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    provenance = {"sourceEventId": f"pc-{uuid.uuid4().hex[:12]}", "captureChannel": "web", "policyVersion": POLICY_VERSION}
    if locale:
        provenance["locale"] = locale
    return {
        "schemaVersion": "1.0",
        "eventId": str(uuid.uuid4()),
        "eventType": EVENT_TYPE,
        "sourceSystem": SOURCE_SYSTEM,
        "occurredAt": now,
        "subject": {"identifierType": "email", "identifierValue": email.strip().lower()},
        "preferences": [
            {"topic": c["topic"], "channel": c["channel"], "status": "opt_in" if c["optedIn"] else "opt_out", "capturedAt": now}
            for c in choices
        ],
        "provenance": provenance,
    }


def schema_errors(event):
    return [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in VALIDATOR.iter_errors(event)]


def record_id(event_id):
    """Same folder name the FIFO consumer uses for this event's records."""
    return re.sub(r"[^A-Za-z0-9._-]", "_", event_id)[:200] if event_id and event_id.strip() else "no-event-id"


def error_detail(error):
    """A Step Functions Catch error {Error, Cause} -> readable list. Our Lambdas raise with a JSON list of errors."""
    try:
        message = json.loads(error.get("Cause", "{}")).get("errorMessage", "")
    except (ValueError, AttributeError):
        return [str(error)]
    try:
        parsed = json.loads(message)
        return parsed if isinstance(parsed, list) else [message]
    except ValueError:
        return [f"{error.get('Error')}: {message}"]


def run_result(event_id):
    """The latest success/fail record for this event, summarised for the page. None while still processing."""
    s3, bucket = s3_client(), bucket_name()
    found = []
    for kind in ("success", "fail"):
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=f"{PREFIX}/{kind}/{record_id(event_id)}/")
        found += [(obj["LastModified"], kind, obj["Key"]) for obj in resp.get("Contents", [])]
    if not found:
        return None
    _, kind, key = max(found)
    state = json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
    if kind == "fail":
        errors = state.get("validation", {}).get("errors") if not state.get("validation", {}).get("valid", True) else None
        return {"outcome": "rejected", "failedStep": state.get("failedStep"),
                "errors": errors or error_detail(state.get("error", {})), "record": f"s3://{bucket}/{key}"}
    result = state.get("result", {})
    return {"outcome": result.get("outcome"), "requests": result.get("requests", []), "dropped": result.get("dropped", []),
            "warning": result.get("warning"), "record": f"s3://{bucket}/{key}"}


def put_entry(event):
    return {"EventBusName": BUS_NAME, "Source": f"cpms.{event['sourceSystem']}", "DetailType": event["eventType"]}


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/result":
            event_id = (parse_qs(url.query).get("eventId") or [""])[0]
            try:
                result = run_result(event_id)
            except Exception as e:  # surface AWS errors (permissions) on the page
                return self._json(502, {"errors": [f"{type(e).__name__}: {e}"]})
            return self._json(200, {"status": "pending"} if result is None else {"status": "done", **result})
        if self.path == "/api/taxonomy":
            return self._json(200, {"channels": TAXONOMY["channels"], "topics": TAXONOMY["topicCodes"]})
        if self.path in ("/", "/index.html"):
            data = (STATIC / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path == "/api/preview":
            event = build_event(body.get("email", ""), body.get("choices", []), body.get("locale"))
            errors = schema_errors(event)
            return self._json(400 if errors else 200, {"event": event, "entry": put_entry(event), "errors": errors})
        if self.path == "/api/send":
            event = body.get("event") or {}
            errors = schema_errors(event)
            if errors:
                return self._json(400, {"errors": errors})
            try:
                resp = events_client().put_events(Entries=[dict(put_entry(event), Detail=json.dumps(event))])
            except Exception as e:  # surface AWS errors (missing bus, permissions) in the modal
                return self._json(502, {"errors": [f"{type(e).__name__}: {e}"]})
            entry = resp["Entries"][0]
            if resp["FailedEntryCount"]:
                return self._json(502, {"errors": [f"{entry.get('ErrorCode')}: {entry.get('ErrorMessage')}"]})
            return self._json(200, {"eventBridgeId": entry["EventId"], "bus": BUS_NAME})
        self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        print(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")


if __name__ == "__main__":
    print(f"Preference centre running at http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
