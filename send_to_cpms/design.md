# OneTrust Integration System — Design

Living document. Updated as decisions are made and aligned on.

## Overview

Internal services (e.g. secure portal registration, event registration via Cvent/Kaltura)
emit events describing user actions that require a OneTrust consent/preference record to
be created or updated. We do not have paid OneTrust API access yet, so instead of calling
OneTrust directly, the pipeline generates a correctly formatted OneTrust API request and
places it on a queue for later dispatch (manual, batched, or automatic once API access is
available).

Multiple source systems feed this pipeline (event registration, new account registration,
others to come). Sources send a generic, minimal event; the pipeline is responsible for
normalizing, validating, and enriching it with provenance before producing a OneTrust
payload. The design favors **additive extensibility** (new sources, channels, purposes,
topics) over schema/code changes.

## High-level flow

```
Source system --> EventBridge --> EventBridge rule --> Ingestion FIFO queue (MessageGroupId=subjectId)
                                                    --> FIFO consumer Lambda
                                                    --> Express Step Function (single, synchronous)
```

- Sources publish events into EventBridge.
- A single EventBridge rule sends **every** source event to the ingestion FIFO queue.
  There is nothing to route: one Step Function handles all sources — see **One Step
  Function for all sources** below.
- EventBridge does **not** target the Step Function directly — it targets an **ingestion
  FIFO SQS queue** instead. See **Ordering guarantee** below for why.
- The Step Function validates, transforms, builds the OneTrust payload, and enqueues it
  (to a second, outbound FIFO queue).
- No "does a record already exist" check and no create/update branch — see
  **Create vs. update: decided against** below. OneTrust's own upsert handles it.
- Consent/preference items older than what was already sent for that subject are dropped
  before the payload is built (per-item watermark in S3) — see **Out-of-order arrival**
  below.

## Schemas

### `schemas/source_event.schema.json` — what sources send

Deliberately minimal so source owners have a low integration bar, but still carries real
consent and provenance data (not deferred to later).

```
{
  schemaVersion, eventId, eventType, sourceSystem, occurredAt,
  subject:     { identifierType, identifierValue },
  consent?:     [ { purpose, status, capturedAt, captureMethod } ],
  preferences?: [ { topic, channel, status, capturedAt } ],
  provenance:  { sourceEventId, captureChannel, locale?, policyVersion?, correlationId? }
}
```

