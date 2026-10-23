// Two registration flows (event via EMO, new adviser account via CL6), each:
// two-step form -> source_event preview -> send to CPMS -> what CPMS generated for OneTrust.
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

// ---------- routing: #/event, #/account
function route() {
  const wanted = location.hash.replace(/^#\//, "");
  flow = FLOWS.includes(wanted) ? wanted : "event";
  document.querySelectorAll("[data-flow]").forEach((el) => {
    if (el.classList.contains("side-link")) el.classList.toggle("active", el.dataset.flow === flow);
    else el.hidden = el.dataset.flow !== flow;
  });
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
    pending = { flow: f, event: data.event };
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
  const { flow: f, event } = pending;
  $("send").disabled = true;
  setStatus("Sending…");
  try {
    const res = await fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }) });
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
    <pre class="code">${json(event)}</pre>`;

  const r = s.result;
  const record = r && r.record ? `<p class="meta-line"><span>Run record <code>${esc(r.record)}</code></span></p>` : "";
  if (s.status === "processing") {
    $("ot-body").innerHTML = `<div class="callout warn"><span class="spinner"></span>CPMS is processing the event… usually a few seconds.</div>`;
  } else if (s.status === "error") {
    $("ot-body").innerHTML = `<div class="callout err">${esc(s.error)}</div>`;
  } else if (r.outcome === "sent") {
    const n = r.requests.length;
    $("ot-body").innerHTML = `${record}
      <div class="callout ok">CPMS generated <b>${n}</b> OneTrust request${n === 1 ? "" : "s"} and queued ${n === 1 ? "it" : "them"} on <code>cpms-sqs-outbound.fifo</code> — exactly what the dispatcher will send.</div>
      ${r.warning ? `<div class="callout warn">Warning: ${esc(r.warning)}</div>` : ""}
      ${r.dropped.length ? `<p class="lead">Dropped as stale (something newer was already sent):</p>${droppedList(r.dropped)}` : ""}
      ${r.requests.map((q, i) => `
        <div class="receipt-title"><span>Request ${i + 1} of ${n}</span><small>interactionDate ${esc(q.body.interactionDate)}</small></div>
        <pre class="code">${json(q)}</pre>`).join("")}`;
  } else if (r.outcome === "skipped_stale") {
    $("ot-body").innerHTML = `${record}
      <div class="callout info">Nothing was sent to OneTrust: every decision in this event is <b>not newer</b> than what CPMS already sent for this person.</div>
      ${droppedList(r.dropped)}`;
  } else if (r.outcome === "rejected") {
    $("ot-body").innerHTML = `${record}
      <div class="callout err">CPMS rejected this event at step <b>${esc(r.failedStep)}</b> — nothing was sent to OneTrust.</div>
      <ul class="list">${(r.errors || []).map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>`;
  }
}

await loadConfig();
route();
