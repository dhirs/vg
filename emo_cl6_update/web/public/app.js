// Two registration flows (event via EMO, new adviser account via CL6), each:
// two-step form -> source_event preview -> send to CPMS -> what CPMS generated for OneTrust.
// Plus a preference centre for a signed-in user: sign in -> link with local ID -> CRM -> OneTrust -> edit -> send changes.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const FLOWS = ["event", "account"];
const SOURCE_LABEL = { event: "EMO", account: "CL6" };

// Per-flow state, so switching flows keeps each one's last send and result.
const state = Object.fromEntries(FLOWS.map((f) => [f, { sent: null, result: null, status: "idle", error: null, pollToken: 0 }]));
let flow = "event";
let tab = "form";
let pending = null; // { flow, event } shown in the modal
let TAX = null;      // taxonomy (purposes, topics, channels) for the preference editor

function highlight(text) {
  return esc(text).replace(/("(\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?/g, (m, str, _, colon, bool) =>
    str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`)
        : bool ? `<span class="b">${m}</span>` : `<span class="n">${m}</span>`);
}
const json = (o) => highlight(JSON.stringify(o, null, 2));

// ---------- page content
async function loadConfig() {
  const { event, firmSizes, companyTypes, taxonomy } = await (await fetch("/api/config")).json();
  TAX = taxonomy;
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

// ---------- routing: #/event, #/account, #/preferences[?localId=…]
const PAGES = [...FLOWS, "preferences"];
function route() {
  const [path, query = ""] = location.hash.replace(/^#\//, "").split("?");
  flow = PAGES.includes(path) ? path : "event";
  document.querySelectorAll("[data-flow]").forEach((el) => {
    const flows = el.dataset.flow.split(" ");
    if (el.classList.contains("side-link")) el.classList.toggle("active", flows.includes(flow));
    else el.hidden = !flows.includes(flow);
  });
  if (flow === "preferences") return preferenceCentre(new URLSearchParams(query).get("localId"));
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
      if (f === "update") return onUpdateSent(event);
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
    ${s.sent.crmLocalId ? `<div class="callout info">Added to the stub CRM as <code>${esc(s.sent.crmLocalId)}</code> — sign in to the Preference centre with <b>${esc(event.subject.identifierValue)}</b> and password <code>demo</code> to manage these settings.</div>` : ""}
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

// ---------- preference centre
const STEPS = [
  { key: "signin", title: "Signed in", hint: "Vanguard 365 session" },
  { key: "link", title: "Preference link", hint: "carries your local ID" },
  { key: "crm", title: "CRM lookup", hint: "local ID → email" },
  { key: "onetrust", title: "OneTrust lookup", hint: "email → preferences" },
  { key: "show", title: "Your settings", hint: "review & change" },
  { key: "save", title: "Changes saved", hint: "sent to CPMS" },
];
const pc = { run: 0, status: {}, details: {}, subject: null, prefs: null, current: null, draft: null, banner: "" };

function setProgress() {
  $("progress").innerHTML = STEPS.map((step, i) => {
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

async function preferenceCentre(localId) {
  const run = ++pc.run;
  const live = () => run === pc.run;
  Object.assign(pc, { status: {}, details: {}, subject: null, prefs: null, banner: "" });
  const step = (key, st, detail) => { pc.status[key] = st; if (detail) pc.details[key] = detail; if (live()) setProgress(); };
  const body = (html) => { if (live()) $("pc-body").innerHTML = html; };
  const fail = (key, err) => { step(key, "error", err.message); body(`<div class="callout err">${esc(err.message)}</div>`); };

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
  body(`<div class="callout warn"><span class="spinner"></span>Looking you up…</div>`);
  try { pc.subject = await API(`/api/crm/subject?localId=${encodeURIComponent(localId)}`); } catch (err) { return fail("crm", err); }
  step("crm", "done", pc.subject.email);

  // 4. OneTrust: email -> preferences (stand-in: CPMS records)
  step("onetrust", "active", "fetching preferences…");
  try { await loadPrefs(); } catch (err) { return fail("onetrust", err); }
  if (!live()) return;
  step("onetrust", "done", `${pc.prefs.purposes.length + pc.prefs.preferences.length} settings · stand-in`);

  // 5. editable settings
  step("show", "active", "review & change");
  renderEditor();
}

// Current settings as the page shows them: each purpose's consent, and topic × channel on/off.
// A topic × channel with no explicit choice yet takes its value from the topic's purpose: a
// registration's "you will also receive marketing communications" means email is on for every
// topic under a granted purpose; SMS and push stay off until chosen. (Assumption — design.md.)
async function loadPrefs() {
  pc.prefs = await API(`/api/onetrust/preferences?email=${encodeURIComponent(pc.subject.email)}`);
  const on = (st) => st === "granted" || st === "opt_in";
  const purposes = Object.fromEntries(TAX.purposes.map((p) => [p.code, false]));
  for (const p of pc.prefs.purposes) purposes[p.purposeCode] = on(p.status);
  const explicit = Object.fromEntries(pc.prefs.preferences.map((p) => [`${p.topicCode}|${p.channel}`, on(p.status)]));
  const prefs = {};
  for (const t of TAX.topics) for (const c of TAX.channels) {
    const key = `${t.code}|${c}`;
    prefs[key] = purposes[t.purposeCode] && (key in explicit ? explicit[key] : c === "email");
  }
  const marketingOn = TAX.purposes.some((p) => p.marketing && purposes[p.code]) || Object.values(prefs).some(Boolean);
  pc.current = { purposes, prefs, optOutAll: !marketingOn };
  pc.draft = { purposes: { ...purposes }, prefs: { ...prefs }, optOutAll: !marketingOn };
}

function signInForm(demo) {
  return `
    <h3 class="pc-title">Sign in to Vanguard 365</h3>
    <p class="lead">You need to be signed in to see and change your preferences.</p>
    <form id="signin" class="signin" novalidate>
      <label class="field"><span class="label">Email address</span><input name="email" type="email" autocomplete="username" value="${esc(demo.email)}"><span class="error"></span></label>
      <label class="field"><span class="label">Password</span><input name="password" type="password" autocomplete="current-password" value="${esc(demo.password)}"><span class="error"></span></label>
      <div class="actions"><span class="hint">Simulated sign-in: any registered email + password <code>demo</code>.</span><button class="btn primary" type="submit">Sign in</button></div>
    </form>`;
}

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "signin") return;
  e.preventDefault();
  const form = e.target;
  try {
    await API("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }) });
    route();
  } catch (err) {
    fieldError(form.password, err.message);
  }
});
$("signout").addEventListener("click", async () => { await API("/api/logout", { method: "POST" }); location.hash = "#/preferences"; route(); });


const purposeOf = (code) => TAX.purposes.find((p) => p.code === code);
const topicsOf = (purposeCode) => TAX.topics.filter((t) => t.purposeCode === purposeCode);
const keysOf = (topicCode) => TAX.channels.map((c) => `${topicCode}|${c}`);

// Effective draft values: "opt out of all marketing" overrides the marketing purposes, and a
// topic × channel is only on while its purpose is on.
const draftPurpose = (code) => !(pc.draft.optOutAll && purposeOf(code).marketing) && pc.draft.purposes[code];
const draftPref = (key) => {
  const topic = TAX.topics.find((t) => t.code === key.split("|")[0]);
  return !pc.draft.optOutAll && draftPurpose(topic.purposeCode) && pc.draft.prefs[key];
};

// Only what differs from what was loaded is sent — an explicit "off" for anything switched off.
// Two saves send a full set instead of just the differences, because what the page loaded is
// CPMS's view, not OneTrust's, and a changes-only "off" could leave behind something another
// system switched on at OneTrust:
//  - switching a purpose off opts out every topic × channel under it;
//  - "opt out of all marketing" withdraws every marketing purpose and opts out every topic × channel.
function changes() {
  const consent = TAX.purposes.filter((p) => draftPurpose(p.code) !== pc.current.purposes[p.code])
    .map((p) => ({ purpose: p.code, status: draftPurpose(p.code) ? "granted" : "withdrawn" }));
  const prefs = new Map();
  const fullOptOut = pc.draft.optOutAll && !pc.current.optOutAll;
  for (const t of TAX.topics) {
    const purposeTurnedOff = pc.current.purposes[t.purposeCode] && !draftPurpose(t.purposeCode);
    for (const key of keysOf(t.code)) {
      if (fullOptOut || purposeTurnedOff) prefs.set(key, "opt_out");
      else if (draftPref(key) !== pc.current.prefs[key]) prefs.set(key, draftPref(key) ? "opt_in" : "opt_out");
    }
  }
  const preferences = [...prefs].map(([k, status]) => { const [topic, channel] = k.split("|"); return { topic, channel, status }; });
  return { consent, preferences, count: consent.length + preferences.length };
}

const nameOf = (code) => code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()); // marketing_communications -> Marketing communications

function renderEditor() {
  const s = pc.subject, p = pc.prefs;
  const sections = TAX.purposes.map((tp) => {
    const isOn = draftPurpose(tp.code);
    const purposeChanged = isOn !== pc.current.purposes[tp.code];
    const topics = topicsOf(tp.code).map((t) => {
      const changed = keysOf(t.code).some((k) => draftPref(k) !== pc.current.prefs[k]);
      return `<li class="topic-row ${changed ? "changed" : ""} ${isOn ? "" : "muted-row"}">
        <div><b>${esc(nameOf(t.code))}</b></div>
        <div class="chan">${TAX.channels.map((c) => {
          const on = draftPref(`${t.code}|${c}`);
          return `<button type="button" class="chan-toggle ${on ? "on" : ""}" data-kind="pref" data-key="${esc(t.code)}|${esc(c)}" aria-pressed="${on}">${esc(c)}</button>`;
        }).join("")}</div>
      </li>`;
    }).join("");
    return `<section class="purpose ${isOn ? "on" : ""} ${purposeChanged ? "changed" : ""}">
      <header class="purpose-head">
        <div><b>${esc(nameOf(tp.code))}</b></div>
        <label class="switch"><input type="checkbox" data-kind="purpose" data-key="${esc(tp.code)}" ${isOn ? "checked" : ""}><span></span></label>
      </header>
      ${topics ? `<div class="topics-label">Topics</div><ul class="topic-list">${topics}</ul>` : ""}
    </section>`;
  }).join("");
  const optChanged = pc.draft.optOutAll !== pc.current.optOutAll;
  const n = changes().count;
  $("pc-body").innerHTML = `
    ${pc.banner}
    <div class="pc-head">
      <div><h3 class="pc-title">${esc(s.email)}</h3><p class="meta-line"><span>${esc(s.company)}</span><span>local ID <code>${esc(s.localId)}</code></span></p></div>
    </div>
    <h4 class="pc-section">Your current settings</h4>
    <p class="muted pc-help">Each purpose is what you've agreed to; its topics are what you hear about, and on which channels.</p>
    ${sections}
    <div class="optout ${pc.draft.optOutAll ? "active" : ""} ${optChanged ? "changed" : ""}">
      <div><b>Opt out of all marketing contact</b>
        <small>Stops all marketing emails, texts and notifications. You'll still receive messages about your account and events you've registered for.</small></div>
      <label class="switch danger"><input type="checkbox" id="pc-optout" ${pc.draft.optOutAll ? "checked" : ""}><span></span></label>
    </div>
    <p class="source-note">Loaded from ${esc(p.source)} — what CPMS last sent to OneTrust for you.</p>
    <div class="save-bar">
      <span class="hint">${n ? `<b>${n}</b> unsaved change${n === 1 ? "" : "s"} will be sent.` : "No changes yet."}</span>
      <button class="btn ghost" type="button" id="pc-reset" ${n || optChanged ? "" : "disabled"}>Undo changes</button>
      <button class="btn primary" type="button" id="pc-save" ${n ? "" : "disabled"}>Save changes</button>
    </div>`;
}

document.addEventListener("change", (e) => {
  if (e.target.id === "pc-optout") {
    pc.draft.optOutAll = e.target.checked;
    if (!pc.draft.optOutAll) {
      // back in: marketing purposes on again (as they were, or on if they'd been off)
      for (const p of TAX.purposes) if (p.marketing) pc.draft.purposes[p.code] = true;
    }
    return renderEditor();
  }
  const sw = e.target.closest('input[data-kind="purpose"]');
  if (sw) {
    pc.draft.purposes[sw.dataset.key] = sw.checked;
    if (sw.checked && purposeOf(sw.dataset.key).marketing) pc.draft.optOutAll = false;
    renderEditor();
  }
});
document.addEventListener("click", async (e) => {
  const chip = e.target.closest('button[data-kind="pref"]');
  if (chip) {
    const key = chip.dataset.key;
    const parent = TAX.topics.find((t) => t.code === key.split("|")[0]).purposeCode;
    if (!draftPref(key) && (pc.draft.optOutAll || !draftPurpose(parent))) {
      // choosing a channel under an off purpose / while opted out = "opt back in, to this"
      if (pc.draft.optOutAll) {
        pc.draft.optOutAll = false;
        for (const p of TAX.purposes) if (p.marketing) pc.draft.purposes[p.code] = false;
      }
      pc.draft.purposes[parent] = true;
      for (const k of TAX.topics.filter((t) => t.purposeCode === parent).flatMap((t) => keysOf(t.code))) pc.draft.prefs[k] = false;
      pc.draft.prefs[key] = true;
    } else {
      pc.draft.prefs[key] = !pc.draft.prefs[key];
    }
    return renderEditor();
  }
  if (e.target.id === "pc-reset") {
    pc.draft = { purposes: { ...pc.current.purposes }, prefs: { ...pc.current.prefs }, optOutAll: pc.current.optOutAll };
    return renderEditor();
  }
  if (e.target.id === "pc-save") {
    const { consent, preferences } = changes();
    try {
      const data = await fetch("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow: "update", changes: { consent, preferences } }) }).then((r) => r.json());
      pending = { flow: "update", event: data.event };
      $("modal-title").textContent = "Changes CL6 will send to CPMS";
      $("meta").textContent = data.entry ? `bus: ${data.entry.EventBusName} · source: ${data.entry.Source} · detail-type: ${data.entry.DetailType}` : "";
      $("payload").innerHTML = json(data.event);
      $("send").disabled = data.errors.length > 0;
      setStatus(data.errors.length ? `Can't send:\n${data.errors.join("\n")}` : "", data.errors.length ? "err" : "");
      openModal();
    } catch (err) {
      pc.banner = `<div class="callout err">${esc(err.message)}</div>`;
      renderEditor();
    }
  }
});