- **What a source sends depends on whether the person already has settings:**
  - **New registration**: only what the user chose, all `opt_in` / `granted`. Nothing
    exists yet to overwrite, so anything not chosen is simply "not chosen" — no implicit
    opt-outs. A form with granular choices sends one item per chosen topic × channel.
  - **Event registration page (EMO)** — the real page has **no granular choices**:
    registering *is* the agreement ("By registering, you will also receive marketing
    communications from Vanguard…"), plus a privacy/cookie policy confirmation tick. So
    EMO sends a **consent-only** event: `eventType: event_registration`,
    `sourceSystem: emo`, `consent[]` with `marketing_communications` and `event_communications`
    (*assumed* — see Open items), each `status: granted`,
    `captureMethod: implied_by_registration`, and the agreed policy in
    `provenance.policyVersion`. The page's profile fields (name, job role, firm, firm size)
    are for EMO's other processes and are **not** sent to CPMS. `sourceSystem: emo` records
    where the consent came from (provenance / collection point) — the event format is the
    same standard `source_event` either way.
  - **New adviser account (CL6)** — Vanguard 365 "About you" page: name, company, company type,
    optional FCA number; creating the account *is* the marketing agreement ("By creating an
    account… you will also receive marketing communications from Vanguard…"), plus a
    required tick accepting the privacy policy, IP agreement and terms and conditions. Not
    tied to any event. Sends a **consent-only** event: `eventType: account_registration`,
    `sourceSystem: cl6`, `consent[]` with `marketing_communications`,
    `status: granted`, `captureMethod: implied_by_account_creation`. Accepting the T&Cs and
    IP agreement is not a CPMS purpose (see **Taxonomy scope**). Profile fields are not
    sent to CPMS.
  - **Update** (`eventType: preference_update`): send only what **changed** — `opt_in` for
    things switched on, explicit `opt_out` for things switched off. Our own pages don't
    send these: an existing person changes preferences in OneTrust's preference centre
    (see **Updating consent**). The event type stays for sources that capture changes
    themselves.
  - Either way the pipeline is the same: it builds receipts from whatever items arrive.
- **Emails must be sent lowercased and trimmed** (`identifierType: "email"` →
  `identifierValue` must match a no-uppercase, no-whitespace email pattern, max 100
  chars; enforced via `if/then`). Reason: the email is used as-is as the ingestion FIFO
  `MessageGroupId`, and EventBridge can't transform it on the way in — so `Jane@X.com`
  and `jane@x.com` would land in two different ordering lines and could be processed out
  of order. Rejecting at step 1 makes it a visible source bug instead of a silent
  ordering failure. 100 chars is EventBridge's `MessageGroupId` limit.
- `eventType` distinguishes flows (e.g. `event_registration`, `account_registration`,
  `preference_update`) without needing a separate schema per flow.
- `consent` and `preferences` are each optional, but an event must carry **at least one**
  (`anyOf`). A preference centre sends only `preferences` (channel × topic choices); a
  registration form typically sends only `consent`. Sources send preferences directly —
  they are not derived — which is what fills canonical `preferences[]`.
- A **JSON Schema**, not a sample + doc, because: (a) it's the same artifact used both as
  human-readable contract *and* as the literal input to the runtime validator (`ajv`) —
  one source of truth, no drift between "what we agreed" and "what gets enforced"; (b) a
  sample alone can't express required-vs-optional, allowed value sets, or be fed to a
  validator.
- `provenance.channel` renamed to `provenance.captureChannel` to avoid colliding with
  canonical's `preferences[].channel` (different concept — capture context vs. comms
  channel — same name would've been confusing). **Done.**
- `policyVersion` moved from per-consent-item to `provenance` — one event's consent
  decisions are captured under a single policy version, so it belongs on the envelope,
  not repeated per item. **Done.**

### Canonical model — `schemas/canonical_consent.schema.json`

Must carry **both** consent (legal/compliance permission per purpose) and preferences
(granular, topic + channel choice) as distinct concepts, generic enough to add channels/
topics later with minimal downstream impact.

**5 top-level nodes:**

```
{
  header:      { schemaVersion, eventId, eventType, sourceSystem, occurredAt?, correlationId, processedAt },
  subject:     { subjectId, identifierType },
  consent:     [ { purposeCode, status, capturedAt, captureMethod?, legalBasis? } ],
  preferences: [ { topicCode, channel, status, capturedAt } ],
  provenance:  { sourceEventId, captureChannel, locale, policyVersion }
}
```

- `header` = pipeline/envelope metadata. `subject` = who it's about. Kept separate so
  envelope changes (e.g. a retry count later) don't ripple into subject/consent/preference
  mapping logic.
- `consent` and `preferences` are **arrays**, not fixed named fields — adding a new
  purpose or topic is a new array entry, not a schema change.
- `purposeCode` / `topicCode` / `channel` are **not** JSON Schema `enum`s. Enumerating them
  in the schema would mean a schema change + redeploy every time a new code is added.
  Instead their validity is checked against an external taxonomy reference (see below),
  so adding a new code is a data change, not a code/schema change. This is the actual
  mechanism behind "minimal downstream impact."
- `legalBasis` on each consent item is optional and **derived during transform** (step 2)
  from the taxonomy mapping — not something sources send. E.g. `purposeCode:
  "marketing_communications"` → `legalBasis: "consent"`.
- Schema file written. Mirrors `provenance.captureChannel` from `source_event` and keeps
  `preferences[].channel` as a distinct field (comms channel, not capture context).
- `header.occurredAt` and `consent[].captureMethod` are carried from the source event
  (added when step 2 was built — without them the transform silently dropped data).
  `captureMethod` in particular is part of a consent's compliance evidence ("how was this
  captured?"), so losing it between source and OneTrust wasn't acceptable.
- `header.correlationId` is required. When the source didn't send
  `provenance.correlationId`, step 2 sets it to the `eventId` — every canonical record is
  traceable, without forcing every source to generate correlation IDs.

## Taxonomy reference (purposeCode / topicCode / channel validity + OneTrust ID mapping)

**Taxonomy scope — decided: communication purposes only.** The taxonomy holds the purposes
a person can choose to receive communications for (today `marketing_communications` and
`event_communications`) and their topics. Non-marketing purposes — e.g. sharing data with
partners, or servicing the account under its contract — were **removed**: they aren't
choices in a preference centre and don't belong in this flow. Step 1 rejects an event that
references them.

- **Source of truth:** a file in **S3** — reviewable, versioned.
- **Read path:** **ElastiCache (Redis)**, not S3 directly, and **not** a locally-cached
  copy inside each Lambda's memory. Reasoning: a per-Lambda-container local cache can't be
  invalidated on change — there is no mechanism to reach into an already-warm, isolated
  Lambda execution environment and force a reload. TTL-based re-polling was ruled out
  (unacceptable staleness window). A shared external store removes the problem entirely.
- **Update path:** S3 object-change event notification → triggers a dedicated **updater
  Lambda** → reads the new file → writes it into Redis (e.g. a Redis Set per code type:
  `purposeCodes`, `topicCodes`, `channels`, plus the code → OneTrust ID mapping).
- All taxonomy-dependent Lambdas (step 1 content validation, payload build) **always**
  read from Redis. Never from S3 directly, never from local memory.
- **Infra consequence:** ElastiCache requires a VPC. The Lambdas that read it (step 1,
  payload build, and the updater Lambda) must run inside the VPC, with VPC endpoints for
  any other AWS services they call (S3, SQS, etc.) to avoid routing through NAT.
- **Development: no Redis, no VPC.** In dev, taxonomy-dependent Lambdas read the taxonomy
  file **directly from S3 on every invocation** — see **Development environment** below.

## Step Function states

1. **Validate source event** — two sub-checks, same step, same fail path:
   - **1a. Structural (JSON Schema)** — required fields, types, `status` enum,
     `format: date-time`, conditional format rules (e.g. `identifierType: "email"` →
     `identifierValue` must match a lowercase email pattern, via `if/then`).
   - **1b. Content validation** — `purpose`/`topic`/`channel` checked against the
     taxonomy (S3 in dev, Redis in prod — not left for later steps); timestamps not in the
     future. Catches "correct format, garbage data" — e.g. a structurally valid but
     unknown purpose code — right here instead of letting it flow further downstream.
   - Lambda returns `{ valid, errors }`, does not throw on a failed validation (expected
     business outcome, not an exception).
   - Failure → **fail path**, `failedStep: ValidateSource`.

2. **Transform to canonical model — and validate the result**
   - Lambda applies **one universal mapping** — not per-source logic. Every source
     already conforms to the single `source_event` schema, so there's exactly one
     function, not N source-specific ones.
   - This step is still real work, not a pass-through, because canonical is a
     **different, richer shape** than `source_event`, not a renamed copy of it:
     - `preferences[]` is mapped from `source_event.preferences[]` (`topic` → `topicCode`,
       `channel` kept as-is) — empty when the source only sent consent.
     - `legalBasis` is **derived** from `purposeCode` via the taxonomy mapping — no
       source sends it.
     - `header`/`provenance` get restructured (`correlationId` moves — falling back to
       `eventId` when absent — and `processedAt` is stamped here).
     - **A withdrawn purpose implies its topics are off.** For each `consent[]` item with
       status `withdrawn` / `opt_out`, step 2 adds `opt_out` for every topic × channel under
       that purpose (from the taxonomy), at the withdrawal's `capturedAt`, marked
       `derivedFrom: "purpose_withdrawal"`. An explicit choice for the same topic × channel
       in the event wins. So sources only state the withdrawal, and the topic opt-outs still
       reach the watermark, the records and the OneTrust receipt — which keeps OneTrust's
       topic statuses consistent and stops old topic choices silently returning if the
       purpose is later granted again.
     - `subject.identifierType` is normalized to one spelling (`member_id` / `MemberID` →
       `memberId`); `subjectId` is the identifier value as sent (emails are already
       lowercased — schema-enforced at step 1).
   - **Before returning, the Lambda validates its own output** against
     `canonical_consent.schema.json` (from S3). An off-contract result raises — see
     **Why step 1 is separate from step 2** for why this check lives here rather than in
     its own step.
   - The Lambda **raises** on anything unexpected (rather than returning an error object):
     any exception here is by definition a bug in our code. AWS-side Lambda errors are
     retried and then fail the run; everything else → fail path,
     `failedStep: TransformCanonical`.

3. **Filter stale items** — see **Out-of-order arrival** below for why.
   - Lambda reads the subject's watermark object (`cpms/watermarks/<sha256(subjectId)>.json`
     in dev), keeping its ETag. Missing object = new subject, nothing is stale.
   - Drops every `consent[]` / `preferences[]` item whose `capturedAt` is **≤** the stored
     `capturedAt` for that item key.
   - All items dropped → run ends as **`skipped_stale`** (recorded by step 7).
     Not a failure, no alarm — it's an expected outcome.
   - Otherwise the surviving items (and the ETag) are passed on to step 4.

4. **Build OneTrust receipts — and validate them**
   - Lambda turns the stale-filtered canonical record into one or more complete
     **OneTrust Consent Receipt requests** — see **Outbound message format** below for the
     exact shape and the canonical → receipt mapping. Taxonomy mapping translates
     `purposeCode`/`topicCode`/`channel` → OneTrust IDs.
   - **Before returning, the Lambda validates every request it built** against
     `schemas/onetrust_request.schema.json` (written from OneTrust's published API
     reference). This check is **load-bearing**: OneTrust's Consent Receipts API "does not
     perform data type validation" — a malformed receipt wouldn't be rejected by OneTrust,
     it would be *recorded wrong*. It's the only check before OneTrust.
   - No create/update branching (see below) — a consent receipt is always the same call.
   - Off-contract output or any other logic failure → fail path,
     `failedStep: BuildPayload`.

5. **Enqueue request**
   - Step Functions native SQS `SendMessage` integration, to the **outbound FIFO queue**,
     `MessageGroupId = subjectId`. One message per generated request, in ascending
     `interactionDate` order.
   - Message: exactly the validated `onetrust_request` object — see **Outbound message
     format**. Sent by a `Map` state with `MaxConcurrency: 1`, so requests are queued
     strictly in order.
   - Failure after retries → **the run fails** (`InfraFailure`), so SQS retries the whole
     event (ingestion DLQ after 5). Re-sending requests that *did* get queued before the
     failure is harmless: the outbound queue's content-based dedup drops exact repeats
     within 5 minutes, and OneTrust ignores receipts whose `interactionDate` isn't newer.
     (Originally this went to an outbound DLQ; failing the run is simpler and loses
     nothing, because the watermark hasn't moved yet.)

6. **Advance watermark**
   - Runs only **after** step 5 succeeds — see **Out-of-order arrival** for why the order
     matters.
   - Lambda re-reads the watermark, merges the enqueued items' `capturedAt` (+ `eventId`)
     into it, and writes it with a **conditional `PutObject`**: `If-Match: <ETag it just
     read>`, or `If-None-Match: *` for a new subject.
   - The merge is **monotonic**: an item's watermark only ever moves forward. So a retry,
     or a race with another run, can never move a watermark back to an older decision.
   - `412 Precondition Failed` / `409` (someone wrote between the read and the write) →
     re-read, re-merge, retry (up to 5 attempts). The ETag step 3 saw is passed along and
     compared; a mismatch is reported as `changedSinceFilter: true` — expected only if the
     one-run-per-subject FIFO guarantee was bypassed (e.g. a manual reprocess).
   - Item keys (`purpose#<code>`, `pref#<topic>#<channel>`) and the object key are derived
     by one shared module (`lambdas/shared/watermark.py`) used by both steps 3 and 6, so
     the two can't disagree about what an item is.
   - Failure → run still ends **`outcome: "sent"`** with `warning: "watermark not
     advanced"`. Not a rejection: the requests are already queued. Worst case a later
     replay re-sends the same decisions, which OneTrust ignores by `interactionDate` (see
     **Out-of-order arrival** for why that's safe).

7. **Write success record**
   - Native Step Functions S3 `PutObject` — no Lambda. Writes the run's full state (source
     event, EventBridge envelope, canonical record, OneTrust request(s), items dropped as
     stale, watermark result) plus a `result` block with the outcome (`sent` or
     `skipped_stale`) to `cpms/success/<eventId>/<run>.json`.
   - **Keyed by `eventId`** so a run's result can be found from the event alone (the
     preference form's "OneTrust payload" tab does exactly that). The FIFO consumer
     computes the folder name (`recordId`: the eventId made S3-safe, or `no-event-id`)
     and passes it into the run; replays of the same event add another `<run>.json` in
     the same folder rather than overwriting.
   - Failure after retries → run still ends with its real outcome (a missing record must
     not re-run an event whose requests are already queued).

**Fail path (shared by every data/logic failure).** Each step's failure first passes
through a small state that sets `failedStep` (`ValidateSource`, `TransformCanonical`,
`BuildPayload`, …), then joins one shared path: write `cpms/fail/<eventId>/<run>.json` (the whole
run state: source event, errors, `failedStep`), emit the `CPMS/DataFailures` metric, end
SUCCEEDED with `outcome: "rejected"`. `failedStep` is what delivers the fault attribution
the step boundaries exist for (see **Why step 1 is separate from step 2**) — you can tell
"source sent bad data" from "our code or config is wrong" from the fail record alone.

## One Step Function for all sources

**Decided: a single Express Step Function serves every source — not one per source.**

- Every source sends the identical `source_event` envelope, and step 2 applies one
  universal mapping. A per-source state machine would therefore be an identical copy of
  the same workflow — N things to deploy and keep in sync for zero difference in
  behavior.
- Source-specific detail that matters downstream (`sourceSystem`, `eventType`) travels
  inside the event and is carried into the canonical `header`, so the workflow doesn't
  need to know which source it's running for.
- Consequence: no router logic. The EventBridge rule is a plain "all events → ingestion
  FIFO queue" rule; there is no per-source selection to design.
- Revisit only if a source ever needs a genuinely different workflow (not just different
  data) — at that point add a second state machine and a matching rule, rather than
  pre-building per-source copies now.

## Why step 1 is separate from step 2 — and why validating our own output isn't a step

Steps are split where the **cause of a failure changes**, so that "which step failed"
alone says whose problem it is — visible in the execution history and in the fail
record's `failedStep`, without reading error payloads:

| Step | Failure means | Caused by |
|---|---|---|
| 1 | The **source** sent bad data | A bug or bad input on the source team's side |
| 2 | **Our transform** is wrong | A bug in code this team owns (e.g. a missing field mapping) |
| 4 | **Our receipt build or OneTrust config** is wrong | A bug in our code, or taxonomy mapping errors (e.g. missing / non-UUID OneTrust IDs) |

**Decided: checking a step's own output is done inside that step, not as a separate
step.** Originally the design had a separate "validate canonical" step after the
transform and a separate "validate OneTrust payload" step after the build. Both were
**folded in** (step 2 validates the canonical record it produced; step 4 validates the
receipts it built), because:

- The separation only earns its place when the failure cause differs. "Build" and
  "check what I built" have the **same** cause — our code or our config — so a separate
  step added a Lambda hop and a Lambda to maintain without telling you anything new.
- Nothing is lost diagnostically: the step raises with the exact schema errors, which
  land in the fail record next to `failedStep`.
- The checks themselves are **kept** — especially step 4's, since OneTrust doesn't
  validate receipts.

Step 1 stays separate from step 2 because its failures *do* have a different cause (the
source, not us). Merging 1 and 2 is possible but would blur exactly that line.

## Create vs. update: decided against

Originally designed a DynamoDB existence-lookup (`subjectId → oneTrustRecordId`) plus a
`Choice` branch to decide create vs. update. **Removed.** Reasoning: OneTrust's own API
performs an upsert — sending a new payload for an existing subject simply overrides the
prior record. We don't need to ask "does this exist" first; we just need the *order* of
events for the same subject preserved, so an older event can't overwrite a newer one.
That ordering requirement is what the next two sections (**Ordering guarantee** and
**Out-of-order arrival**) solve.

The S3 watermark (step 3) is **not** this lookup coming back. The removed lookup answered
"does a record exist → create or update?", which upsert makes unnecessary. The watermark
answers "is this decision newer than the one we already sent?" — upsert does not answer
that, because it blindly applies whatever arrives last.

## Ordering guarantee: FIFO queue before the Step Function, not just after it

**Why a direct EventBridge → Step Function target breaks ordering.** EventBridge can
target a Step Function execution directly (`StartExecution` is a native target type) —
but if it did, two events for the same subject would spawn two *independent, concurrently
running* Step Function executions. Each execution runs through several Lambda calls (validate,
transform, filter stale, build receipts, advance watermark), each with its own
variable latency (cold starts, retries). Nothing guarantees the execution for the
**older** event finishes first. If the newer event's execution happens to finish faster,
it reaches the enqueue step first — the older payload then lands on the outbound queue
*second*, overwriting the newer one at OneTrust once upsert happens. **An outbound FIFO
queue alone does not fix this**: FIFO only preserves whatever order messages arrive at
it — it cannot undo reordering that already happened upstream, inside variable-latency
Step Function processing, before the queue.

**The fix: serialize processing per subject, starting at ingestion, before any
variable-latency work happens.**

```
EventBridge → SQS FIFO (ingestion), MessageGroupId = subjectId
            → Lambda (FIFO consumer, batch size 1)
            → StartSyncExecution on an Express Step Function (blocks until done)
            → [steps 1–7, including the outbound FIFO enqueue]
            → Lambda returns success → SQS releases the next message for that subject
```

- The consumer Lambda calls `StartSyncExecution` and **blocks until the entire pipeline
  finishes** before acknowledging the SQS message. That's the mechanism that actually
  enforces "only one in-flight execution per subject at a time" — not the mere presence
  of a FIFO queue, but a consumer that won't advance to the next message in a
  `MessageGroupId` until the previous one's full run has completed.
- `StartSyncExecution` requires an **Express** Step Function, not Standard — this is why
  the state machine type changes from the originally-assumed Standard to Express.
- Two FIFO queues are needed, both keyed `MessageGroupId = subjectId`, for two different
  reasons: the **ingestion** queue serializes processing so an older event's run
  completes before a newer one's begins; the **outbound** queue (step 5) prevents the
  eventual dispatcher from reordering messages when it actually calls OneTrust (e.g. if
  the dispatcher runs multiple concurrent workers).
- **Limit:** FIFO preserves *arrival* order, not the order the user actually made their
  decisions. It stops two in-flight events from racing each other, but it can't help when
  an older event *arrives* after a newer one. That's handled separately — next section.

## Out-of-order arrival: per-item watermark in S3

### The problem

The FIFO setup above guarantees that events for one subject are processed in the order
they **arrive**. It says nothing about the order consent was actually **given**
(`capturedAt`). Those two orders diverge in normal operation:

- A source sends an event late — batch export, source-side retry, recovery from a
  source outage backlog.
- An event is replayed — redriven from a DLQ, or deliberately reprocessed after a fix.
- Two sources report on the same person with different delays (e.g. Cvent syncs hourly,
  the portal is real-time).

Concrete failure: user opts **in** to `marketing_communications` on Monday via Cvent, opts **out**
on Tuesday via the portal. The portal event arrives Tuesday; Cvent's batch arrives
Wednesday. FIFO dutifully processes them in arrival order — opt-out, then opt-in — and
OneTrust's upsert applies the last one it receives. The user ends up **opted in** after
explicitly opting out. For a consent system that's a compliance failure, not a cosmetic
bug, and nothing in the pipeline would flag it: every step succeeds.

### The fix

Remember, per subject and per consent/preference item, the `capturedAt` of the newest
decision we've already sent. Drop anything that isn't newer than that before building
the payload (step 3), and advance the record only after the payload is safely enqueued
(step 6).

**Storage:** one JSON object per subject in a dedicated S3 watermark bucket:

```
s3://<watermark-bucket>/watermarks/<sha256(subjectId)>.json
{
  "purpose#marketing_communications": { "capturedAt": "2026-10-20T09:15:00Z", "eventId": "..." },
  "pref#newsletter#email":   { "capturedAt": "2026-10-18T14:02:00Z", "eventId": "..." }
}
```

### Why each piece is the way it is

- **Why S3, not a database.** Decided: no DynamoDB in this flow. S3 is sufficient
  because it has the two properties this needs: **strong read-after-write consistency**
  (step 3 always sees step 6's last write) and **conditional writes** (`If-Match` on
  ETag / `If-None-Match: *`), which make the update safe without a lock. Cost is ~one GET
  + one PUT per event; added latency (~20–50 ms per call) is irrelevant for this
  pipeline. The Lambdas already run in the VPC with an S3 gateway endpoint, so no new
  networking.
- **Why per item, not per event or per subject.** One event can carry a *newer*
  `marketing_communications` decision and an *older* `event_communications` one. A single
  per-subject timestamp would have to accept or reject the whole event, either losing
  the new decision or applying the stale one. Per-item keys keep exactly the new parts.
- **Why one object per subject, not one per item.** One GET and one PUT per event
  regardless of how many items it carries. Per-item objects would mean N reads per event.
- **Why `sha256(subjectId)` as the key.** Keeps raw identifiers (email addresses) out of
  object keys, which show up in logs, S3 inventory, and access logs. Hashing also spreads
  keys evenly across S3 prefixes for request-rate scaling.
- **Why `≤`, not `<`.** An event with the same `capturedAt` as what's stored is the same
  decision being replayed. Dropping it makes replays and reprocessing genuinely
  harmless — they end as `skipped_stale` instead of re-sending.
- **Why advance the watermark *after* enqueue, not before.** If the watermark moved first
  and the enqueue then failed, the retry would see its own items as "already sent" and
  drop them — the decision would be silently lost. In the chosen order the failure modes
  are both safe:
  - Enqueue fails → watermark untouched → the retry goes through normally.
  - Enqueue succeeds, watermark write fails → a later replay re-sends the same payload,
    which upsert makes harmless. (A duplicate is safe; a lost decision is not.)
- **Why conditional writes, if FIFO already serializes per subject.** In normal operation
  only one run per subject is ever in flight, so the condition should essentially never
  trip. It's the backstop for when that assumption breaks — a consumer timeout causing
  SQS to redeliver while the first run is still going, or a manual reprocess running
  alongside live traffic. Without it, two overlapping runs could each read the same
  watermark and the second write would clobber the first.
- **Why `skipped_stale` is a success, not a failure.** Nothing is wrong — the pipeline
  correctly refused to roll a decision back. Sending it to the fail bucket would raise
  alarms for correct behavior and bury real failures.

### What OneTrust does itself (checked against OneTrust's API docs)

- **OneTrust resolves out-of-order receipts by `interactionDate` — answered: yes.**
  OneTrust: receipts "with an earlier Interaction Date than the last date recorded against
  each specific data subject profile, will create a transaction but will not update the
  purpose status." So as long as every receipt carries `interactionDate` (a CPMS rule
  enforced by `onetrust_request.schema.json`), a late Monday opt-in can't overwrite
  Tuesday's opt-out *at OneTrust*.
  **Consequence:** the watermark is a **safety net, not the primary guard**. It's still
  kept because (a) it stops pointless sends of decisions OneTrust would ignore anyway,
  (b) it protects anything OneTrust's rule doesn't cover — it applies to purpose status;
  data elements need `enableDataElementDateValidation`, and the docs don't say what
  happens to a receipt sent *without* a date — and (c) it keeps our own success records
  honest about what was actually applied.
- **Does a partial payload leave other purposes untouched? — only half answered.**
  For `TransactionType: CHANGE_PREFERENCES` OneTrust is explicit: it updates individual
  preference choices "without having to include all existing choices", and you should
  "not include the IDs for items that you are not modifying". For a standard receipt the
  docs don't say whether purposes left out of the receipt are preserved. Still open —
  see **Open items**. Step 3 can drop some items and send the rest, so if a standard
  receipt *replaced* the whole record, that would wipe the dropped purposes.

## Outbound message format (what the dispatcher sends to OneTrust)

Every message on `cpms-sqs-outbound.fifo` is a **complete, ready-to-send HTTP request to
OneTrust's Create Consent Receipts API**. The dispatcher sends `method`/`url`/`headers`/
`body` exactly as given — it doesn't transform anything — so what step 4 validates
is literally what OneTrust receives. Contract: `schemas/onetrust_request.schema.json`,
written from OneTrust's published reference
(https://developer.onetrust.com/onetrust/reference/createconsentreceiptusingpost).

```json
{
  "method": "POST",
  "url": "https://privacyportal.onetrust.com/request/v1/consentreceipts",
  "headers": { "Content-Type": "application/json" },
  "correlationId": "…",
  "body": {
    "identifier": "jane@x.com",
    "identifierType": "Email",
    "requestInformation": "<collection point JWT>",
    "interactionDate": "2026-10-20T10:00:00Z",
    "language": "en-GB",
    "purposes": [
      { "Id": "<purpose UUID>", "TransactionType": "OPT_OUT",
        "Preferences": [ { "TopicId": "<topic UUID>", "TransactionType": "OPT_IN" } ] }
    ]
  }
}
```

**OneTrust facts the format is built around:**
- `identifier` and `requestInformation` are the only fields OneTrust requires.
  `requestInformation` is the **collection point's JWT** (from the collection point's
  Integrations tab, used unaltered) and doubles as the request's authorization.
- A receipt has **one** `interactionDate`, and OneTrust rejects a post that sends it
  together with any other date (`consentDate`, `withdrawnDate`, …).
- At most **20 purposes per receipt** (≤ 10 recommended).
- IDs (`purposes[].Id`, `TopicId`, custom preference `Id`/`OptionId`) are **UUIDs**.
- Topics live **under a purpose** (`purposes[].Preferences[].TopicId`); there is no
  "channel" field — channel-style choices are modelled as **custom preference options**
  (`purposes[].CustomPreferences[]`).
- OneTrust does **no data-type validation** on this API (hence step 4's own validation).

**CPMS rules on top of OneTrust's (enforced by the schema):** `interactionDate` is
required (it's what makes OneTrust ignore out-of-order receipts); every purpose states an
explicit `TransactionType`; at least one purpose per receipt; host must be one of
OneTrust's published `privacyportal*` hosts.

**Canonical → receipt mapping (step 4):**

| Canonical | Receipt |
|---|---|
| `subject.subjectId` | `identifier` |
| `subject.identifierType` `email` | `identifierType: "Email"` |
| item `capturedAt` | `interactionDate` — **one receipt per distinct `capturedAt`**, sent oldest first |
| `provenance.locale` | `language` |
| `header.correlationId` | `correlationId` (envelope only, not sent to OneTrust) |
| `consent[].purposeCode` | `purposes[].Id` via taxonomy `oneTrustPurposeId` |
| consent `status` `opt_in` / `granted` | `TransactionType: "CONFIRMED"` |
| consent `status` `opt_out` | `TransactionType: "OPT_OUT"` |
| consent `status` `withdrawn` | `TransactionType: "WITHDRAWN"` |
| `preferences[]` (topic) | `purposes[<topic's parent purpose>].Preferences[] { TopicId, OPT_IN/OPT_OUT }` — see topic rule below |
| `preferences[]` (channel) | `purposes[…].CustomPreferences[{ Id: <topic's channel preference>, … }]` — `Choices` (explicit in/out per channel option) when the purpose is `CHANGE_PREFERENCES`, otherwise `Options` (opted-in channel options only) |
| purpose carried only because its topics changed | `TransactionType: "CHANGE_PREFERENCES"` |

**Assumed tenant setup (test taxonomy, to confirm):** every topic has a parent purpose;
each topic's channels are a OneTrust *custom preference* with one option per channel. The
taxonomy carries these IDs (`purposeCode`, `oneTrustTopicId`,
`oneTrustChannelPreferenceId`, `oneTrustChannelOptions`) — today as made-up test UUIDs.

**Topic-level rule:** the topic is sent `OPT_IN` if any of its channels is opted in, and
`OPT_OUT` only when **every** channel is present and opted out. Otherwise the topic-level
entry is omitted — e.g. a lone "newsletter by SMS: off" must not switch the whole
newsletter topic off.

**Host and collection point JWT** come from `ONETRUST_HOST` / `ONETRUST_COLLECTION_POINT_JWT`
in `.env.prod` (gitignored), passed to the build Lambda as environment variables at
deploy. Until they're set, a trial host and a dummy JWT are used — fine while requests
are only queued, never sent.

Splitting by `capturedAt` is required, not optional: a receipt can only carry one
`interactionDate`, and stamping older items with a newer date would defeat OneTrust's
out-of-order rule. Receipts with > 20 purposes are split further.

## Authenticating to OneTrust

### How OneTrust authenticates a consent receipt (from OneTrust's API reference)

- **The collection point token is the credential.** Every receipt carries
  `body.requestInformation` — the JWT of a OneTrust *collection point* (copied from the
  collection point's Integrations tab, used unaltered). OneTrust: "In most cases, further
  authorization is not required." There is no separate API key or login for this call.
- **What a collection point is:** OneTrust's record of *where consent was captured* — a
  website form, an app, an API integration. Each has its own token, and each receipt is
  logged against the collection point it came through.
- **Optional signed-JWT check.** OneTrust also accepts an `authorization: Bearer <JWT>`
  header: a JWT *we* sign with a private key, which OneTrust verifies with a public key
  registered in OneTrust. Its `sub` claim must match the receipt's `identifier` (the
  email).

### The risk

The collection point token behaves like a password for that collection point: **anyone
who has it can post receipts — for any email — through that collection point.** What
limits it today: it's scoped to one collection point and that collection point's purposes,
and every receipt is logged against it so misuse is traceable. For OneTrust's own web
collection points the token sits in the public page, so OneTrust doesn't treat it as a
strong secret on its own. For a server-side integration like CPMS, nobody outside needs to
see it — so we can, and should, treat it as one.

### Decisions

- **One API-type collection point per capturing service, not one for all of CPMS.** The
  collection point records where consent was captured, so it should be the service that
  captured it — e.g. **EMO** for Cvent and Kaltura registrations — not CPMS, which only
  relays. CPMS posts receipts *on that service's behalf* with that collection point's
  token. Each collection point is scoped to only the purposes that service collects.
  *(API-type is required anyway: `TransactionType` and `interactionDate` are only
  supported on API collection points.)*
- **Which collection point a receipt uses is decided by `sourceSystem`** (e.g. `emo` →
  the "Vanguard EMO" collection point, `cl6` → "Vanguard CL6"), from a small mapping in config — not hardcoded.
- **Turn on signed-JWT verification** on every CPMS-used collection point (if the OneTrust
  plan offers it). Then a leaked collection point token alone is useless: OneTrust also
  requires a JWT signed by CPMS's private key, with `sub` = the receipt's email.
- **The private signing key lives in AWS KMS** (asymmetric signing key) — it can't be
  exported or copied; the dispatcher asks KMS to sign. OneTrust gets the matching public key.
- **Collection point tokens live in AWS Secrets Manager**, one secret per collection point
  — not in `.env.prod`, Lambda environment variables, the repo, SQS, or S3.
- **Only the dispatcher touches either.** Step 4 does **not** put the real token in the
  receipt: it writes the placeholder `"requestInformation": "{{COLLECTION_POINT_JWT}}"`
  and records which collection point to use. At send time the dispatcher fetches that
  collection point's token from Secrets Manager, swaps it in, signs the
  `authorization` JWT with KMS, and posts. So the token and signature never land in the
  outbound queue, the success records, or the preference form's OneTrust tab.
  Trade-off accepted: the queued message is the final request except for that one
  value, filled in at send time.

### Worked example: EMO as the collection point

The **Vanguard EMO service** captures Cvent and Kaltura registrations and sends them to
CPMS. In OneTrust it is set up as the collection point **"Vanguard EMO"** (API type,
scoped to e.g. `marketing_communications` and `event_communications`).

1. **Capture.** Jane registers for a webinar in Cvent and ticks "newsletter by email". EMO
   picks up the registration and sends CPMS a `source_event` with
   `sourceSystem: "emo"`. *EMO never talks to OneTrust and never holds a OneTrust token.*
2. **Steps 1–3** validate, transform and stale-check it as usual.
3. **Step 4** builds the receipt. From the mapping, `sourceSystem: emo` → collection point `emo`, so
   the outbound message is tagged `collectionPoint: "emo"`, and the body carries
   `"requestInformation": "{{COLLECTION_POINT_JWT}}"` — no real token.
4. **Steps 5–7** queue it and record it. Anyone looking at the queue, the S3 success
   record, or the form's OneTrust tab sees the placeholder, not the token.
5. **Dispatcher** (not built yet) takes the message and:
   - fetches the **EMO** collection point token from Secrets Manager
     (`cpms-secret-onetrust-cp-emo`) and puts it in `requestInformation`;
   - asks KMS (`cpms-kms-onetrust-signing`) to sign a short-lived JWT
     `{ sub: "jane@x.com", iat, exp }` and sends it as `authorization: Bearer …`;
   - POSTs to OneTrust.
6. **OneTrust** checks the token → "this is the Vanguard EMO collection point"; checks the
   signature against CPMS's registered public key → "signed by CPMS"; checks `sub` equals
   `identifier` → "about Jane". Only then does it record the receipt — **under the EMO
   collection point**, so Jane's record shows her consent was captured via EMO.

**If the EMO token leaked:** an attacker could build a receipt with it, but without a JWT
signed by CPMS's KMS key (which can't be extracted), OneTrust rejects it. Without
signed-JWT verification turned on, the same leak would let them write consent for any
email through the EMO collection point — which is why that setting matters.

### Not built yet / to change

- Step 4 still writes the dummy token straight into `requestInformation` and doesn't tag
  `collectionPoint`; `onetrust_request.schema.json` needs a `collectionPoint` envelope
  field and to accept the placeholder. Changes when the dispatcher is built.
- The `sourceSystem` → collection point mapping, the Secrets Manager secrets, the KMS key
  and the dispatcher don't exist yet.

## Updating consent: identify the person, then hand over to OneTrust's preference centre

An existing person changes their preferences **in OneTrust's hosted preference centre**, not
in a page of ours. Our side only works out **who the person is** (their email), asks OneTrust
for that person's **magic link**, and redirects them to it. OneTrust shows their current
settings, records whatever they change, and the consent fanout (`consent_fanout/`: OneTrust →
SFMC, OneTrust → AEP) takes it from there. So no `preference_update` is built or sent by these
pages, and there's no read of current settings on our side.

There are two ways in; they differ only in how the email is found. Each has its own diagram:
`diagrams/Email_Consent_Update.drawio` (marketing email) and
`diagrams/Website_Consent_Update.drawio` (signed-in website user). New consent records from EMO
and CL6 are `diagrams/New_Consent_Record.drawio`.

The one exception is the **one-click unsubscribe** in the email's header (Gmail's own
Unsubscribe button): no page can open there, so it sends a withdrawal straight into CPMS instead
— see **One-click unsubscribe (List-Unsubscribe header)** below.

**From a marketing email (Marketo).**

1. **Email** — the "Manage your preferences" link in a Marketo email points at the intermediate
   app's **Marketo endpoint** and carries the recipient's **pre-encrypted lead ID**, not the lead
   ID itself: `https://<cpms-host>/marketo/preferences?ref={{lead.cpmsPrefRef}}` (see **The email
   link's `ref`** below). The endpoint is what tells the app the `ref` is a Marketo
   pre-encrypted lead ID — there's no "source" parameter to trust or tamper with. Another
   entry point (e.g. a different email platform) would get its own endpoint.
2. **Decrypt** — the intermediate app decrypts `ref` back to the lead ID. A `ref` that wasn't
   made with our key fails to decrypt and goes no further.
3. **Marketo lookup** — lead ID → email:
   `GET https://<munchkin-id>.mktorest.com/rest/v1/lead/<leadId>.json?fields=email,cpmsPrefRef`
   (Marketo REST API, OAuth client-credentials token).
4. **OneTrust magic link** — email → link token (step below).
5. **Redirect** to the magic link.

**From the secure portal (signed-in user).**

1. **Signed in?** The person must have a Vanguard 365 session; if not, they sign in first.
2. **Link** — the page offers a link carrying the person's **local ID** (their CL6 / CRM
   identifier): `…/preferences?localId=CL6-100234`.
3. **CRM lookup** — local ID → email. Only for the signed-in user's own local ID.
4. **OneTrust magic link**, then **redirect**.

**The OneTrust magic link.** OneTrust's *Get Data Subject Token* API —
`GET https://<hostname>/rest/api/consent/v4/datasubjects/linktokens` with header
`identifier: <email>`, OAuth scope `CONSENT` — returns the data subject's link `token` and its
`expiryDate`. The token, URL-encoded, is appended to the preference centre URL to make the
magic link. These APIs are backend-only: the token request happens on our server, never in
the browser.

**Ownership checks.** The email is always worked out on the server, never taken from the
browser. In the portal, the server only resolves a local ID that belongs to the signed-in
user and only issues a magic link for that user's email, so changing the ID in the URL gets
nothing. The email link can't use a session — the person isn't signed in — so it carries
an encrypted value instead of the bare lead ID: lead IDs are sequential numbers, and a bare
one could be edited to get someone else's magic link (and with it their email and
preferences, and the ability to change them).

