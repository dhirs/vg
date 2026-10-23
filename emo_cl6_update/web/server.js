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
// Third flow — preference centre for a signed-in user: sign in (simulated) -> link carrying
// the user's local ID -> CRM looks up the email (stub) -> OneTrust returns the subject's
// preferences (stand-in: rebuilt from CPMS's own S3 records, since there's no OneTrust
// connectivity yet) -> shown as editable settings -> only the *changes* are sent to CPMS as a
// preference_update from CL6.
//
// Usage: cd emo_cl6_update/web && npm install && npm start   ->   http://localhost:8600
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    purposes: ["marketing_communications", "event_communications"],
    captureMethod: "implied_by_registration",
  },
  account: {
    sourceSystem: "cl6",
    eventType: "account_registration",
    // marketing comes with account creation (accepting the T&Cs / IP agreement isn't a CPMS purpose)
    purposes: ["marketing_communications"],
    captureMethod: "implied_by_account_creation",
  },
};

// Preference centre edits: an existing person changing settings. Unlike a registration, a
// change *off* must be sent explicitly (withdrawn / opt_out) — otherwise the old "on" stands.
const UPDATE_FLOW = { sourceSystem: "cl6", eventType: "preference_update", captureMethod: "preference_centre" };
const CONSENT_STATUSES = ["granted", "withdrawn"];
const PREFERENCE_STATUSES = ["opt_in", "opt_out"];

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

// --- Preference centre stubs (no real user database, CRM or OneTrust read access yet)
// Stub CRM: a local JSON file (git-ignored — it holds email addresses). Every registration sent
// from the EMO or CL6 page adds its person if new; the real CRM replaces this later.
const CRM_FILE = join(HERE, "data", "stub-crm.json");
const DEMO_USER = { localId: "CL6-100234", email: "dheeraj.saxena@kwantsolutions.co.uk", firstName: "Dheeraj", lastName: "Saxena", company: "Kwant Solutions Ltd" };

function loadCrm() {
  if (!existsSync(CRM_FILE)) {
    mkdirSync(dirname(CRM_FILE), { recursive: true });
    writeFileSync(CRM_FILE, JSON.stringify({ users: [DEMO_USER] }, null, 2));
  }
  return JSON.parse(readFileSync(CRM_FILE, "utf8"));
}
const crm = {
  byEmail: (email) => loadCrm().users.find((u) => u.email === email),
  byLocalId: (localId) => loadCrm().users.find((u) => u.localId === localId),
  add(profile) {
    const store = loadCrm();
    const existing = store.users.find((u) => u.email === profile.email);
    if (existing) return existing;
    const next = Math.max(...store.users.map((u) => Number(u.localId.split("-")[1]))) + 1;
    const user = { localId: `CL6-${next}`, ...profile };
    store.users.push(user);
    writeFileSync(CRM_FILE, JSON.stringify(store, null, 2));
    return user;
  },
};
const sessions = new Map(); // session id -> { localId }
const TAXONOMY = JSON.parse(readFileSync(join(FLOW_DIR, "taxonomy/taxonomy.sample.json"), "utf8"));

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

// changes: { consent: [{purpose, status}], preferences: [{topic, channel, status}] } — only what changed.
function buildUpdateEvent(email, changes = {}) {
  const now = isoNow();
  const event = {
    schemaVersion: "1.0",
    eventId: randomUUID(),
    eventType: UPDATE_FLOW.eventType,
    sourceSystem: UPDATE_FLOW.sourceSystem,
    occurredAt: now,
    subject: { identifierType: "email", identifierValue: email },
    provenance: { sourceEventId: `${UPDATE_FLOW.sourceSystem}-${randomUUID().slice(0, 12)}`, captureChannel: "web", policyVersion: POLICY_VERSION },
  };
  const consent = (changes.consent || []).filter((c) => CONSENT_STATUSES.includes(c.status))
    .map((c) => ({ purpose: String(c.purpose), status: c.status, capturedAt: now, captureMethod: UPDATE_FLOW.captureMethod }));
  const preferences = (changes.preferences || []).filter((p) => PREFERENCE_STATUSES.includes(p.status))
    .map((p) => ({ topic: String(p.topic), channel: String(p.channel), status: p.status, capturedAt: now }));
  if (consent.length) event.consent = consent;
  if (preferences.length) event.preferences = preferences;
  return event;
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

// --- Preference centre: OneTrust stand-in built from CPMS records.
// The watermark (cpms/watermarks/<sha256(email)>.json) lists every item CPMS has sent for the
// person with the eventId of the latest decision; that event's success record holds its status.
// So: read the watermark, then one success record per distinct eventId — no scanning.
async function readJson(key) {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await obj.Body.transformToString());
  } catch (e) {
    if (e.name === "NoSuchKey") return null;
    throw e;
  }
}