async function onUpdateSent(event) {
  const run = pc.run;
  const step = (key, st, detail) => { pc.status[key] = st; if (detail) pc.details[key] = detail; if (run === pc.run) setProgress(); };
  step("show", "done", `${changes().count} change(s) sent`);
  step("save", "active", "CPMS processing…");
  pc.banner = `<div class="callout warn"><span class="spinner"></span>Saving — CPMS is processing your changes…</div>`;
  renderEditor();
  try {
    const r = await waitForResult(event.eventId);
    if (run !== pc.run) return;
    const details = `<details class="result-details"><summary>What CPMS sent to OneTrust</summary>${resultHtml(r)}</details>`;
    if (r.outcome === "rejected") {
      step("save", "error", `rejected at ${r.failedStep}`);
      pc.banner = `<div class="callout err">Your changes weren't saved — CPMS rejected them at <b>${esc(r.failedStep)}</b>.</div>${details}`;
      return renderEditor(); // keep the draft so nothing is lost
    }
    step("save", "done", r.outcome === "sent" ? `${r.requests.length} OneTrust request(s)` : "nothing new to send");
    await loadPrefs(); // reload so the page shows the new current state
    pc.banner = `<div class="callout ok">Your preferences have been saved.</div>${details}`;
    renderEditor();
  } catch (err) {
    step("save", "error", "no result");
    pc.banner = `<div class="callout err">${esc(err.message)}</div>`;
    renderEditor();
  }
}

await loadConfig();
route();
