// Two registration flows (event via EMO, new adviser account via CL6), each:
// two-step form -> source_event preview -> send to CPMS -> what CPMS generated for OneTrust.
// Plus two ways to update consent, both ending in OneTrust's preference centre via a magic link:
// secure portal (sign in -> local ID -> CRM -> email) and email link (encrypted lead ID -> decrypt -> Marketo -> email).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const FLOWS = ["event", "account"];
const SOURCE_LABEL = { event: "EMO", account: "CL6" };

// Per-flow state, so switching flows keeps each one's last send and result.
const state = Object.fromEntries(FLOWS.map((f) => [f, { sent: null, result: null, status: "idle", error: null, pollToken: 0 }]));
let flow = "event";
let tab = "form";
let pending = null; // { flow, event } shown in the modal

function highlight(text) {
  return esc(text).replace(/("(\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?/g, (m, str, _, colon, bool) =>
    str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`)
        : bool ? `<span class="b">${m}</span>` : `<span class="n">${m}</span>`);
}
const json = (o) => highlight(JSON.stringify(o, null, 2));

// ---------- page content
async function loadConfig() {
  const { event, firmSizes, companyTypes } = await (await fetch("/api/config")).json();
  $("ev-title").textContent = event.title;
  $("ev-format").textContent = event.format;
  $("ev-date").textContent = event.date;
  $("ev-time").textContent = event.time;
  $("ev-cpd").textContent = event.cpd;
  $("ev-form-title").textContent = `Register to ${event.title}`;
  $("ev-presenters").innerHTML = event.presenters.map((p) => {
    const initials = p.name.split(" ").map((w) => w[0]).join("").slice(0, 2);
    return `<li><span class="avatar">${esc(initials)}</span><span>${esc(p.name)}<small>${esc(p.role)}</small></span></li>`;
  }).join("");
  $("firm-sizes").innerHTML = firmSizes.map((s) =>
    `<label class="chip"><input type="radio" name="firmSize" value="${esc(s)}"><span>${esc(s)}</span></label>`).join("");
  $("company-types").innerHTML = companyTypes.map((c) =>
    `<label class="option"><input type="radio" name="companyType" value="${esc(c.value)}"><span class="radio" aria-hidden="true"></span>
       <span><b>${esc(c.label)}</b><small>${esc(c.description)}</small></span></label>`).join("");
}

// ---------- routing: #/event, #/account, #/unsubscribe[?ref=…], #/preferences[?localId=…], #/onetrust?token=…,
// #/questions/<doc>, #/connectors/<doc>, #/schematics/<id>
const PAGES = [...FLOWS, "unsubscribe", "preferences", "onetrust", "questions", "connectors", "schematics"];
function route() {
  const [path, query = ""] = location.hash.replace(/^#\//, "").split("?");
  const [page, doc] = path.split("/");
  flow = PAGES.includes(page) ? page : "event";
  document.querySelectorAll("[data-flow]").forEach((el) => {
    const flows = el.dataset.flow.split(" ");
    if (el.classList.contains("side-link")) el.classList.toggle("active", flows.includes(flow) && (!el.dataset.doc || el.dataset.doc === doc));
    else el.hidden = !flows.includes(flow);
  });
  // a collapsed sidebar section opens when you're on one of its pages, so the active link shows
  document.querySelector(".side-link.active")?.closest("details.side-group")?.setAttribute("open", "");
  if (flow === "questions") return openQuestions(doc);
  if (flow === "connectors") return openConnector(doc);
  if (flow === "schematics") return openSchematic(doc);
  const params = new URLSearchParams(query);
  if (flow === "preferences") return preferenceCentre({ mode: "portal", localId: params.get("localId") });
  if (flow === "unsubscribe") return preferenceCentre({ mode: "unsubscribe", ref: params.get("ref") });
  if (flow === "onetrust") return oneTrustStandIn(params.get("token"));
  $("tab-form").textContent = flow === "event" ? "Register" : "Create account";
  showTab(tab);
}
window.addEventListener("hashchange", route);

// ---------- tabs
function showTab(name) {
  tab = name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  ["form", "sent", "onetrust"].forEach((n) => { $(`panel-${n}`).hidden = n !== name; });
  renderPanels();
}
document.querySelector(".tabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) showTab(t.dataset.tab); });

// ---------- forms (both flows share the same two-step mechanics)
const card = (f) => document.querySelector(`.form-card[data-flow="${f}"]`);

function setStep(f, n) {
  const c = card(f);
  c.querySelectorAll("form.step").forEach((form) => { form.hidden = Number(form.dataset.step) !== n; });
  c.querySelectorAll(".stepper li").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
}

function fieldError(input, message) {
  const field = input.closest(".field");
  if (field) {
    field.classList.toggle("invalid", !!message);
    field.querySelector(".error").textContent = message || "";
  }
}

function validate(form) {
  let firstBad = null;
  const fail = (el, msg) => { if (!firstBad) firstBad = el; return msg; };
  form.querySelectorAll("input[required]:not([type=radio]):not([type=checkbox]), input[data-pattern]").forEach((input) => {
    const value = input.value.trim();
    let msg = "";
    if (input.required && !value) msg = fail(input, "Required.");
    else if (input.type === "email" && value && !input.checkValidity()) msg = fail(input, "Enter a valid email address.");
    else if (value && input.dataset.pattern && !new RegExp(input.dataset.pattern).test(value)) msg = fail(input, input.dataset.patternMsg);
    fieldError(input, msg);
  });
  form.querySelectorAll("fieldset[data-required]").forEach((fs) => {
    const chosen = fs.querySelector("input:checked");
    fs.querySelector(".error").textContent = chosen ? "" : "Please choose one.";
    if (!chosen && !firstBad) firstBad = fs.querySelector("input");
  });
  const confirm = form.querySelector('input[name="confirm"]');
  if (confirm) {
    form.querySelector('[data-error="confirm"]').textContent = confirm.checked ? "" : "Please tick to confirm before continuing.";
    if (!confirm.checked && !firstBad) firstBad = confirm;
  }
  if (firstBad) firstBad.focus();
  return !firstBad;
}

for (const f of FLOWS) {
  const c = card(f);
  const [step1, step2] = c.querySelectorAll("form.step");
  step1.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!validate(step1)) return;
    c.querySelector("[data-echo]").textContent = step1.email.value.trim();
    setStep(f, 2);
    step2.querySelector("input").focus();
  });
  c.querySelector(".back").addEventListener("click", () => setStep(f, 1));
  step2.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validate(step2)) return;
    // Only the consent goes to CPMS; the profile fields are for the source's other processes.
    const res = await fetch("/api/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow: f, email: step1.email.value, locale: navigator.language }),
    });
    const data = await res.json();
    // name + company go to the stub CRM (so the person can sign in to the preference centre), not to CPMS
    const profile = { firstName: step2.firstName.value, lastName: step2.lastName.value,
                      company: (step2.firmName || step2.companyName).value };
    pending = { flow: f, event: data.event, profile };
    $("modal-title").textContent = `Event ${SOURCE_LABEL[f]} will send to CPMS`;
    $("meta").textContent = data.entry ? `bus: ${data.entry.EventBusName} · source: ${data.entry.Source} · detail-type: ${data.entry.DetailType}` : "";
    $("payload").innerHTML = json(data.event);
    $("send").disabled = data.errors.length > 0;
    setStatus(data.errors.length ? `Fails source_event schema:\n${data.errors.join("\n")}` : "", data.errors.length ? "err" : "");
    openModal();
  });
}
document.addEventListener("click", (e) => { if (e.target.matches("a[data-noop]")) e.preventDefault(); });

// ---------- modal
function setStatus(text, kind = "") { $("status").textContent = text; $("status").className = `status ${kind}`; }
const openModal = () => $("overlay").classList.add("open");
const closeModal = () => $("overlay").classList.remove("open");
["close", "cancel"].forEach((id) => $(id).addEventListener("click", closeModal));
$("overlay").addEventListener("click", (e) => { if (e.target === $("overlay")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

$("send").addEventListener("click", async () => {
  const { flow: f, event, profile } = pending;
  $("send").disabled = true;
  setStatus("Sending…");
  try {
    const res = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, profile }) });
    const data = await res.json();
    if (res.ok) {
      closeModal(); setStatus(""); $("send").disabled = false;
      Object.assign(state[f], { sent: { event, ...data }, result: null, status: "processing", error: null });
      showTab("sent");
      pollResult(f, event.eventId);
      return;
    }
    setStatus(data.errors.join("\n"), "err");
  } catch (err) {
    setStatus(`Could not reach the local server: ${err.message}`, "err");
  }
  $("send").disabled = false;
});

// ---------- results
async function pollResult(f, eventId) {
  const s = state[f];
  const token = ++s.pollToken; // a newer send in this flow cancels the older poll
  const deadline = Date.now() + 90_000;
  const finish = (patch) => { if (token === s.pollToken) { Object.assign(s, patch); renderPanels(); } };
  renderPanels();
  while (token === s.pollToken && Date.now() < deadline) {
    try {
      const res = await fetch(`/api/result?eventId=${encodeURIComponent(eventId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error((data.errors || ["lookup failed"]).join("; "));
      if (data.status === "done") return finish({ result: data, status: data.outcome });
    } catch (err) {
      return finish({ status: "error", error: `Couldn't read the result: ${err.message}` });
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  finish({ status: "error", error: "No result after 90 seconds. Check the cpms-lambda-fifo-consumer logs and the ingestion DLQ." });
}

const droppedList = (dropped) =>
  `<ul class="list">${dropped.map((d) => `<li><code>${esc(d.item)}</code> captured ${esc(d.capturedAt)} — already sent ${esc(d.watermark)}</li>`).join("")}</ul>`;

function renderPanels() {
  if (!FLOWS.includes(flow)) return;
  const s = state[flow];
  const label = flow === "event" ? "Register for the event" : "Create an account";
  const badge = $("ot-badge");
  const labels = { processing: "processing", sent: "sent", skipped_stale: "skipped", rejected: "rejected", error: "error" };
  badge.hidden = s.status === "idle";
  badge.className = `badge ${s.status}`;
  badge.textContent = labels[s.status] || s.status;

  if (!s.sent) {
    $("sent-body").innerHTML = `<div class="empty">Nothing sent yet. ${label} and send it to CPMS.</div>`;
    $("ot-body").innerHTML = `<div class="empty">Nothing sent yet. Once something is sent, the OneTrust request CPMS generates from it appears here.</div>`;
    return;
  }
  const { event } = s.sent;
  $("sent-body").innerHTML = `
    <p class="meta-line"><span>Bus <code>${esc(s.sent.bus)}</code></span><span>EventBridge id <code>${esc(s.sent.eventBridgeId)}</code></span><span>eventId <code>${esc(event.eventId)}</code></span></p>
    ${s.sent.crmLocalId ? `<div class="callout info">Added to the stub CRM as <code>${esc(s.sent.crmLocalId)}</code> — sign in to the Preference centre with <b>${esc(event.subject.identifierValue)}</b> to manage these settings.</div>` : ""}
    <pre class="code">${json(event)}</pre>`;

  if (s.status === "processing") {
    $("ot-body").innerHTML = `<div class="callout warn"><span class="spinner"></span>CPMS is processing the event… usually a few seconds.</div>`;
  } else if (s.status === "error") {
    $("ot-body").innerHTML = `<div class="callout err">${esc(s.error)}</div>`;
  } else {
    $("ot-body").innerHTML = resultHtml(s.result);
  }
}

// What CPMS made of an event: OneTrust requests / skipped / rejected.
function resultHtml(r) {
  const record = r.record ? `<p class="meta-line"><span>Run record <code>${esc(r.record)}</code></span></p>` : "";
  if (r.outcome === "sent") {
    const n = r.requests.length;
    return `${record}
      <div class="callout ok">CPMS generated <b>${n}</b> OneTrust request${n === 1 ? "" : "s"} and queued ${n === 1 ? "it" : "them"} on <code>cpms-sqs-outbound.fifo</code> — exactly what the dispatcher will send.</div>
      ${r.warning ? `<div class="callout warn">Warning: ${esc(r.warning)}</div>` : ""}
      ${r.dropped.length ? `<p class="lead">Dropped as stale (something newer was already sent):</p>${droppedList(r.dropped)}` : ""}
      ${r.requests.map((q, i) => `
        <div class="receipt-title"><span>Request ${i + 1} of ${n}</span><small>interactionDate ${esc(q.body.interactionDate)}</small></div>
        <pre class="code">${json(q)}</pre>`).join("")}`;
  }
  if (r.outcome === "skipped_stale") {
    return `${record}
      <div class="callout info">Nothing was sent to OneTrust: every decision in this event is <b>not newer</b> than what CPMS already sent for this person.</div>
      ${droppedList(r.dropped)}`;
  }
  return `${record}
    <div class="callout err">CPMS rejected this event at step <b>${esc(r.failedStep)}</b> — nothing was sent to OneTrust.</div>
    <ul class="list">${(r.errors || []).map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>`;
}

async function waitForResult(eventId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`/api/result?eventId=${encodeURIComponent(eventId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error((data.errors || ["lookup failed"]).join("; "));
    if (data.status === "done") return data;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("No result after 90 seconds. Check the cpms-lambda-fifo-consumer logs and the ingestion DLQ.");
}

// ---------- updating consent: secure portal (signed in) and email link (pre-encrypted lead ID)
// Neither page shows or edits settings: both work out who the person is, ask OneTrust for that
// person's magic link, and redirect to OneTrust's preference centre, where the change is made
// and recorded by OneTrust itself.
const MAGIC_STEPS = [
  { key: "magic", title: "OneTrust magic link", hint: "email → link token" },
  { key: "redirect", title: "Redirect", hint: "to OneTrust's preference centre" },
];
const STEPS = {
  portal: [
    { key: "signin", title: "Signed in", hint: "Vanguard 365 session" },
    { key: "link", title: "Preference link", hint: "carries your local ID" },
    { key: "crm", title: "CRM lookup", hint: "local ID → email" },
    ...MAGIC_STEPS,
  ],
  unsubscribe: [
    { key: "email", title: "Marketing email", hint: "sent by Marketo" },
    { key: "link", title: "Preferences link", hint: "carries the encrypted lead ID" },
    { key: "decrypt", title: "Decrypt", hint: "ref → lead ID" },
    { key: "marketo", title: "Marketo lookup", hint: "lead ID → email" },
    ...MAGIC_STEPS,
  ],
};
const REDIRECT_DELAY_MS = 4000; // long enough to see what happened before the page moves on
// One endpoint per way in: the path says where the request came from, so no "source" parameter.
const MARKETO_ENDPOINT = "/api/marketo/preferences"; // the email link (a Marketo pre-encrypted lead ID)
const WEBSITE_ENDPOINT = "/api/website/preferences"; // the signed-in Vanguard 365 user
const pc = { run: 0, mode: "portal", status: {}, details: {}, mailTo: null };

function setProgress() {
  $("progress").innerHTML = STEPS[pc.mode].map((step, i) => {
    const st = pc.status[step.key] || "pending";
    const mark = st === "done" ? "✓" : st === "error" ? "!" : i + 1;
    return `<li class="${st}"><span class="dot">${st === "active" ? '<span class="spinner"></span>' : mark}</span>
      <span class="ptext"><b>${step.title}</b><small>${esc(pc.details[step.key] || step.hint)}</small></span></li>`;
  }).join("");
}

const API = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error((data.errors || ["request failed"]).join("; "));
  return data;
};
const waiting = (text) => `<div class="callout warn"><span class="spinner"></span>${esc(text)}</div>`;

async function preferenceCentre({ mode, localId, ref }) {
  const run = ++pc.run;
  const live = () => run === pc.run;
  Object.assign(pc, { mode, status: {}, details: {} });
  const step = (key, st, detail) => { pc.status[key] = st; if (detail) pc.details[key] = detail; if (live()) setProgress(); };
  const body = (html) => { if (live()) $("pc-body").innerHTML = html; };
  const fail = (key, err) => { step(key, "error", err.message); body(`<div class="callout err">${esc(err.message)}</div>`); };
  const ctx = { step, body, fail, live };
  $("signout").hidden = true;
  setProgress();

  if (mode === "unsubscribe") {
    // 1. the Marketo email; 2. its link with the encrypted lead ID; 3. decrypt; 4. Marketo: lead ID -> email
    if (!ref) {
      step("email", "active", "click the link in the email");
      try { return body(await emailHtml()); } catch (err) { return fail("email", err); }
    }
    step("email", "done", "link clicked");
    step("link", "done", `ref ${ref.slice(0, 14)}…`);
    step("decrypt", "active", "checking the link…");
    body(waiting("Checking your link…"));
    let opened, lead;
    try { opened = await API(`${MARKETO_ENDPOINT}/decrypt?ref=${encodeURIComponent(ref)}`); } catch (err) { return fail("decrypt", err); }
    if (!live()) return;
    step("decrypt", "done", `leadId ${opened.leadId} · key ${opened.version}`);
    step("marketo", "active", "asking Marketo…");
    body(waiting("Looking you up in Marketo…"));
    try { lead = await API(`${MARKETO_ENDPOINT}/lead?ref=${encodeURIComponent(ref)}`); } catch (err) { return fail("marketo", err); }
    if (!live()) return;
    step("marketo", "done", lead.email);
    return magicLinkAndRedirect(`${MARKETO_ENDPOINT}/magiclink?ref=${encodeURIComponent(ref)}`, { request: `${opened.request}  →  ${lead.request}` }, ctx);
  }

  // 1. signed in?
  step("signin", "active");
  const session = await API("/api/session");
  if (!live()) return;
  $("signout").hidden = !session.signedIn;
  if (!session.signedIn) {
    step("signin", "error", "not signed in");
    return body(signInForm(session.demo));
  }
  step("signin", "done", session.user.name);

  // 2. the link with the local ID
  if (!localId) {
    step("link", "active", "click the link below");
    return body(`
      <h3 class="pc-title">Manage your communication preferences</h3>
      <p class="lead">Use your personal link to see and change what you receive from us.</p>
      <a class="pc-link" href="#/preferences?localId=${encodeURIComponent(session.user.localId)}">
        <svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
        <span>Manage my preferences<small>…/preferences?localId=${esc(session.user.localId)}</small></span></a>`);
  }
  step("link", "done", `localId ${localId}`);

  // 3. CRM: local ID -> email
  step("crm", "active", "asking CRM…");
  body(waiting("Looking you up…"));
  let subject;
  try { subject = await API(`${WEBSITE_ENDPOINT}/subject?localId=${encodeURIComponent(localId)}`); } catch (err) { return fail("crm", err); }
  if (!live()) return;
  step("crm", "done", subject.email);
  return magicLinkAndRedirect(`${WEBSITE_ENDPOINT}/magiclink?localId=${encodeURIComponent(localId)}`, subject, ctx);
}

// 4. OneTrust: email -> link token -> magic link; 5. redirect to OneTrust's preference centre.
async function magicLinkAndRedirect(magicLinkUrl, lookup, { step, body, fail, live }) {
  step("magic", "active", "asking OneTrust…");
  body(waiting("Getting your preference centre link from OneTrust…"));
  let link;
  try { link = await API(magicLinkUrl); } catch (err) { return fail("magic", err); }
  if (!live()) return;
  step("magic", "done", `valid until ${new Date(link.expiryDate).toLocaleDateString()}`);
  step("redirect", "active", "redirecting…");
  body(`
    <div class="callout ok">Taking you to OneTrust's preference centre for <b>${esc(link.email)}</b>…</div>
    <ol class="calls">
      <li><span>Look up the email</span><code>${esc(lookup.request)}</code></li>
      <li><span>Get the magic link token</span><code>${esc(link.request)}</code></li>
      <li><span>Redirect</span><code>${esc(link.url)}</code></li>
    </ol>
    <div class="actions"><span class="hint">${link.standIn ? "No OneTrust tenant yet — the link opens a local stand-in for its preference centre." : ""}</span>
      <a class="btn primary" href="${esc(link.url)}">Go now</a></div>`);
  setTimeout(() => {
    if (!live()) return;
    step("redirect", "done", "opened OneTrust");
    location.href = link.url;
  }, REDIRECT_DELAY_MS);
}

function signInForm(demo) {
  return `
    <h3 class="pc-title">Sign in to Vanguard 365</h3>
    <p class="lead">You need to be signed in to manage your preferences.</p>
    <form id="signin" class="signin" novalidate>
      <label class="field"><span class="label">Email address</span><input name="email" type="email" autocomplete="username" value="${esc(demo.email)}"><span class="error"></span></label>
      <div class="actions"><span class="hint">Simulated sign-in: any email you've registered with.</span><button class="btn primary" type="submit">Sign in</button></div>
    </form>`;
}

// A marketing email as Marketo sends it: the link carries the lead's pre-encrypted lead ID ({{lead.cpmsPrefRef}}).
async function emailHtml() {
  const { recipients } = await API("/api/email/recipients");
  if (!recipients.some((r) => String(r.leadId) === String(pc.mailTo))) pc.mailTo = recipients[0]?.leadId;
  if (!pc.mailTo) return `<p class="empty">No one to email yet — register on the event or account page first.</p>`;
  const mail = await API(`/api/email/message?leadId=${encodeURIComponent(pc.mailTo)}`);
  const link = `#/unsubscribe?ref=${encodeURIComponent(mail.ref)}`;
  return `
    <h3 class="pc-title">Inbox</h3>
    <p class="lead">A marketing email sent by Marketo. Pick who received it, then click <b>Manage your preferences</b>.</p>
    <label class="field mail-to"><span class="label">Recipient</span>
      <select id="mail-to">${recipients.map((r) =>
        `<option value="${esc(r.leadId)}"${String(r.leadId) === String(pc.mailTo) ? " selected" : ""}>${esc(r.name)} · ${esc(r.email)}</option>`).join("")}</select></label>
    <article class="mail">
      <header class="mail-head">
        <div><b>From</b>${esc(mail.from)}</div>
        <div><b>To</b>${esc(mail.to)}</div>
        <div><b>Subject</b>${esc(mail.subject)}</div>
      </header>
      <div class="mail-body">
        <h4>Markets this week</h4>
        <p>The Autumn Budget brought changes to pension allowances and capital gains that will shape conversations with your clients over the coming months.</p>
        <p>Our investment strategy team has summarised what changed, what didn't, and the questions advisers are asking most. Join the briefing on 29 October for the full picture.</p>
      </div>
      <footer class="mail-foot">You're receiving this email because you registered with Vanguard.
        <a href="${link}">Manage your preferences</a>
        <span class="mail-link">https://&lt;cpms-host&gt;/marketo/preferences?ref={{lead.cpmsPrefRef}} → ref ${esc(mail.ref)}</span></footer>
    </article>`;
}

document.addEventListener("change", (e) => {
  if (e.target.id !== "mail-to") return;
  pc.mailTo = e.target.value;
  route();
});

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "signin") return;
  e.preventDefault();
  const form = e.target;
  try {
    await API("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.email.value }) });
    route();
  } catch (err) {
    fieldError(form.email, err.message);
  }
});
$("signout").addEventListener("click", async () => { await API("/api/logout", { method: "POST" }); location.hash = "#/preferences"; route(); });

// ---------- stand-in for OneTrust's hosted preference centre (where the magic link lands)
async function oneTrustStandIn(token) {
  $("otpc-body").innerHTML = `<p class="empty">Opening…</p>`;
  try {
    const { email, expiryDate } = await API(`/api/onetrust/preference-centre?token=${encodeURIComponent(token || "")}`);
    $("otpc-body").innerHTML = `
      <div class="callout info">Stand-in: in production this is <b>OneTrust's hosted preference centre</b>. The person reviews and
        changes their preferences here; OneTrust records the change itself, and the consent fanout
        (OneTrust → SFMC, OneTrust → AEP) takes it from there.</div>
      <dl class="otpc-facts">
        <dt>Opened for</dt><dd>${esc(email)}</dd>
        <dt>Link token</dt><dd><code>${esc(token)}</code></dd>
        <dt>Valid until</dt><dd>${esc(new Date(expiryDate).toLocaleString())}</dd>
      </dl>`;
  } catch (err) {
    $("otpc-body").innerHTML = `<div class="callout err">${esc(err.message)}</div>`;
  }
}

// ---------- open questions: consent_fanout/<doc>.md, question by question, with comments
// Renders the markdown subset those files use: ## headings, paragraphs, nested -/1. lists,
// ``` blocks, **bold**, *italic*, `code` and [links](url).
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  .replace(/\*(.+?)\*/g, "<i>$1</i>")
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
const indentOf = (l) => l.match(/^ */)[0].length;
const LIST_ITEM = /^( *)([-*]|\d+\.) +(.*)$/;
const HEADING = /^(#{2,4}) +(.*)$/;
function md(src) {
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length + 1; // ## -> h3 (the page title is the h1)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith("```"); i++) code.push(lines[i]);
      i++;
      out.push(`<pre class="code">${esc(code.join("\n"))}</pre>`);
      continue;
    }
    const first = line.match(LIST_ITEM);
    if (first && !first[1]) {
      const ordered = /\d/.test(first[2]);
      const items = [];
      let m;
      while (i < lines.length && (m = lines[i].match(LIST_ITEM)) && !m[1] && /\d/.test(m[2]) === ordered) {
        const pad = m[2].length + 1 + (m[0].length - m[0].trimStart().length);
        const body = [m[3]];
        for (i++; i < lines.length && (!lines[i].trim() || indentOf(lines[i]) >= pad); i++) body.push(lines[i].slice(pad));
        items.push(`<li>${md(body.join("\n"))}</li>`);
      }
      out.push(ordered ? `<ol start="${parseInt(first[2], 10)}">${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (first) {
      // a list indented more than its surroundings: render that block as if it weren't
      const pad = first[1].length, block = [];
      for (; i < lines.length && (!lines[i].trim() || indentOf(lines[i]) >= pad); i++) block.push(lines[i].slice(pad));
      out.push(md(block.join("\n")));
      continue;
    }
    const para = [];
    const why = (l) => l.trim().startsWith("*Why:*"); // the "Why" behind each question gets its own paragraph
    for (; i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("```") && !LIST_ITEM.test(lines[i]) && !HEADING.test(lines[i]) && !(para.length && why(lines[i])); i++) para.push(lines[i].trim());
    out.push(`<p${why(para[0]) ? ' class="why"' : ""}>${inline(para.join(" "))}</p>`);
  }
  return out.join("");
}

// ---------- Schematics: every <flow>/diagrams/*.drawio, drawn by the diagrams.net viewer.
// The diagram XML stays in the page — the viewer script draws it here, nothing is uploaded.
const ICON_DIAGRAM = '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="6" rx="1"/><rect x="14" y="15" width="7" height="6" rx="1"/><path d="M6.5 9v4a2 2 0 0 0 2 2H14"/></svg>';
async function loadSchematicLinks() {
  try {
    const { schematics } = await API("/api/schematics");
    $("schematic-links").innerHTML = schematics.map((s) => `
      <a href="#/schematics/${encodeURIComponent(s.id)}" class="side-link" data-flow="schematics" data-doc="${esc(s.id)}">
        ${ICON_DIAGRAM}<span>${esc(s.name)}<small>${esc(s.flow)}</small></span></a>`).join("")
      || `<p class="side-empty">No diagrams yet.</p>`;
  } catch (err) {
    $("schematic-links").innerHTML = `<p class="side-empty">${esc(err.message)}</p>`;
  }
}

let viewerScript = null;
const loadViewer = () => (viewerScript ||= new Promise((resolve, reject) => {
  const script = document.createElement("script");
  script.src = "https://viewer.diagrams.net/js/viewer-static.min.js";
  script.onload = resolve;
  script.onerror = () => { viewerScript = null; reject(new Error("Couldn't load the diagrams.net viewer — check the internet connection.")); };
  document.head.appendChild(script);
}));

async function openSchematic(id) {
  $("s-title").textContent = "Loading…";
  $("s-lead").textContent = "";
  $("s-body").innerHTML = `<p class="empty">Loading diagram…</p>`;
  try {
    const [diagram] = await Promise.all([API(`/api/schematics/${encodeURIComponent(id)}`), loadViewer()]);
    $("s-title").textContent = diagram.name;
    $("s-lead").textContent = diagram.title;
    $("s-body").innerHTML = `<div class="schematic-canvas"></div>
      <p class="q-source">Source: <code>${esc(diagram.file)}</code> · edit it in draw.io / diagrams.net</p>`;
    const canvas = $("s-body").querySelector(".schematic-canvas");
    canvas.dataset.mxgraph = JSON.stringify({ xml: diagram.xml, nav: true, resize: true, tooltips: true, toolbar: "zoom layers lightbox", "toolbar-nohide": true });
    window.GraphViewer.createViewerForElement(canvas);
  } catch (err) {
    $("s-body").innerHTML = `<div class="callout err">${esc(err.message)}</div>`;
  }
}

// ---------- OneTrust Connectors: consent_fanout/connectors/<doc>.md as a reference page
async function openConnector(doc) {
  $("c-title").textContent = doc || "OneTrust Connectors";
  $("c-body").innerHTML = `<p class="empty">Loading…</p>`;
  try {
    const { title, markdown } = await API(`/api/connectors/${encodeURIComponent(doc)}`);
    $("c-title").textContent = title;
    $("c-body").innerHTML = md(markdown) + `<p class="q-source">Source: <code>consent_fanout/connectors/${esc(doc)}.md</code></p>`;
  } catch (err) {
    $("c-body").innerHTML = `<div class="callout err">${esc(err.message)}</div>`;
  }
}

const qs = { doc: null, data: null, open: {}, error: "" };
const AUTHOR_KEY = "cpms-question-author";
const savedAuthor = () => { try { return localStorage.getItem(AUTHOR_KEY) || ""; } catch { return ""; } };
const saveAuthor = (name) => { try { localStorage.setItem(AUTHOR_KEY, name); } catch { /* storage blocked: just don't remember */ } };
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

async function openQuestions(doc) {
  if (qs.doc !== doc) Object.assign(qs, { doc, data: null, open: {}, error: "" });
  $("q-title").textContent = doc || "Open questions";
  $("q-lead").textContent = "";
  renderQuestions();
  try {
    qs.data = await API(`/api/questions/${encodeURIComponent(doc)}`);
  } catch (err) {
    qs.error = err.message;
  }
  renderQuestions();
}

function renderQuestions() {
  const body = $("q-body");
  if (qs.error) { body.innerHTML = `<div class="card"><div class="callout err">${esc(qs.error)}</div></div>`; return; }
  if (!qs.data) { body.innerHTML = `<div class="card"><p class="empty">Loading questions…</p></div>`; return; }
  const { title, intro, sections, questions, comments } = qs.data;
  $("q-title").textContent = title;
  $("q-lead").textContent = intro;
  const byQuestion = (n) => comments.filter((c) => c.question === n);
  let group = null;
  const cards = questions.map((q) => {
    const head = q.group !== group ? `<h2 class="q-group">${esc((group = q.group))}</h2>` : "";
    const list = byQuestion(q.n);
    return `${head}<article class="card q-card" id="q-${q.n}">
      <div class="q-head"><span class="q-num">Q${q.n}</span>
        <button class="btn ghost small q-toggle" type="button" data-q="${q.n}">${list.length ? `${list.length} comment${list.length > 1 ? "s" : ""}` : "Comment"}</button></div>
      <div class="md">${md(q.markdown)}</div>
      ${qs.open[q.n] || list.length ? commentsHtml(q.n, list) : ""}
    </article>`;
  }).join("");
  body.innerHTML = `<div class="card q-intro">${sections.map((s, i) =>
    `<details${i === 0 ? " open" : ""}><summary>${esc(s.title)}</summary><div class="md">${md(s.markdown)}</div></details>`).join("")}</div>
    <p class="q-source">Source: <code>consent_fanout/${esc(qs.doc)}.md</code> · comments saved to <code>consent_fanout/comments/${esc(qs.doc)}.json</code></p>
    ${cards}`;
}

function commentsHtml(n, list) {
  return `<div class="comments">
    ${list.map((c) => `<div class="comment">
      <div class="comment-meta"><b>${esc(c.author)}</b><span>${esc(when(c.at))}</span>
        <button class="link-btn" type="button" data-delete="${esc(c.id)}" aria-label="Delete comment">Delete</button></div>
      <div class="comment-text">${esc(c.text).replace(/\n/g, "<br>")}</div>
    </div>`).join("")}
    ${qs.open[n] ? `<form class="comment-form" data-q="${n}">
      <input name="author" placeholder="Your name" value="${esc(savedAuthor())}" maxlength="80">
      <textarea name="text" rows="3" placeholder="Answer, decision or follow-up…" maxlength="4000" required></textarea>
      <div class="actions"><span class="error" data-error="comment"></span>
        <button class="btn ghost small" type="button" data-cancel="${n}">Cancel</button>
        <button class="btn primary small" type="submit">Add comment</button></div>
    </form>` : `<button class="link-btn" type="button" data-q="${n}">+ Add comment</button>`}
  </div>`;
}

$("q-body").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-q]:not(form)");
  const cancel = e.target.closest("[data-cancel]");
  const del = e.target.closest("[data-delete]");
  if (open) {
    qs.open[open.dataset.q] = true;
    renderQuestions();
    document.querySelector(`.comment-form[data-q="${open.dataset.q}"] textarea`)?.focus();
  } else if (cancel) {
    delete qs.open[cancel.dataset.cancel];
    renderQuestions();
  } else if (del) {
    try {
      ({ comments: qs.data.comments } = await API(`/api/questions/${encodeURIComponent(qs.doc)}/comments/${encodeURIComponent(del.dataset.delete)}`, { method: "DELETE" }));
    } catch (err) {
      qs.error = err.message;
    }
    renderQuestions();
  }
});

$("q-body").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const n = Number(form.dataset.q);
  const author = form.author.value.trim();
  const text = form.text.value.trim();
  const error = form.querySelector('[data-error="comment"]');
  if (!text) { error.textContent = "Write a comment first."; return; }
  saveAuthor(author);
  form.querySelector("[type=submit]").disabled = true;
  try {
    ({ comments: qs.data.comments } = await API(`/api/questions/${encodeURIComponent(qs.doc)}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: n, author, text }),
    }));
    delete qs.open[n];
    renderQuestions();
  } catch (err) {
    error.textContent = err.message;
    form.querySelector("[type=submit]").disabled = false;
  }
});

await loadConfig();
await loadSchematicLinks(); // before route(), so the current schematic's link can be marked active
route();
