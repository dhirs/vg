// Local test app for the send_to_cpms flow.
//
// Mirrors the real registration pages (event registration via EMO, new adviser account via
// CL6): on submit it builds the source_event that page's backend sends to CPMS,
// validates it against schemas/source_event.schema.json, puts it on
// the cpms-eventbus-consent EventBridge bus, and reads back what CPMS made of it (OneTrust
// requests / skipped / rejected) from the run's record in S3:
// cpms/{success,fail}/<eventId>/<run>.json.
//
// The browser never sees AWS credentials — they're read here from the repo-root .env.prod when
// it exists (local use), otherwise from environment variables (the server, via systemd); with no
// keys at all, the AWS SDK's default credential chain (e.g. AWS_PROFILE) is used.
// Server settings: PORT, HOST, COOKIE_SECURE=1 behind HTTPS, AUTH_USER + AUTH_PASSWORD for the
// login page (required behind HTTPS) — see INSTALL.md.
//
// Updating consent — neither page shows or edits settings; both identify the person, ask OneTrust
// for that person's magic link, and redirect to OneTrust's preference centre, where the change is
// made and recorded by OneTrust:
// - secure portal: sign in (simulated) -> link carrying the local ID -> CRM: local ID -> email
// - email link: Marketo email whose link carries the pre-encrypted lead ID (ref) -> decrypt ->
//   Marketo: lead ID -> email (and the lead's stored ref must match)
// then OneTrust: email -> link token -> magic link -> redirect. Marketo, the CRM and OneTrust are
// stubs (no API access yet); the redirect opens a local stand-in for OneTrust's preference centre.
// - email header (one-click): Gmail POSTs to the List-Unsubscribe URL (same ref) -> decrypt ->
//   Marketo: lead ID -> email -> a "withdrawn" source_event on the bus, like a registration. No page.
//
// Also: "Open questions", "OneTrust Connectors" and "Schematics" reference pages, read live from
// consent_fanout/ and each flow's diagrams/.
//
// Usage: cd send_to_cpms/web && npm install && npm start   ->   http://localhost:8600
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const PORT = Number(process.env.PORT) || 8600;
const HOST = process.env.HOST || "127.0.0.1"; // behind nginx: only reachable through the proxy
const COOKIE_FLAGS = `HttpOnly; SameSite=Lax; Path=/${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`;
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