**The email link's `ref`: a pre-encrypted lead ID.**

Marketo can't encrypt anything when it sends an email (its email scripting has no crypto
functions), so the encrypted value is **made once per lead and stored on the lead** in a
Marketo field, `cpmsPrefRef` (name to confirm). The email just prints the field.

*Making it (once per lead):*
1. A Marketo smart campaign — trigger *Lead is Created* (plus a one-off batch for existing
   leads) — calls a webhook on the intermediate app, `cpms-lambda-pref-ref-issue`, with the
   lead ID.
2. The app encrypts the lead ID with **AES-256-GCM** and returns the result; the webhook's
   *response mapping* writes it into `cpmsPrefRef`. Nothing else is stored anywhere.
3. Format: `v1.<iv>.<ciphertext+tag>`, base64url, about 55 characters — safe in a URL as is.
   - `v1` — key version, so the key can be rotated.
   - `iv` — 12 random bytes, new for every encryption (never reused with the same key).
   - plaintext — the lead ID; additional authenticated data `cpms-pref-ref:v1`, so a value
     encrypted with the same key for any other purpose can't be passed off as a `ref`.
   - the 16-byte GCM tag makes any edit to the value fail decryption.
4. The webhook endpoint must only accept Marketo: a shared secret in a custom header (held
   in Secrets Manager) plus Marketo's IP ranges. Otherwise anyone could ask it to encrypt any
   lead ID and mint a valid `ref` — the same hole as a bare lead ID.