async function latestSuccessRecord(eventId) {
  const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${PREFIX}/success/${recordId(eventId)}/` }));
  const latest = (resp.Contents || []).sort((a, b) => b.LastModified - a.LastModified)[0];
  return latest ? readJson(latest.Key) : null;
}

const describe = (kind, code) => (TAXONOMY[kind].find((e) => e.code === code) || {}).description || code;
const inTaxonomy = (kind, code) => TAXONOMY[kind].some((e) => e.code === code);

async function subjectPreferences(email) {
  const watermarkKey = `${PREFIX}/watermarks/${createHash("sha256").update(email).digest("hex")}.json`;
  const marks = (await readJson(watermarkKey)) || {};
  const records = new Map();
  for (const { eventId } of Object.values(marks)) {
    if (!records.has(eventId)) records.set(eventId, await latestSuccessRecord(eventId));
  }
  const purposes = [], preferences = [];
  for (const [item, mark] of Object.entries(marks)) {
    const state = records.get(mark.eventId);
    const canonical = state?.canonical?.record || {};
    const origin = { capturedAt: mark.capturedAt, eventId: mark.eventId, sourceSystem: canonical.header?.sourceSystem, eventType: canonical.header?.eventType };
    const [kind, a, b] = item.split("#");
    // records can mention codes since removed from the taxonomy — they're no longer settings
    if (kind === "purpose" && !inTaxonomy("purposeCodes", a)) continue;
    if (kind === "pref" && !inTaxonomy("topicCodes", a)) continue;
    if (kind === "purpose") {
      const c = (canonical.consent || []).find((x) => x.purposeCode === a && x.capturedAt === mark.capturedAt);
      purposes.push({ purposeCode: a, label: describe("purposeCodes", a), status: c?.status ?? "unknown", legalBasis: c?.legalBasis, captureMethod: c?.captureMethod, ...origin });
    } else if (kind === "pref") {
      const p = (canonical.preferences || []).find((x) => x.topicCode === a && x.channel === b && x.capturedAt === mark.capturedAt);
      preferences.push({ topicCode: a, label: describe("topicCodes", a), channel: b, status: p?.status ?? "unknown", ...origin });
    }
  }
  return { email, source: "CPMS records (stand-in for OneTrust)", watermark: `s3://${BUCKET}/${watermarkKey}`, purposes, preferences };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = (req, name) => (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];
const sessionOf = (req) => sessions.get(cookie(req, "cpms_session"));

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(join(HERE, "public")));

app.get("/api/config", (req, res) => res.json({
  event: EVENT, firmSizes: FIRM_SIZES, companyTypes: COMPANY_TYPES, bus: BUS_NAME,
  taxonomy: {
    purposes: TAXONOMY.purposeCodes.map(({ code, description, legalBasis }) => ({ code, description, legalBasis })),
    topics: TAXONOMY.topicCodes.map(({ code, description, purposeCode }) => ({ code, description, purposeCode })),
    channels: TAXONOMY.channels.map(({ code }) => code),
  },
}));

app.post("/api/preview", (req, res) => {
  const body = req.body || {};
  if (body.flow === "update") {
    // the subject always comes from the session, never from the browser
    const session = sessionOf(req);
    if (!session) return res.status(401).json({ errors: ["Sign in first."] });
    const event = buildUpdateEvent(crm.byLocalId(session.localId).email, body.changes);
    const errors = event.consent || event.preferences ? schemaErrors(event) : ["No changes to send."];
    return res.status(errors.length ? 400 : 200).json({ event, entry: putEntry(event), errors });
  }
  const event = buildEvent(body);
  if (!event) return res.status(400).json({ errors: [`unknown flow '${(req.body || {}).flow}'`] });
  const errors = schemaErrors(event);
  res.status(errors.length ? 400 : 200).json({ event, entry: putEntry(event), errors });
});

