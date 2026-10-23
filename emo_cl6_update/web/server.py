"""Local preference-centre test page: builds a source_event and sends it to EventBridge.

Usage: python3 emo_cl6_update/web/server.py   then open http://localhost:8600

The browser never sees AWS credentials — it posts choices here, this server builds and
validates the source_event, and sends it with boto3 using the keys in .env.prod.
"""
import json
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))
from aws_env import BUS_NAME, FLOW_DIR, events_client  # noqa: E402

PORT = 8600
STATIC = Path(__file__).resolve().parent / "static"
SCHEMA = json.loads((FLOW_DIR / "schemas/source_event.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
TAXONOMY = json.loads((FLOW_DIR / "taxonomy/taxonomy.sample.json").read_text())

SOURCE_SYSTEM = "vanguard-portal"
EVENT_TYPE = "preference_update"
POLICY_VERSION = "privacy-2026-01"


def build_event(email, choices, locale):
    """choices: [{topic, channel, optedIn}] — every topic x channel shown on the form."""
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
