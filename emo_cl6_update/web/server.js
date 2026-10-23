// Local test app for the emo_cl6_update flow.
//
// Mirrors the real registration pages (event registration via EMO, new adviser account via
// CL6): on submit it builds the source_event that page's backend sends to CPMS,
// validates it against schemas/source_event.schema.json, puts it on
// the cpms-eventbus-consent EventBridge bus, and reads back what CPMS made of it (OneTrust
// requests / skipped / rejected) from the run's record in S3:
// cpms/{success,fail}/<eventId>/<run>.json.
//
// The browser never sees AWS credentials — they're read here from the repo-root .env.prod.
//
// Usage: cd emo_cl6_update/web && npm install && npm start   ->   http://localhost:8600
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import express from "express";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOW_DIR = join(HERE, "..");
const REPO_ROOT = join(FLOW_DIR, "..");
const PORT = 8600;
const BUS_NAME = "cpms-eventbus-consent";
const PREFIX = "cpms";

// Neither real page has granular choices: submitting the form *is* the agreement
// ("By registering / creating an account, you will also receive marketing communications…").
// So each flow sends a consent-only source_event. Purposes per flow are assumptions
// (design.md -> Open items). sourceSystem records where the consent came from — the event
// format is the same standard source_event for every flow.
const POLICY_VERSION = "privacy-2026-01"; // placeholder until the source supplies the agreed policy version
const FLOWS = {
  event: {
    sourceSystem: "emo",
    eventType: "event_registration",
    purposes: ["marketing_email", "event_communications"],
    captureMethod: "implied_by_registration",
  },
  account: {
    sourceSystem: "cl6",
    eventType: "account_registration",
    // marketing comes with account creation; accepting the T&Cs / IP agreement is the account contract
    purposes: ["marketing_email", "account_servicing"],
    captureMethod: "implied_by_account_creation",
  },
};

// Page content (shown on the pages; not part of the source_event).
const EVENT = {
  title: "Autumn Budget 2026: The Adviser Briefing",
  date: "Wednesday, 28 October 2026",
  time: "16:00 to 16:30",
  format: "Webinar",
  cpd: "30 minutes CPD",
  presenters: [
    { name: "Warwick Bloore", role: "Senior Specialist, Advisory Research Centre" },
    { name: "Katy Hyams", role: "Head of Advocacy, UK" },
    { name: "Roy Wilkinson", role: "Strategic Account Manager (moderator)" },
  ],
};
const FIRM_SIZES = ["£0 to £50 million", "£50 to £250 million", "£250 million to £1 billion", "£1 to £5 billion", "Over £5 billion"];
const COMPANY_TYPES = [
  { value: "financial_adviser_firm", label: "Financial adviser firm", description: "I work at a financial adviser firm and advise clients on their investment decisions." },
  { value: "institutional_client", label: "Institutional client", description: "I work at/with a large institution such as a pension fund, charity or insurance company." },
  { value: "wealth_manager", label: "Wealth manager", description: "I have discretion to invest on behalf of my clients." },
];

function loadEnv(path) {
  const env = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv(join(REPO_ROOT, ".env.prod"));
const awsConfig = {
  region: env.AWS_DEFAULT_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
};
const BUCKET = env.AWS_BUCKET_NAME;
const eventBridge = new EventBridgeClient(awsConfig);
const s3 = new S3Client(awsConfig);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSourceEvent = ajv.compile(JSON.parse(readFileSync(join(FLOW_DIR, "schemas/source_event.schema.json"), "utf8")));

const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function buildEvent({ flow, email, locale }) {
  const f = FLOWS[flow];
  if (!f) return null;
  const now = isoNow();
  const provenance = { sourceEventId: `${f.sourceSystem}-${randomUUID().slice(0, 12)}`, captureChannel: "web", policyVersion: POLICY_VERSION };
  if (locale) provenance.locale = locale;
  return {
    schemaVersion: "1.0",
    eventId: randomUUID(),
    eventType: f.eventType,
    sourceSystem: f.sourceSystem,
    occurredAt: now,
    subject: { identifierType: "email", identifierValue: String(email || "").trim().toLowerCase() },
    consent: f.purposes.map((purpose) => ({ purpose, status: "granted", capturedAt: now, captureMethod: f.captureMethod })),
    provenance,
  };
}

function schemaErrors(event) {
  if (validateSourceEvent(event)) return [];
  return validateSourceEvent.errors.map((e) => `${e.instancePath.slice(1) || "(root)"}: ${e.message}`);
}

const putEntry = (event) => ({ EventBusName: BUS_NAME, Source: `cpms.${event.sourceSystem}`, DetailType: event.eventType });

// Same folder name the FIFO consumer uses for an event's records.
const recordId = (eventId) => (eventId && eventId.trim() ? eventId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) : "no-event-id");