app.post("/api/send", async (req, res) => {
  const { event = {}, profile = {} } = req.body || {};
  const errors = schemaErrors(event);
  if (errors.length) return res.status(400).json({ errors });
  if (event.eventType === UPDATE_FLOW.eventType) {
    // a preference change may only be sent for the signed-in user
    const session = sessionOf(req);
    if (!session || event.subject.identifierValue !== crm.byLocalId(session.localId)?.email) {
      return res.status(403).json({ errors: ["You can only change your own preferences."] });
    }
  }
  try {
    const resp = await eventBridge.send(new PutEventsCommand({ Entries: [{ ...putEntry(event), Detail: JSON.stringify(event) }] }));
    const entry = resp.Entries[0];
    if (resp.FailedEntryCount) return res.status(502).json({ errors: [`${entry.ErrorCode}: ${entry.ErrorMessage}`] });
    // a registration creates the person in the stub CRM, so they can sign in to the preference centre
    const user = event.eventType === UPDATE_FLOW.eventType ? null : crm.add({
      email: event.subject.identifierValue,
      firstName: String(profile.firstName || "").trim(), lastName: String(profile.lastName || "").trim(), company: String(profile.company || "").trim(),
    });
    res.json({ eventBridgeId: entry.EventId, bus: BUS_NAME, ...(user && { crmLocalId: user.localId }) });
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

// --- Preference centre (simulated sign-in, stub CRM, OneTrust stand-in)
const displayName = (u) => [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;

app.get("/api/session", (req, res) => {
  const user = sessionOf(req) && crm.byLocalId(sessionOf(req).localId);
  if (!user) return res.json({ signedIn: false, demo: { email: DEMO_USER.email } });
  res.json({ signedIn: true, user: { name: displayName(user), localId: user.localId } });
});

// Simulated sign-in: an email that's in the stub CRM is enough (no password).
app.post("/api/login", (req, res) => {
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const user = crm.byEmail(email);
  if (!user) return res.status(401).json({ errors: [`No account found for ${email || "that email"}. Register on the event or account page first.`] });
  const id = randomUUID();
  sessions.set(id, { localId: user.localId });
  res.setHeader("Set-Cookie", `cpms_session=${id}; HttpOnly; SameSite=Lax; Path=/`);
  res.json({ signedIn: true, user: { name: displayName(user), localId: user.localId } });
});

app.post("/api/logout", (req, res) => {
  sessions.delete(cookie(req, "cpms_session"));
  res.setHeader("Set-Cookie", "cpms_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ signedIn: false });
});

// Stub CRM: local ID -> email. Only for the signed-in user's own local ID — the link alone
// must not reveal anyone else's details.
app.get("/api/crm/subject", async (req, res) => {
  const session = sessionOf(req);
  if (!session) return res.status(401).json({ errors: ["Sign in first."] });
  const localId = String(req.query.localId || "");
  if (localId !== session.localId) return res.status(403).json({ errors: ["This link belongs to a different user."] });
  await sleep(600); // feels like a network call
  const record = crm.byLocalId(localId);
  if (!record) return res.status(404).json({ errors: [`CRM has no record for ${localId}.`] });
  res.json({ localId, email: record.email, company: record.company });
});

// OneTrust "get preferences" stand-in. Same ownership check: only the signed-in user's own email.
app.get("/api/onetrust/preferences", async (req, res) => {
  const session = sessionOf(req);
  if (!session) return res.status(401).json({ errors: ["Sign in first."] });
  const email = String(req.query.email || "");
  if (email !== crm.byLocalId(session.localId)?.email) return res.status(403).json({ errors: ["You can only view your own preferences."] });
  try {
    await sleep(400);
    res.json(await subjectPreferences(email));
  } catch (e) {
    res.status(502).json({ errors: [`${e.name}: ${e.message}`] });
  }
});

app.listen(PORT, "127.0.0.1", () => console.log(`CPMS registration test app running at http://localhost:${PORT}`));