// Email-link `ref`: the lead ID pre-encrypted with AES-256-GCM, stored on the Marketo lead as
// cpmsPrefRef and printed into the email link (design.md -> "The email link's ref").
// Format v<n>.<iv>.<ciphertext+tag>, base64url; additional data "cpms-pref-ref:v<n>" binds it
// to this purpose. The key file stands in for Secrets Manager cpms-secret-pref-ref-key
// (git-ignored, created on first use).
const REF_KEY_FILE = join(HERE, "data", "pref-ref-key.json");
const REF_VERSION = "v1";
function refKeys() {
  if (!existsSync(REF_KEY_FILE)) {
    mkdirSync(dirname(REF_KEY_FILE), { recursive: true });
    writeFileSync(REF_KEY_FILE, JSON.stringify({ [REF_VERSION]: randomBytes(32).toString("base64") }, null, 2));
  }
  return Object.fromEntries(Object.entries(JSON.parse(readFileSync(REF_KEY_FILE, "utf8"))).map(([v, k]) => [v, Buffer.from(k, "base64")]));
}
const refAad = (version) => Buffer.from(`cpms-pref-ref:${version}`);
function encryptRef(leadId) {
  const iv = randomBytes(12); // new for every encryption — never reused with the same key
  const cipher = createCipheriv("aes-256-gcm", refKeys()[REF_VERSION], iv);
  cipher.setAAD(refAad(REF_VERSION));
  const sealed = Buffer.concat([cipher.update(String(leadId), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${REF_VERSION}.${iv.toString("base64url")}.${sealed.toString("base64url")}`;
}
// -> { leadId, version } or null. Every failure is the same null: callers show one generic error.
function decryptRef(ref) {
  const m = /^(v\d+)\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22,200})$/.exec(String(ref || ""));
  if (!m || String(ref).length > 200) return null;
  const [, version, ivB64, sealedB64] = m;
  const key = refKeys()[version];
  if (!key) return null;
  const sealed = Buffer.from(sealedB64, "base64url");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAAD(refAad(version));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const leadId = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString("utf8");
    return /^\d+$/.test(leadId) ? { leadId: Number(leadId), version } : null;
  } catch {
    return null; // tag didn't verify: forged or edited
  }
}
const INVALID_LINK = "This link is invalid or has expired.";

// Stub Marketo: leads with email and cpmsPrefRef (git-ignored, like the stub CRM). Every CRM
// person is also a lead — registrations sync there — given the next lead ID the first time it's
// needed. Issuing cpmsPrefRef on creation stands in for the "Lead is Created" webhook to
// cpms-lambda-pref-ref-issue; leads without one get it on load (the one-off batch).
const MARKETO_FILE = join(HERE, "data", "stub-marketo.json");
const saveMarketo = (store) => { mkdirSync(dirname(MARKETO_FILE), { recursive: true }); writeFileSync(MARKETO_FILE, JSON.stringify(store, null, 2)); };
function loadMarketo() {
  const store = existsSync(MARKETO_FILE) ? JSON.parse(readFileSync(MARKETO_FILE, "utf8")) : { leads: [] };
  const missing = store.leads.filter((l) => !l.cpmsPrefRef);
  missing.forEach((l) => { l.cpmsPrefRef = encryptRef(l.leadId); });
  if (missing.length) saveMarketo(store);
  return store;
}
const marketo = {
  byLeadId: (leadId) => loadMarketo().leads.find((l) => String(l.leadId) === String(leadId)),
  leadFor(email) {
    const store = loadMarketo();
    let lead = store.leads.find((l) => l.email === email);
    if (!lead) {
      const leadId = Math.max(1000000, ...store.leads.map((l) => l.leadId)) + 1;
      lead = { leadId, email, cpmsPrefRef: encryptRef(leadId) };
      store.leads.push(lead);
      saveMarketo(store);
    }
    return lead;
  },
};
// The email link's ref -> the lead it was issued for, or null. Decrypts, then checks the lead's
// stored cpmsPrefRef is this one (issuing a new one revokes the old links).
function leadForRef(ref) {
  const opened = decryptRef(ref);
  const lead = opened && marketo.byLeadId(opened.leadId);
  return lead && lead.cpmsPrefRef === ref ? { lead, version: opened.version } : null;
}

// Stub OneTrust "Get Data Subject Token" (GET /rest/api/consent/v4/datasubjects/linktokens,
// header identifier: <email>): one link token per data subject, valid for a year. The token is
// appended to the preference centre URL to make the magic link. In memory — a restart issues new ones.
const LINK_TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;
const linkTokens = new Map(); // email -> { token, createdDate, expiryDate }
function oneTrustLinkToken(email) {
  const existing = linkTokens.get(email);
  if (existing && new Date(existing.expiryDate) > new Date()) return existing;
  const now = Date.now();
  const issued = { token: randomBytes(24).toString("base64"), createdDate: new Date(now).toISOString(), expiryDate: new Date(now + LINK_TOKEN_TTL_MS).toISOString() };
  linkTokens.set(email, issued);
  return issued;
}
const emailForLinkToken = (token) => [...linkTokens].find(([, t]) => t.token === token && new Date(t.expiryDate) > new Date())?.[0];
const LINK_TOKEN_REQUEST = (email) => `GET https://{hostname}/rest/api/consent/v4/datasubjects/linktokens · identifier: ${email}`;


function loadEnv(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

// .env.prod (if present) first, then real environment variables win — on the server there's no file.
// Region and bucket are required. Keys are optional: without them the AWS SDK's normal credential
// chain is used (AWS_PROFILE / SSO / environment), so a local install needs no stored keys.
const ENV_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION", "AWS_BUCKET_NAME", "AUTH_USER", "AUTH_PASSWORD"];
const env = { ...loadEnv(join(REPO_ROOT, ".env.prod")),
  ...Object.fromEntries(ENV_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
const missing = ["AWS_DEFAULT_REGION", "AWS_BUCKET_NAME"].filter((k) => !env[k]);
if (Boolean(env.AWS_ACCESS_KEY_ID) !== Boolean(env.AWS_SECRET_ACCESS_KEY)) missing.push("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (both or neither)");
// App login: on when AUTH_USER + AUTH_PASSWORD are set (.env.prod locally). Required behind
// HTTPS (the server), so the site can't end up public by accident; optional locally.
if (Boolean(env.AUTH_USER) !== Boolean(env.AUTH_PASSWORD)) missing.push("AUTH_USER + AUTH_PASSWORD (both or neither)");
else if (process.env.COOKIE_SECURE === "1" && !env.AUTH_USER) missing.push("AUTH_USER + AUTH_PASSWORD (required on the server — see INSTALL.md)");
if (missing.length) {
  console.error(`Missing settings: ${missing.join(", ")} — set them in .env.prod (local) or the environment (server).`);
  process.exit(1);
}
const awsConfig = {
  region: env.AWS_DEFAULT_REGION,
  ...(env.AWS_ACCESS_KEY_ID && { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }),
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = (req, name) => (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];
const sessionOf = (req) => sessions.get(cookie(req, "cpms_session"));

// --- App login (replaces nginx basic auth, which corporate browsers and proxies often block).
// One user + password from the settings. The session is a signed cookie (user + expiry + HMAC),
// so restarts don't log anyone out; its key is derived from the password, so changing the
// password logs everyone out.
const AUTH = env.AUTH_USER ? { user: env.AUTH_USER, password: env.AUTH_PASSWORD } : null;
const AUTH_COOKIE = "cpms_auth";
const AUTH_TTL_MS = 7 * 24 * 3600 * 1000;
const AUTH_PUBLIC = new Set(["/login.html", "/styles.css", "/vanguard-logo.svg", "/api/auth/login", "/api/auth/me"]);
const authKey = AUTH && createHash("sha256").update(`cpms-auth-cookie:${AUTH.password}`).digest();
const sign = (payload) => createHmac("sha256", authKey).update(payload).digest("base64url");
function authCookie(user) {
  const payload = `${Buffer.from(user).toString("base64url")}.${Date.now() + AUTH_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}
function authedUser(req) {
  const [user, expires, mac] = String(cookie(req, AUTH_COOKIE) || "").split(".");
  if (!mac || Number(expires) < Date.now()) return null;
  const expected = Buffer.from(sign(`${user}.${expires}`));
  if (expected.length !== Buffer.from(mac).length || !timingSafeEqual(expected, Buffer.from(mac))) return null;
  return Buffer.from(user, "base64url").toString("utf8");
}
// Compared as SHA-256 digests so the comparison is constant-time whatever the lengths.
const digest = (s) => createHash("sha256").update(String(s)).digest();
const passwordMatches = (password) => timingSafeEqual(digest(password), digest(AUTH.password));
// Failed logins per client IP (nginx passes it in X-Real-IP): 10 per 15 minutes, then 429.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // ip -> { count, since }
const clientIp = (req) => req.headers["x-real-ip"] || req.socket.remoteAddress;

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/api/auth/me", (req, res) => res.json({ enabled: Boolean(AUTH), user: AUTH ? authedUser(req) : null }));

app.post("/api/auth/login", (req, res) => {
  if (!AUTH) return res.json({ user: null });
  const ip = clientIp(req);
  const failures = loginFailures.get(ip);
  if (failures && Date.now() - failures.since > LOGIN_WINDOW_MS) loginFailures.delete(ip);
  if ((loginFailures.get(ip)?.count || 0) >= 10) return res.status(429).json({ errors: ["Too many attempts. Try again in 15 minutes."] });
  const { user, password } = req.body || {};
  const ok = String(user || "") === AUTH.user && passwordMatches(password);
  if (!ok) {
    const f = loginFailures.get(ip) || { count: 0, since: Date.now() };
    loginFailures.set(ip, { ...f, count: f.count + 1 });
    return res.status(401).json({ errors: ["Wrong username or password."] });
  }
  loginFailures.delete(ip);
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=${authCookie(AUTH.user)}; ${COOKIE_FLAGS}; Max-Age=${AUTH_TTL_MS / 1000}`);
  res.json({ user: AUTH.user });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0`);
  res.json({ user: null });
});

// Everything else needs the login: pages redirect to it, API calls get 401.
app.use((req, res, next) => {
  if (!AUTH || AUTH_PUBLIC.has(req.path) || authedUser(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ errors: ["Sign in first."] });
  res.redirect(302, "/login.html");
});

app.use(express.static(join(HERE, "public")));

app.get("/api/config", (req, res) => res.json({ event: EVENT, firmSizes: FIRM_SIZES, companyTypes: COMPANY_TYPES, bus: BUS_NAME }));

app.post("/api/preview", (req, res) => {
  const body = req.body || {};
  const event = buildEvent(body);
  if (!event) return res.status(400).json({ errors: [`unknown flow '${(req.body || {}).flow}'`] });
  const errors = schemaErrors(event);
  res.status(errors.length ? 400 : 200).json({ event, entry: putEntry(event), errors });
});

app.post("/api/send", async (req, res) => {
  const { event = {}, profile = {} } = req.body || {};
  const errors = schemaErrors(event);
  if (errors.length) return res.status(400).json({ errors });
  try {
    const resp = await eventBridge.send(new PutEventsCommand({ Entries: [{ ...putEntry(event), Detail: JSON.stringify(event) }] }));
    const entry = resp.Entries[0];
    if (resp.FailedEntryCount) return res.status(502).json({ errors: [`${entry.ErrorCode}: ${entry.ErrorMessage}`] });
    // a registration creates the person in the stub CRM, so they can sign in to the secure portal
    const user = crm.add({
      email: event.subject.identifierValue,
      firstName: String(profile.firstName || "").trim(), lastName: String(profile.lastName || "").trim(), company: String(profile.company || "").trim(),
    });
    marketo.leadFor(user.email); // and syncs to Marketo as a lead, so marketing email can reach them
    res.json({ eventBridgeId: entry.EventId, bus: BUS_NAME, crmLocalId: user.localId });
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

// --- Secure portal (simulated sign-in, stub CRM)
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
  res.setHeader("Set-Cookie", `cpms_session=${id}; ${COOKIE_FLAGS}`);
  res.json({ signedIn: true, user: { name: displayName(user), localId: user.localId } });
});

app.post("/api/logout", (req, res) => {
  sessions.delete(cookie(req, "cpms_session"));
  res.setHeader("Set-Cookie", `cpms_session=; ${COOKIE_FLAGS}; Max-Age=0`);
  res.json({ signedIn: false });
});

// --- Email link (Marketo): a sample marketing email whose link carries the lead's pre-encrypted
// lead ID ({{lead.cpmsPrefRef}}), as Marketo sends it. The recipient list stands in for the audience.
app.get("/api/email/recipients", (req, res) => {
  res.json({ recipients: loadCrm().users.map((u) => ({ leadId: marketo.leadFor(u.email).leadId, name: displayName(u), email: u.email })) });
});

app.get("/api/email/message", (req, res) => {
  const lead = marketo.byLeadId(String(req.query.leadId || ""));
  const user = lead && crm.byEmail(lead.email);
  if (!lead) return res.status(404).json({ errors: ["No such recipient."] });
  res.json({
    from: "Vanguard Adviser Insights <insights@vanguard.example>",
    to: user ? `${displayName(user)} <${lead.email}>` : lead.email,
    subject: "Markets this week: what the Autumn Budget means for your clients",
    ref: lead.cpmsPrefRef,
    headers: listUnsubscribe(lead.cpmsPrefRef),
  });
});

// --- Marketo endpoint (/marketo/preferences): the email link points here, so everything under it
// knows the ref is a Marketo pre-encrypted lead ID — no "source" parameter.
const MARKETO_ENDPOINT = "/api/marketo/preferences";

// Step 1: validate and decrypt the ref (no lookup yet).
app.get(`${MARKETO_ENDPOINT}/decrypt`, async (req, res) => {
  await sleep(300);
  const opened = decryptRef(req.query.ref);
  if (!opened) return res.status(400).json({ errors: [INVALID_LINK] });
  res.json({ leadId: opened.leadId, version: opened.version, request: `AES-256-GCM decrypt · key ${opened.version} (cpms-secret-pref-ref-key)` });
});

// Step 2 — stub Marketo "Get Lead by Id": email, and the stored cpmsPrefRef must match the link.
app.get(`${MARKETO_ENDPOINT}/lead`, async (req, res) => {
  await sleep(600); // feels like a network call
  const found = leadForRef(req.query.ref);
  if (!found) return res.status(400).json({ errors: [INVALID_LINK] });
  const { lead } = found;
  res.json({ leadId: lead.leadId, email: lead.email, request: `GET https://{munchkin-id}.mktorest.com/rest/v1/lead/${lead.leadId}.json?fields=email,cpmsPrefRef` });
});

// Step 3: OneTrust magic link for the lead whose ref is in the link — the ref, never a bare lead ID.
app.get(`${MARKETO_ENDPOINT}/magiclink`, async (req, res) => {
  const email = leadForRef(req.query.ref)?.lead.email;
  if (!email) return res.status(400).json({ errors: [INVALID_LINK] });
  res.json(await magicLink(email));
});

// --- One-click unsubscribe (RFC 8058): the email's List-Unsubscribe header points here. The mailbox
// provider (Gmail) POSTs "List-Unsubscribe=One-Click" from its own servers — no browser, no page —
// so this does the whole opt-out and answers straight away. Stands in for API Gateway +
// cpms-lambda-oneclick-unsub. The ref is the same {{lead.cpmsPrefRef}} as the body link.
const ONECLICK_ENDPOINT = "/api/marketo/unsubscribe";
const ONECLICK_PURPOSE = "marketing_communications"; // what the header unsubscribes from (assumption)
const listUnsubscribe = (ref) => ({
  "List-Unsubscribe": `<https://<cpms-host>/marketo/unsubscribe?ref=${ref}>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
});

app.post(ONECLICK_ENDPOINT, express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
  if ((req.body || {})["List-Unsubscribe"] !== "One-Click") return res.status(400).json({ errors: ["Not a one-click unsubscribe request."] });
  const found = leadForRef(req.query.ref);
  if (!found) return res.status(400).json({ errors: [INVALID_LINK] });
  const { lead } = found;
  const now = isoNow();
  const event = {
    schemaVersion: "1.0",
    eventId: randomUUID(),
    eventType: "email_unsubscribe",
    sourceSystem: "email_oneclick",
    occurredAt: now,
    subject: { identifierType: "email", identifierValue: lead.email },
    consent: [{ purpose: ONECLICK_PURPOSE, status: "withdrawn", capturedAt: now, captureMethod: "list_unsubscribe_one_click" }],
    provenance: { sourceEventId: `oneclick-${randomUUID().slice(0, 12)}`, captureChannel: "email", policyVersion: POLICY_VERSION },
  };
  const errors = schemaErrors(event);
  if (errors.length) return res.status(500).json({ errors });
  try {
    const resp = await eventBridge.send(new PutEventsCommand({ Entries: [{ ...putEntry(event), Detail: JSON.stringify(event) }] }));
    const entry = resp.Entries[0];
    if (resp.FailedEntryCount) return res.status(502).json({ errors: [`${entry.ErrorCode}: ${entry.ErrorMessage}`] });
    res.json({ leadId: lead.leadId, email: lead.email, event, eventBridgeId: entry.EventId, bus: BUS_NAME,
      request: `POST https://<cpms-host>/marketo/unsubscribe?ref=${req.query.ref} · List-Unsubscribe=One-Click` });
  } catch (e) {
    res.status(502).json({ errors: [`${e.name}: ${e.message}`] });
  }
});

// --- Website endpoint (/website/preferences): the signed-in Vanguard 365 user's own preferences.
const WEBSITE_ENDPOINT = "/api/website/preferences";

// Step 1–2 — session check + stub CRM: local ID -> email. Only for the signed-in user's own local
// ID — the link alone must not reveal anyone else's details.
app.get(`${WEBSITE_ENDPOINT}/subject`, async (req, res) => {
  const session = sessionOf(req);
  if (!session) return res.status(401).json({ errors: ["Sign in first."] });
  const localId = String(req.query.localId || "");
  if (localId !== session.localId) return res.status(403).json({ errors: ["This link belongs to a different user."] });
  await sleep(600);
  const record = crm.byLocalId(localId);
  if (!record) return res.status(404).json({ errors: [`CRM has no record for ${localId}.`] });
  res.json({ localId, email: record.email, request: `CRM lookup · local ID ${localId} → email` });
});

// Step 3: OneTrust magic link for the signed-in user (email from their CRM record, never the browser).
app.get(`${WEBSITE_ENDPOINT}/magiclink`, async (req, res) => {
  const session = sessionOf(req);
  if (!session) return res.status(401).json({ errors: ["Sign in first."] });
  if (String(req.query.localId || "") !== session.localId) return res.status(403).json({ errors: ["This link belongs to a different user."] });
  const email = crm.byLocalId(session.localId)?.email;
  if (!email) return res.status(404).json({ errors: ["Couldn't work out whose link this is."] });
  res.json(await magicLink(email));
});

// Stub OneTrust "Get Data Subject Token" for an email the endpoint has already worked out.
async function magicLink(email) {
  await sleep(500);
  const issued = oneTrustLinkToken(email);
  return { email, ...issued, request: LINK_TOKEN_REQUEST(email),
    // the stand-in for OneTrust's hosted preference centre (a real tenant URL replaces this)
    url: `#/onetrust?token=${encodeURIComponent(issued.token)}`, standIn: true };
}

// Stand-in OneTrust preference centre: which person a magic link opens.
app.get("/api/onetrust/preference-centre", (req, res) => {
  const token = String(req.query.token || "");
  const email = emailForLinkToken(token);
  if (!email) return res.status(404).json({ errors: ["This link is invalid or has expired."] });
  res.json({ email, expiryDate: linkTokens.get(email).expiryDate });
});

// --- Open questions: consent_fanout/<doc>.md shown one question at a time, with comments.
// The markdown file stays the source of truth; comments are kept next to it in
// consent_fanout/comments/<doc>.json, keyed by question number.
const QUESTIONS_DIR = join(HERE, "../../consent_fanout");
const QUESTION_DOCS = ["SFMC", "AEP", "Marketo"];
const commentsFile = (doc) => join(QUESTIONS_DIR, "comments", `${doc}.json`);

// --- Schematics: every <flow>/diagrams/*.drawio in the repo, found on each request so a new
// diagram shows up without code changes. The XML is drawn in the browser by the diagrams.net
// viewer, as diagrams/preview.py does.
// Known diagrams in pipeline order, with their sidebar names; any other diagram follows,
// named after its file.
const SCHEMATIC_ORDER = [
  { file: "send_to_cpms/diagrams/New_Consent_Record.drawio", label: "New_Consent_Record" },
  { file: "send_to_cpms/diagrams/Email_Consent_Update.drawio", label: "Email_Consent_Update" },
  { file: "send_to_cpms/diagrams/Email_OneClick_Unsubscribe.drawio", label: "Email_OneClick_Unsubscribe" },
  { file: "send_to_cpms/diagrams/Website_Consent_Update.drawio", label: "Website_Consent_Update" },
  { file: "send_to_cpms/diagrams/CPMS_Router.drawio", label: "CPMS_Router" },
  { file: "consent_fanout/diagrams/OT_to_SFMC.drawio", label: "OT to SFMC" },
  { file: "consent_fanout/diagrams/CPMS_Marketo_Bridge.drawio", label: "CPMS_Marketo_Bridge" },
];
const decodeEntities = (s) => s.replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
function schematics() {
  const found = [];
  for (const flow of readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (!flow.isDirectory() || flow.name.startsWith(".")) continue;
    const dir = join(REPO_ROOT, flow.name, "diagrams");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".drawio")).sort()) {
      const xml = readFileSync(join(dir, file), "utf8");
      // the diagram's own title cell, e.g. "send_to_cpms — source triggers → OneTrust"
      const raw = xml.match(/id="title"[^>]*\svalue="([^"]*)"/)?.[1] || "";
      const title = decodeEntities(decodeEntities(raw)).replace(/<[^>]+>/g, "").trim();
      const path = `${flow.name}/diagrams/${file}`;
      found.push({ id: `${flow.name}--${file.replace(/\.drawio$/, "")}`, flow: flow.name,
        name: SCHEMATIC_ORDER.find((k) => k.file === path)?.label || file.replace(/\.drawio$/, ""),
        file: path, title: title || file, xml });
    }
  }
  const rank = (s) => { const i = SCHEMATIC_ORDER.findIndex((k) => k.file === s.file); return i < 0 ? SCHEMATIC_ORDER.length : i; };
  return found.sort((a, b) => rank(a) - rank(b));
}

app.get("/api/schematics", (req, res) => {
  res.json({ schematics: schematics().map(({ xml, ...rest }) => rest) });
});

app.get("/api/schematics/:id", (req, res) => {
  const found = schematics().find((s) => s.id === req.params.id);
  if (!found) return res.status(404).json({ errors: [`No diagram "${req.params.id}".`] });
  res.json(found);
});

// --- CPMS Key Components: reference pages (page id -> file, or a section of one).
// A page is a whole file, or one "## " section of a file (so a design doc stays the only copy),
// optionally leaving out "### " subsections whose heading starts with a name in `omit`.
const ROUTER_DOCS = {
  "magic-links": { file: "send_to_cpms/docs/onetrust_magic_links.md" },
  "cpms-router": { file: "send_to_cpms/docs/cpms_router.md" },
  "marketo-bridge": { file: "consent_fanout/design.md", section: "CPMS_Marketo_Bridge", omit: ["Components"] },
};
app.get("/api/router-docs/:doc", (req, res) => {
  const page = ROUTER_DOCS[req.params.doc];
  if (!page) return res.status(404).json({ errors: [`No CPMS Router page "${req.params.doc}".`] });
  const lines = readFileSync(join(REPO_ROOT, page.file), "utf8").split("\n");
  let title, body;
  if (page.section) {
    const start = lines.findIndex((l) => l.startsWith(`## ${page.section}`));
    if (start < 0) return res.status(404).json({ errors: [`No "${page.section}" section in ${page.file}.`] });
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    title = lines[start].replace(/^##\s+/, "");
    body = lines.slice(start + 1, end < 0 ? undefined : end);
    let skipping = false;
    body = body.filter((l) => {
      if (l.startsWith("### ")) skipping = (page.omit || []).some((name) => l.slice(4).startsWith(name));
      return !skipping;
    }).map((l) => l.replace(/^###(?= )/, "##"));
  } else {
    title = lines[0].replace(/^#\s+/, "");
    body = lines.slice(1);
  }
  res.json({ title, markdown: body.join("\n").trim(), file: page.section ? `${page.file} → ${page.section}` : page.file });
});

// --- OneTrust Connectors: consent_fanout/connectors/<doc>.md shown as a reference page.
const CONNECTOR_DOCS = ["AEP"];
app.get("/api/connectors/:doc", (req, res) => {
  if (!CONNECTOR_DOCS.includes(req.params.doc)) return res.status(404).json({ errors: [`No connector page "${req.params.doc}".`] });
  const [first, ...rest] = readFileSync(join(QUESTIONS_DIR, "connectors", `${req.params.doc}.md`), "utf8").split("\n");
  res.json({ title: first.replace(/^#\s+/, ""), markdown: rest.join("\n").trim() });
});

function parseQuestions(doc) {
  const lines = readFileSync(join(QUESTIONS_DIR, `${doc}.md`), "utf8").split("\n");
  const out = { title: "", intro: [], sections: [], questions: [] };
  let section = null, group = null, question = null;
  for (const line of lines) {
    if (line.startsWith("# ")) { out.title = line.slice(2).trim(); continue; }
    if (line.startsWith("## ")) {
      question = null;
      section = { title: line.slice(3).trim(), lines: [] };
      if (section.title !== "Questions") out.sections.push(section);
      continue;
    }
    if (!section) { out.intro.push(line); continue; }
    if (section.title !== "Questions") { section.lines.push(line); continue; }
    if (line.startsWith("### ")) { question = null; group = line.slice(4).trim(); continue; }
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) {
      question = { n: Number(m[1]), group, lines: [m[2]] };
      out.questions.push(question);
    } else if (question) {
      question.lines.push(line);
    }
  }
  // A question's body is indented under its number; strip the body's own common indent
  // (not the number's width — "9." can sit on text indented for "13." after renumbering).
  const dedent = ([first, ...rest]) => {
    const base = Math.min(...rest.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
    return [first, ...rest.map((l) => l.slice(Number.isFinite(base) ? base : 0))];
  };
  out.questions.forEach((q) => { q.lines = dedent(q.lines); });
  const text = (ls) => ls.join("\n").trim();
  return {
    title: out.title,
    intro: text(out.intro),
    sections: out.sections.map((s) => ({ title: s.title, markdown: text(s.lines) })),
    questions: out.questions.map((q) => ({ n: q.n, group: q.group, markdown: text(q.lines) })),
  };
}
const loadComments = (doc) => (existsSync(commentsFile(doc)) ? JSON.parse(readFileSync(commentsFile(doc), "utf8")) : { comments: [] });
function saveComments(doc, store) {
  mkdirSync(dirname(commentsFile(doc)), { recursive: true });
  writeFileSync(commentsFile(doc), JSON.stringify(store, null, 2) + "\n");
}
const questionDoc = (req, res) => {
  if (QUESTION_DOCS.includes(req.params.doc)) return req.params.doc;
  res.status(404).json({ errors: [`No open-questions file "${req.params.doc}".`] });
};

app.get("/api/questions/:doc", (req, res) => {
  const doc = questionDoc(req, res);
  if (doc) res.json({ ...parseQuestions(doc), comments: loadComments(doc).comments });
});

app.post("/api/questions/:doc/comments", (req, res) => {
  const doc = questionDoc(req, res);
  if (!doc) return;
  const { question, author, text } = req.body || {};
  const q = parseQuestions(doc).questions.find((x) => x.n === question);
  if (!q) return res.status(400).json({ errors: ["Unknown question."] });
  if (!String(text || "").trim()) return res.status(400).json({ errors: ["Write a comment first."] });
  const store = loadComments(doc);
  const comment = {
    id: randomUUID(), question,
    questionTitle: q.markdown.match(/\*\*(.+?)\*\*/)?.[1] || "", // so a comment still reads right if questions get renumbered
    author: String(author || "").trim().slice(0, 80) || "Anonymous",
    text: String(text).trim().slice(0, 4000),
    at: new Date().toISOString(),
  };
  store.comments.push(comment);
  saveComments(doc, store);
  res.json({ comments: store.comments });
});

app.delete("/api/questions/:doc/comments/:id", (req, res) => {
  const doc = questionDoc(req, res);
  if (!doc) return;
  const store = loadComments(doc);
  store.comments = store.comments.filter((c) => c.id !== req.params.id);
  saveComments(doc, store);
  res.json({ comments: store.comments });
});

app.listen(PORT, HOST, () => console.log(`CPMS registration test app running at http://${HOST}:${PORT}`));