*Reading it (every click) — what the intermediate app, `cpms-lambda-pref-redirect`, does on
`GET /marketo/preferences`:*
1. Take `ref` from the query string. Reject anything missing, longer than ~200 characters
   or not shaped `v<n>.<base64url>.<base64url>` before doing any work.
2. Pick the key for that version (`v1` → current key; during a rotation the previous key is
   kept too). Unknown version → reject.
3. AES-256-GCM decrypt with that key, the `iv`, and the additional data `cpms-pref-ref:v<n>`.
   If the tag doesn't verify, the value was forged or edited → reject.
4. The plaintext must be a numeric lead ID; otherwise reject.
5. Marketo *Get Lead by Id*, asking for `email` and `cpmsPrefRef`. No lead → reject. If the
   lead's stored `cpmsPrefRef` isn't the one presented, the link has been revoked → reject.
   (Revoking one person's links = issuing them a new `cpmsPrefRef`.)
6. OneTrust magic link for that email, then redirect.

Every rejection shows the same generic "this link is invalid or has expired" page — never
which check failed — and is counted, so a run of failures (someone guessing) shows up. Never
log the `ref`, the lead ID or the email together in plain text.

*The key:*
- 256-bit, in Secrets Manager as `cpms-secret-pref-ref-key`, holding the current version and
  any previous ones still accepted. Only the two intermediate-app Lambdas can read it; the
  apps cache it in memory.
- **Rotation:** add `v2`, issue new `ref`s with it, re-encrypt every lead's `cpmsPrefRef` in a
  batch, and keep accepting `v1` until emails sent with it are old enough not to matter
  (e.g. 12 months), then drop it.

**Stubs in the test app** (`web/`, "Secure portal" and "Email Unsubscribe"):
- **Stub CRM** — a local JSON file, `web/data/stub-crm.json` (git-ignored: it holds email
  addresses), mapping local ID ↔ email, name, company. Every registration sent from the EMO
  or CL6 page adds its person if new, with the next local ID (`CL6-100235`, …); it starts
  with one demo user (`dheeraj.saxena@kwantsolutions.co.uk`, `CL6-100234`).
- **Stub Marketo** — `web/data/stub-marketo.json` (git-ignored): lead ID, email and
  `cpmsPrefRef`. Every CRM person is also a lead, given the next lead ID (from `1000001`) the
  first time it's needed, with its `cpmsPrefRef` issued at the same time (standing in for the
  *Lead is Created* webhook; leads without one get it on load, like the one-off batch).
