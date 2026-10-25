# Consent fanout — Design

Living document. How consent changes recorded in OneTrust reach downstream systems. Per-system
questions are in `SFMC.md`, `AEP.md` and `Marketo.md`.

## CPMS_Marketo_Bridge

The CPMS middleware between OneTrust and Marketo. OneTrust tells it that someone's consent
changed; it updates every matching Marketo lead within Marketo's API limits and daily quota. The
same pattern can take further targets (e.g. an SFMC bridge) as their own queues and Lambdas.

### Why not connect OneTrust directly to Marketo

OneTrust *can* call Marketo's API itself, from an integration workflow, one call per consent
change. That works in a demo and breaks in production — each point below is something the bridge
exists to handle:

1. **Expired tokens delay opt-outs.** Marketo access tokens expire. OneTrust's built-in calls
   don't renew them well: Marketo practitioners report jobs failing on expiry and retrying 15–30
   minutes later.
   *Example:* Jane opts out at 09:00; the token expired at 08:59, so her update fails and Marketo
   only learns at 09:25 — meanwhile the 09:10 campaign emails her.
2. **No respect for Marketo's rate limits.** Marketo allows 100 calls per 20 seconds and 10 at
   once, **shared with everything else using the instance** (CRM sync, other tools). OneTrust
   sends one call per record, as fast as changes happen.
   *Example:* a batch of 5,000 changes (say, after a purpose is withdrawn for a whole segment)
   hits the limit within seconds; calls fail with error `606`, and the CRM sync starts failing too.
3. **The daily quota runs out.** Without batching, every change costs about two calls (find the
   lead, update it). A large re-push — 40,000 people is ~80,000 calls — uses up a typical
   50,000-a-day quota, and then **every** update stops until the next day, opt-outs included.
   The bridge batches 300 people per call: the same re-push is ~270 calls.
4. **Duplicate leads keep the old consent.** OneTrust has one record per email; Marketo can hold
   several leads with the same email (CRM sync, partitions, API-created duplicates). A direct
   call updates one of them.
   *Example:* Jane is both a lead and a contact synced from Dynamics; the opt-out lands on one,
   and the other keeps getting marketing.
5. **Changes can land out of order.** Workflow runs aren't serialised per person, so an older
   change can be written after a newer one.
   *Example:* Jane opts in at 10:00 and out at 10:05; if the 10:00 call is retried and completes
   last, she's opted back in. The bridge's per-person queue and watermark prevent this.
6. **Failures are silent.** A failed workflow call has no dead-letter queue, no alarm and no
   replay: the opt-out is simply lost, and nobody knows until a complaint arrives. The bridge
   counts, alarms and keeps every failure for replay.
7. **The logic lives in OneTrust configuration.** Field mapping, retries and error handling would
   be built in OneTrust's workflow builder — not version-controlled, not unit-tested, not
   reviewable in a pull request. In the bridge it's code in this repo, with tests.
8. **Every new system repeats the problem.** Each further target (SFMC, an app, AEP) would need its
   own fragile direct workflow. The bridge pattern is built once and reused per target.

In short, a direct connection puts compliance-critical opt-outs at the mercy of token timing,
shared rate limits and a daily quota, with no ordering, no duplicate handling and no record of
failures. The bridge turns each of those into something designed for and monitored. See also
`Marketo.md` → Approach.

### Flow

1. **Trigger** — OneTrust's *Data Subject Consent Updated* event, filtered by purpose /
   collection point, with **delta-type events off** so it fires on every change and carries the
   person's full current consent. A OneTrust integration workflow posts it to the CPMS endpoint.
2. **Endpoint** — `POST /onetrust/consent-updated` on API Gateway; checked (see **Endpoint
   security**), then put on a queue.
3. **Queue** — FIFO, grouped by email, so one person's updates stay in order. Two queues (see
   **API quota**).
4. **Fanout Lambda** — reads the queues and batches the updates.
5. **Watermark check** — drops any update older than the last state already written for that
   person (see **Ordering**).
6. **Update Marketo** — finds and updates every lead for each email (see **Updating Marketo**).
7. **Marketo** — sends and programs filter on the updated fields.

### Endpoint security

The endpoint changes consent in Marketo, so it accepts **only OneTrust**:

- **Shared secret** — OneTrust's workflow sends it in a header (`x-cpms-webhook-key`); a Lambda
  authorizer compares it with `cpms-secret-onetrust-webhook` in Secrets Manager. Wrong or
  missing → `401`, nothing is queued.
