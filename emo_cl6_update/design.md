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
  "marketing_email"` → `legalBasis: "consent"`.
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
   - All items dropped → run ends as **`skipped_stale`** (recorded by step 7 once built).
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
   - Write record to `cpms/success/`: event, canonical record, OneTrust request(s),
     timestamp, and status (`sent` or `skipped_stale`, plus any items dropped as stale).

**Fail path (shared by every data/logic failure).** Each step's failure first passes
through a small state that sets `failedStep` (`ValidateSource`, `TransformCanonical`,
`BuildPayload`, …), then joins one shared path: write `cpms/fail/<run>.json` (the whole
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

Concrete failure: user opts **in** to `marketing_email` on Monday via Cvent, opts **out**
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
  "purpose#marketing_email": { "capturedAt": "2026-10-20T09:15:00Z", "eventId": "..." },
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
  `marketing_email` decision and an *older* `event_communications` one. A single
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
| Step 7 — write success record | `cpms-lambda-write-success` |
| Outbound FIFO queue | `cpms-sqs-outbound.fifo` |
| Outbound DLQ | `cpms-sqs-outbound-dlq.fifo` |
| Failure alarm | `cpms-alarm-failures` |
| Taxonomy updater (prod only) | `cpms-lambda-taxonomy-updater` |
| Taxonomy cache (prod only) | `cpms-elasticache-taxonomy` |
| VPC (prod only) | `cpms-vpc` |

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
  | Success records | `cpms/success/…` |
  | Fail records | `cpms/fail/…` |

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
- **Collection point(s) and their JWT.** Which OneTrust collection point(s) receive CPMS
  receipts — one for all sources, or one per source — and where step 4 reads the JWT from
  (it shouldn't live in the repo). Collection point must be **API-type**:
  `TransactionType` and `interactionDate` are only supported there.
- **How topics and channels are configured in OneTrust.** Built against an *assumed*
  setup (topic → parent purpose; channels as one custom preference per topic, one option
  per channel — see **Outbound message format**). Confirm against the tenant; if it
  differs, step 4's mapping changes.
- **Which purpose `TransactionType` to send for a preference-only receipt** (topics
  changed, purpose consent itself unchanged) — likely `CHANGE_PREFERENCES`; confirm.
- **Receipts sent without `interactionDate`** — OneTrust's docs don't say how those are
  ordered. Moot for CPMS (the schema makes it required) but relevant if anything else
  posts to the same collection point.