- **`ref` key** — `web/data/pref-ref-key.json` (git-ignored, created on first use) stands in
  for `cpms-secret-pref-ref-key`. The sample email's link carries the real encrypted `ref`, and
  the click path decrypts it and checks it against the lead's stored value, as described above.
- **Stub OneTrust link tokens** — one random token per email, valid a year, kept in memory
  (a restart issues new ones).
- **Stand-in preference centre** — with no OneTrust tenant connected, the magic link opens a
  local page (`#/onetrust?token=…`) that shows whose link it is and until when. A real
  tenant's preference centre URL replaces it.
- **Sign-in** — simulated: any email in the stub CRM, no password (an unknown email gets
  "No account found… register first"); an in-memory session cookie.

### One-click unsubscribe (List-Unsubscribe header)

Gmail and Yahoo show their own **Unsubscribe** button next to the sender when an email carries
the RFC 8058 headers, and since February 2024 they **require** it from bulk senders (over 5,000
a day to Gmail), honoured within **2 days**. Leaving it out risks throttling and the spam
folder for the whole sending domain, and pushes people who want out to "Report spam" instead.

**Why it can't use the magic link.** When the person clicks, Gmail's *servers* send
`POST <List-Unsubscribe URL>` with the form body `List-Unsubscribe=One-Click` — not the
browser. No cookie, no redirect followed, nothing shown. So there's no preference centre to
hand over to: the endpoint must do the opt-out itself and answer `200`. This is the one
update path that **sends a source event into CPMS**, like EMO and CL6 do — CPMS is the source
here. Diagram: `diagrams/Email_OneClick_Unsubscribe.drawio`.