// A Step Functions Catch error {Error, Cause} -> readable list. Our Lambdas raise with a JSON list of errors.
function errorDetail(error = {}) {
  let message;
  try {
    message = JSON.parse(error.Cause || "{}").errorMessage || "";
  } catch {
    return [JSON.stringify(error)];
  }
  try {
    const parsed = JSON.parse(message);
    return Array.isArray(parsed) ? parsed : [message];
  } catch {
    return [`${error.Error}: ${message}`];
  }
}

async function runResult(eventId) {
  const found = [];
  for (const kind of ["success", "fail"]) {
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}/${kind}/${recordId(eventId)}/` }));
    for (const obj of resp.Contents || []) found.push({ at: obj.LastModified, kind, key: obj.Key });
  }
  if (!found.length) return null;
  const latest = found.sort((a, b) => b.at - a.at)[0];
  const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: latest.key }));
  const state = JSON.parse(await body.Body.transformToString());
  const record = `s3://${BUCKET}/${latest.key}`;
  if (latest.kind === "fail") {
    const validation = state.validation || {};
    const errors = validation.valid === false ? validation.errors : errorDetail(state.error);
    return { outcome: "rejected", failedStep: state.failedStep, errors, record };
  }
  const result = state.result || {};
  return { outcome: result.outcome, requests: result.requests || [], dropped: result.dropped || [], warning: result.warning, record };
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(join(HERE, "public")));

app.get("/api/config", (req, res) => res.json({ event: EVENT, firmSizes: FIRM_SIZES, companyTypes: COMPANY_TYPES, bus: BUS_NAME }));

app.post("/api/preview", (req, res) => {
  const event = buildEvent(req.body || {});
  if (!event) return res.status(400).json({ errors: [`unknown flow '${(req.body || {}).flow}'`] });
  const errors = schemaErrors(event);
  res.status(errors.length ? 400 : 200).json({ event, entry: putEntry(event), errors });
});

app.post("/api/send", async (req, res) => {
  const event = (req.body || {}).event || {};
  const errors = schemaErrors(event);
  if (errors.length) return res.status(400).json({ errors });
  try {
    const resp = await eventBridge.send(new PutEventsCommand({ Entries: [{ ...putEntry(event), Detail: JSON.stringify(event) }] }));
    const entry = resp.Entries[0];
    if (resp.FailedEntryCount) return res.status(502).json({ errors: [`${entry.ErrorCode}: ${entry.ErrorMessage}`] });
    res.json({ eventBridgeId: entry.EventId, bus: BUS_NAME });
  } catch (e) {
    res.status(502).json({ errors: [`${e.name}: ${e.message}`] }); // missing bus, permissions, …
  }
});

app.get("/api/result", async (req, res) => {
  try {
    const result = await runResult(String(req.query.eventId || ""));
    res.json(result ? { status: "done", ...result } : { status: "pending" });
  } catch (e) {
    res.status(502).json({ errors: [`${e.name}: ${e.message}`] });
  }
});

app.listen(PORT, "127.0.0.1", () => console.log(`CPMS registration test app running at http://localhost:${PORT}`));