- **IP allowlist** — the API Gateway resource policy (or WAF) only lets in OneTrust's outbound IP
  ranges.
- **Payload check** — the body must validate against a schema (email + known purpose / topic /
  channel codes); anything else → `400`.
- **Throttling** on the route, and every rejection counted and alarmed, so probing shows up.
- **Rotation** — a new secret is set in OneTrust's workflow credential and Secrets Manager
  together; both are accepted briefly during the switch.

### Updating Marketo

For each batch, the fanout Lambda:

1. **Token** — gets a Marketo access token (`/identity/oauth/token`, client credentials from
   `cpms-secret-marketo-api`) and **reuses it until just before it expires**, rather than one per
   call.
2. **Find the leads** — `GET /rest/v1/leads.json?filterType=email&filterValues=<up to 300 emails>`
   returns **every** lead for those emails (Marketo can hold several per email).
3. **Update them** — `POST /rest/v1/leads.json` with `action: updateOnly`, `lookupField: id`,
   up to 300 leads per call, never exceeding Marketo's limits (100 calls per 20 seconds,
   10 concurrent).
4. **Errors** — rate-limit (`606`) and expired-token errors are retried straight away (new token
   or short back-off); anything that still fails goes to a dead-letter queue and raises an alarm.

### Ordering: never write an older state over a newer one (watermark)

Batching and two queues mean one person's changes can be processed out of order.

*Example:* at 10:00 Jane opts in to event emails (bulk queue); at 10:05 she opts out of all
marketing (urgent queue). The urgent queue is drained first, so the opt-out is written at 10:06 —
then the older opt-in comes out of the bulk queue and would switch her back on.

So the Lambda keeps a **per-person watermark**: the OneTrust timestamp of the last state it wrote for
that email (in S3 under `cpms/fanout-watermarks/marketo/<sha256(email)>.json`, like
`send_to_cpms`'s watermarks). An update older than the watermark is dropped; a newer one is
written and moves the watermark forward. In the example, the 10:00 opt-in is older than the
10:05 watermark, so it's dropped. The watermark is only moved after Marketo confirms the write,
with a conditional S3 write so two Lambdas can't overwrite each other's watermark.

### API quota

Marketo allows a fixed number of API calls per day (typically 50,000), shared by everything that
uses the instance. Unbatched, each update costs about two calls (find + update), so a large
re-push — e.g. 40,000 people after a taxonomy change, ~80,000 calls — would use up the quota and
stop **all** updates, opt-outs included, until the next day. Four measures prevent that:

1. **Batch the calls** — the Lambda gathers updates for a short window (e.g. 30 seconds, or until
   it has 300), keeps only each person's latest state, then makes **one** lookup and **one**
   update call for the whole batch: about 2 calls per 300 people. The 40,000 re-push becomes
   ~270 calls.
2. **Opt-outs jump the queue** — two queues: **urgent** (withdrawals and opt-outs) and **bulk**
   (opt-ins and re-syncs). Urgent is always drained first; bulk stops for the day once a set share
   of the quota is used (e.g. 70%), so there's always room for opt-outs.
3. **Watch the quota** — before draining the bulk queue the Lambda reads today's usage from
   Marketo's usage API; an alarm fires as it nears the limit.
4. **Very large re-syncs use Marketo's Bulk Import API** — "re-push everyone" goes as one CSV
   import instead of thousands of API calls.

If volumes ever outgrow this, Marketo sells more daily quota.

### Components (not built)

| Component | Name |
|---|---|
| Endpoint | API Gateway route `POST /onetrust/consent-updated` |
| Authorizer | `cpms-lambda-fanout-authorizer` |
| Webhook secret | `cpms-secret-onetrust-webhook` |
| Marketo API credentials | `cpms-secret-marketo-api` |
| Urgent queue | `cpms-sqs-fanout-marketo-urgent.fifo` |
| Bulk queue | `cpms-sqs-fanout-marketo-bulk.fifo` |
| Dead-letter queue | `cpms-sqs-fanout-marketo-dlq.fifo` |
| Fanout Lambda | `cpms-lambda-fanout-marketo` |
| Watermarks | S3 `cpms/fanout-watermarks/marketo/` |
| Alarm (failures, rejections, quota) | `cpms-alarm-fanout-marketo` |