**The headers** Marketo adds to every marketing email, covered by its DKIM signature (Gmail
ignores them otherwise):

```
List-Unsubscribe: <https://<cpms-host>/marketo/unsubscribe?ref={{lead.cpmsPrefRef}}>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

The `ref` is the **same `cpmsPrefRef`** as the body link — already unguessable, revocable and
stored on the lead — so there's no new token. The body link stays: Gmail doesn't always show
its button, and people who want to adjust rather than leave still get the preference centre.

**What `POST /marketo/unsubscribe` does** (`cpms-lambda-oneclick-unsub`, a route on
`cpms-apigw-router`; not built):
1. Body must be `List-Unsubscribe=One-Click`; anything else → `400`. POST only, so link
   scanners and antivirus tools that fetch URLs can't unsubscribe anyone.
2. Validate and decrypt `ref`, then Marketo *Get Lead by Id* with the `cpmsPrefRef` match —
   exactly the checks in **The email link's `ref`** above.
3. Publish a standard `source_event` to `cpms-eventbus-consent`: `eventType: email_unsubscribe`,
   `sourceSystem: email_oneclick`, `consent[] = marketing_communications · withdrawn`,
   `captureMethod: list_unsubscribe_one_click`, `captureChannel: email`.
4. Answer `200` straight away. The rest is asynchronous.

From the bus on, it's the **unchanged pipeline**: the rule already takes any `cpms.*` source,
a withdrawn purpose already turns off its topics (step 2), and step 4 builds a receipt with
`TransactionType: WITHDRAWN`. The consent fanout then carries it back to Marketo.

**In the test app** — "Email Unsubscribe (Header)" shows the Marketo email as Gmail would, with
the headers. Its Unsubscribe button makes the same POST to the local server's
`/api/marketo/unsubscribe`, which stands in for the Lambda: it uses the stub Marketo and
`ref` key, and puts a **real** event on the AWS bus, so the page shows the OneTrust receipt
CPMS generated.

Open points are under **Open items**.

## Error handling rules

- **DLQ is reserved for network/connectivity failures only** (e.g. SQS calls timing out
  or being throttled), and only after retries are exhausted. A DLQ implies "retry later
  might succeed" — true for infra failures, not for data failures.
- **Data/logic failures** (source schema/content validation, transform or its canonical
  check, receipt build or its OneTrust-schema check) will fail identically on retry, so they do **not**
  go to the DLQ. Instead: write the record + error detail to the **S3 fail-bucket** and
  raise a **CloudWatch alarm** (custom metric).
- **Every successful run** writes a record to the **S3 success-bucket**.
- No separate idempotency / dedup step. Reprocessing the same event is harmless **because
  of the watermark** (step 3): its items have `capturedAt` ≤ the stored value, so the run
  ends as `skipped_stale`. (Previously this claimed upsert alone made replays harmless —
  that's only true if nothing newer was sent in between; a late replay would roll the
  newer decision back. See **Out-of-order arrival**.) The remaining risk is an event
  never being processed at all (EventBridge rule/target failure, Step Function failing
  to start, unhandled state error) — mitigated by a DLQ on the EventBridge rule itself
  plus `Catch` blocks on every state.
- `skipped_stale` runs go to the **success-bucket**, not the fail-bucket, and raise no
  alarm.
- **How a run's outcome maps to SQS retry** (the FIFO consumer waits on every run):
  - **Data/logic failure** (event rejected, or a bug in one of our Lambdas) → the state
    machine writes the fail record, emits the failure metric, and **ends SUCCEEDED** with
    `outcome: "rejected"`. The consumer acknowledges the message — retrying would fail
    the same way, and would block that email's FIFO line meanwhile.
  - **AWS-side failure** (Lambda service errors/throttling after retries, S3 write for
    the fail record failing) → the run ends **FAILED** (`InfraFailure`). The consumer
    raises, SQS retries the message, and after 5 receives moves it to the ingestion DLQ.
  - A failure-metric write failing does **not** fail the run: the fail record is
    already written, so re-running the event would only duplicate it.

## Naming convention

Every AWS component is named **`cpms-<component type>-<purpose>`** — lowercase,
hyphen-separated. The type segment makes a resource's kind obvious from its name alone
(in the console, logs, IAM policies, billing), and the shared `cpms-` prefix lets IAM
policies scope to `cpms-*` and makes every project resource easy to find.

| Type segment | AWS resource |
|---|---|
| `eventbus` | EventBridge bus |
| `rule` | EventBridge rule |
| `sqs` | SQS queue (FIFO queues must also end in `.fifo` — an AWS requirement) |
| `lambda` | Lambda function |
| `sfn` | Step Functions state machine |
| `role` | IAM role (`cpms-role-<name of what assumes it>`) |
| `alarm` | CloudWatch alarm |
| `secret` | Secrets Manager secret |
| `kms` | KMS key (alias) |
| `layer` | Lambda layer |
| `elasticache` | ElastiCache cluster (prod only) |
| `vpc` | VPC (prod only) |

S3 is the exception: no new buckets are created (see **Development environment**), so
S3 "components" are `cpms/<store>/` prefixes inside the existing bucket.

**Names for this flow:**

| Component | Name |
|---|---|
| Event bus | `cpms-eventbus-consent` |
| Rule (all events → ingestion queue) | `cpms-rule-ingest` |
| Rule DLQ | `cpms-sqs-rule-dlq` |
| Ingestion FIFO queue | `cpms-sqs-ingestion.fifo` |
| Ingestion DLQ | `cpms-sqs-ingestion-dlq.fifo` |
| FIFO consumer | `cpms-lambda-fifo-consumer` |
| State machine | `cpms-sfn-consent-sync` |
| Step 1 — validate source event | `cpms-lambda-validate-source` |
| Step 2 — transform to canonical (+ validate it) | `cpms-lambda-transform-canonical` |
| Step 3 — filter stale items | `cpms-lambda-filter-stale` |
| Step 4 — build OneTrust receipts (+ validate them) | `cpms-lambda-build-payload` |
| Step 5 — enqueue | *(native Step Functions SQS integration — no Lambda)* |
| Step 6 — advance watermark | `cpms-lambda-advance-watermark` |
| Step 7 — write success record | *(native Step Functions S3 integration — no Lambda)* |
| Outbound FIFO queue | `cpms-sqs-outbound.fifo` |
| Outbound DLQ | `cpms-sqs-outbound-dlq.fifo` |
| Failure alarm | `cpms-alarm-failures` |
| Collection point token (one per collection point) | `cpms-secret-onetrust-cp-<collection point>`, e.g. `cpms-secret-onetrust-cp-emo` |
| Receipt signing key | `cpms-kms-onetrust-signing` (alias) |
| Dispatcher | `cpms-lambda-dispatcher` |
| Email-link `ref` issuer (Marketo webhook; not built) | `cpms-lambda-pref-ref-issue` |
| Email-link handler behind `GET /marketo/preferences`: decrypt → Marketo → OneTrust magic link → redirect (not built) | `cpms-lambda-pref-redirect` |
| One-click unsubscribe handler behind `POST /marketo/unsubscribe`: decrypt → Marketo → withdrawn source_event (not built) | `cpms-lambda-oneclick-unsub` |
| Email-link `ref` key | `cpms-secret-pref-ref-key` |
| Marketo webhook shared secret | `cpms-secret-marketo-webhook` |
| Taxonomy updater (prod only) | `cpms-lambda-taxonomy-updater` |
| Taxonomy cache (prod only) | `cpms-elasticache-taxonomy` |
| VPC (prod only) | `cpms-vpc` |
| Shared code layer (template stacks only) | `cpms-layer-shared` |

Each Lambda / the state machine gets its own role, `cpms-role-<its name minus cpms->`,
e.g. `cpms-role-lambda-validate-source`, `cpms-role-sfn-consent-sync`.

## Development environment

Dev deliberately runs a slimmer version of the design above, to avoid standing up
networking and extra storage before the flow is proven.

- **One S3 bucket for everything.** Dev uses the existing project bucket
  (`AWS_BUCKET_NAME` in `.env.prod`) — no additional buckets. Every store this design
  describes as a separate bucket is a **prefix** inside it, all under `cpms/`:

  | Store | Dev location |
  |---|---|
  | Schema store | `cpms/schemas/<schema_name>/<version>/<schema_name>.schema.json` |
  | Taxonomy file | `cpms/taxonomy/taxonomy.json` |
  | Watermarks | `cpms/watermarks/<sha256(subjectId)>.json` |
  | Success records | `cpms/success/<eventId>/<run>.json` |
  | Fail records | `cpms/fail/<eventId>/<run>.json` |

- **Schemas are versioned by path.** The validation Lambdas load the schema matching the
  event's `schemaVersion` (e.g. `cpms/schemas/source_event/1.0/…`), so a new contract
  version can be published alongside the old one. The repo stays the source of truth;
  `deploy/upload_assets.py` pushes `schemas/` and `taxonomy/` to S3 and is re-run after any
  change.
- **No ElastiCache, no VPC.** Steps 1 and 4 read `cpms/taxonomy/taxonomy.json` straight
  from S3 on **every invocation** — no in-memory caching across invocations. That keeps
  the property the Redis design exists for: a taxonomy change is visible to the very next
  event, because there is no warm-Lambda copy to go stale. The cost is one extra S3 GET
  (~20–50 ms) per taxonomy-dependent step, which is irrelevant at dev volumes. No
  updater Lambda or S3 change notification is needed in dev either.
- **Prod** keeps the Redis read path (and therefore the VPC) described in **Taxonomy
  reference** above, for latency and request volume — revisit whether it's actually
  needed once real volumes are known.

## Open items / not yet decided

- Schema store: **S3 file (decided)** — see **Development environment**. EventBridge
  Schema Registry not used.
- Dispatcher that will eventually read the SQS queue and call the real OneTrust API —
  not yet designed.
- ~~Does OneTrust resolve conflicts by interaction date?~~ **Answered: yes**, when
  `interactionDate` is sent — see **Out-of-order arrival → What OneTrust does itself**.
- **Does a standard (non-`CHANGE_PREFERENCES`) receipt leave purposes it doesn't list
  untouched?** Not stated in OneTrust's docs. Hard dependency of step 3 dropping some
  items — confirm with OneTrust or test against a trial tenant
  (`privacyportaltrial.onetrust.com`). If it doesn't, step 4 must use
  `CHANGE_PREFERENCES` for partial updates.
- **Real OneTrust IDs.** The taxonomy's `oneTrustPurposeId`/`oneTrustTopicId`/
  `oneTrustChannelId` values (`PC-1001`, …) are placeholders; OneTrust requires UUIDs from
  the tenant. Step 4's validation will (correctly) reject every receipt until they're replaced.
- **Collection points — decided in principle** (one API-type collection point per
  capturing service, e.g. EMO; tokens in Secrets Manager; dispatcher injects them — see
  **Authenticating to OneTrust**). Still to confirm with someone with OneTrust access:
  (a) does the OneTrust plan support signed-JWT (`authorization` header) verification on
  collection points, and how is it switched on; (b) can a collection point token be
  revoked/regenerated if it leaks; (c) the final list of capturing services and which
  `sourceSystem`s map to each.
- **How topics and channels are configured in OneTrust.** Built against an *assumed*
  setup (topic → parent purpose; channels as one custom preference per topic, one option
  per channel — see **Outbound message format**). Confirm against the tenant; if it
  differs, step 4's mapping changes.
- **Which purpose `TransactionType` to send for a preference-only receipt** (topics
  changed, purpose consent itself unchanged) — likely `CHANGE_PREFERENCES`; confirm.
- ~~Update form (existing users)~~ — **resolved**: no form of ours. Both the secure portal
  and the email link identify the person and redirect to OneTrust's preference centre via
  a magic link (see **Updating consent**).
- ~~The email link carries a bare Marketo lead ID~~ — **decided**: the link carries a
  pre-encrypted lead ID (`cpmsPrefRef`, AES-256-GCM) that the intermediate app decrypts
  (see **The email link's `ref`**). Still to settle: the Marketo field name and who creates
  it; the webhook's shared-secret header and IP allowlist; how long a retired key version
  keeps being accepted; and whether `ref` should also carry an issue date so very old links
  can be refused.
- **Magic link details to confirm with OneTrust:** the preference centre URL and the exact
  magic-link format; what *Get Data Subject Token* returns for someone who has no token yet
  (its docs only list 404) — e.g. whether receipts must be sent with the flag that generates
  an instant link token; token lifetime (the docs mention a year); and whether one token per
  person is reused or a new one issued per request.
- **Marketo and CRM API access** — credentials (Marketo REST client ID/secret, CRM API) for
  the lookups, held server-side only.
- **Which purposes does an EMO event registration grant?** Assumed `marketing_communications`
  (the page's marketing statement) + `event_communications` (communications about the
  event itself). Confirm, and confirm the **legal basis**: marketing consent that comes
  bundled with registration may not count as freely-given *consent* under UK GDPR; for
  professional advisers at firms Vanguard may rely on **legitimate interest** instead.
  The taxonomy's `legalBasis` must say whichever applies — it's what OneTrust records.
  Privacy/legal decision.
- **Which purposes does an account registration grant?** Assumed
  `marketing_communications` only, with `sourceSystem: cl6`. Same legal-basis question as
  above for the bundled marketing. Also: the tick covers **three** documents (privacy
  policy, IP agreement, T&Cs) but `provenance.policyVersion` holds one version — decide
  whether to record all three versions.
- **Record which event someone registered for?** The `source_event` has no field for the
  specific event/webinar. Add an optional one if OneTrust or the records should show
  "registered for Autumn Budget 2026 briefing".
- **Policy version** — the registration page doesn't show one; EMO must supply the agreed
  privacy-policy version for `provenance.policyVersion`.
- **Topic chosen at registration → also consent to its parent purpose?** Today a
  registration's topic choices are sent under `TransactionType: CHANGE_PREFERENCES`
  (records the preference only). If ticking "newsletter by email" at sign-up should also
  count as consent to `marketing_communications`, step 4 should send that purpose as `CONFIRMED`
  instead — business/legal decision.
- ~~Withdrawing a purpose vs its topics~~ — **moot for our pages**: preferences are now
  changed in OneTrust's preference centre, so how purposes and topics behave there is
  OneTrust configuration. Step 2 still derives topic opt-outs from a purpose withdrawal for
  sources that send one.
- **One-click unsubscribe (List-Unsubscribe header)** — see **One-click unsubscribe**.
  Still to settle: (a) whether Marketo lets every marketing email carry *our*
  `List-Unsubscribe` URL instead of its own; (b) what the header unsubscribes from — assumed
  all of `marketing_communications`; a per-topic opt-out would need the topic in the URL;
  (c) the **2-day deadline**: Marketo only stops sending once the withdrawal has gone
  CPMS → OneTrust → fanout → Marketo, and OneTrust receipts are queued, not sent, until we have
  API access — so a direct Marketo suppression from the Lambda may be needed meanwhile;
  (d) its own collection point ("Vanguard Email One-Click") — the `sourceSystem` →
  collection point mapping isn't built yet, so it uses the single configured JWT today.
- **Should reminders for events someone registered for survive "opt out of all"?** Today the
  full opt-out withdraws `event_communications` too (it covers every purpose). If
  registered-event reminders are service messages that must continue, they need to move
  out of the preference centre's purposes (now configured in OneTrust).
- **Receipts sent without `interactionDate`** — OneTrust's docs don't say how those are
  ordered. Moot for CPMS (the schema makes it required) but relevant if anything else
  posts to the same collection point.
