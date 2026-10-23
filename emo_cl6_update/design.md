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
Source system --> EventBridge --> Router --> Ingestion FIFO queue (MessageGroupId=subjectId)
                                           --> FIFO consumer Lambda
                                           --> Express Step Function (per source, synchronous)
```

- Sources publish events into EventBridge.
- A router decides which Step Function to invoke based on the event.
- EventBridge does **not** target the Step Function directly — it targets an **ingestion
  FIFO SQS queue** instead. See **Ordering guarantee** below for why.
- The Step Function validates, transforms, builds the OneTrust payload, and enqueues it
  (to a second, outbound FIFO queue).
- No "does a record already exist" check and no create/update branch — see
  **Create vs. update: decided against** below. OneTrust's own upsert handles it.

## Schemas

### `schemas/source_event.schema.json` — what sources send

Deliberately minimal so source owners have a low integration bar, but still carries real
consent and provenance data (not deferred to later).

```
{
  schemaVersion, eventId, eventType, sourceSystem, occurredAt,
  subject:     { identifierType, identifierValue },
  consent:     [ { purpose, status, capturedAt, captureMethod } ],
  provenance:  { sourceEventId, captureChannel, locale?, policyVersion?, correlationId? }
}
```

- `eventType` distinguishes flows (e.g. `event_registration`, `account_registration`)
  without needing a separate schema per flow.
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
  header:      { schemaVersion, eventId, eventType, sourceSystem, correlationId, processedAt },
  subject:     { subjectId, identifierType },
  consent:     [ { purposeCode, status, capturedAt, legalBasis? } ],
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

## Step Function states

1. **Validate source event** — two sub-checks, same step, same fail path:
   - **1a. Structural (JSON Schema)** — required fields, types, `status` enum,
     `format: date-time`, conditional format rules (e.g. `identifierType: "email"` →
     `identifierValue` must match an email pattern, via `if/then`).
   - **1b. Content validation** — `purposeCode`/`topicCode`/`channel` checked against the
     Redis taxonomy cache (not left for later steps); timestamp sanity (not in the future,
     not absurdly old). Catches "correct format, garbage data" — e.g. a structurally valid
     but unknown/nonexistent purpose code — right here instead of letting it flow further
     downstream.
   - Lambda returns `{ valid, errors }`, does not throw on a failed validation (expected
     business outcome, not an exception).
   - Failure → **fail path**: S3 fail-bucket + CloudWatch alarm, with `errors` recorded.

2. **Transform to canonical model**
   - Lambda applies **one universal mapping** — not per-source logic. Every source
     already conforms to the single `source_event` schema, so there's exactly one
     function, not N source-specific ones.
   - This step is still real work, not a pass-through, because canonical is a
     **different, richer shape** than `source_event`, not a renamed copy of it:
     - `preferences[]` doesn't exist in `source_event` at all — built from scratch here.
     - `legalBasis` is **derived** from `purposeCode` via the taxonomy mapping — no
       source sends it.
     - `header`/`provenance` get restructured (`correlationId` moves, `processedAt` is
       stamped here).
   - Logic failure → fail path.

3. **Validate canonical object**
   - Schema check against the canonical contract.
   - Failure → fail path.

4. **Build OneTrust payload**
   - Lambda generates the OneTrust-shaped request body as a single **upsert**, using the
     Redis taxonomy mapping to translate `purposeCode`/`topicCode`/`channel` → OneTrust IDs.
   - No create/update branching (see below) — one payload shape, always.
   - Logic failure → fail path.

5. **Validate generated OneTrust payload**
   - Check the generated payload against OneTrust's published API schema before queueing.
   - Failure → fail path.

6. **Enqueue request**
   - Step Functions native SQS `SendMessage` integration, to the **outbound FIFO queue**,
     `MessageGroupId = subjectId`.
   - Message: `{ method, url, headers, body, correlationId }`.
   - Network/throttle failure → `Retry` with backoff → `Catch` → DLQ.

7. **Write success record**
   - Write record to S3 success-bucket: event, canonical payload, OneTrust payload,
     timestamp.

8. **Succeed.**

## Why steps 1, 2 and 3 are separate (not one combined Lambda)

This gets asked first, every time, so it's recorded here explicitly.

All sources send the identical `source_event` envelope — there is no per-source variant.
Given that, it's a fair question why validation (1), transform (2), and canonical
validation (3) aren't just one Lambda that validates-and-maps in a single pass, since
step 1 already has to parse the same fields step 2 would map.

**They *could* be merged — nothing technical prevents it.** The reason they're kept
separate is fault isolation, specifically to distinguish three different failure causes
that would otherwise all surface as "the one combined step failed":

| Step | Failure means | Caused by |
|---|---|---|
| 1 | The **source** sent bad data | A bug or bad input on the source team's side |
| 2/3 | **Our transform logic** is wrong | A bug in code this team owns (e.g. a taxonomy lookup silently returning nothing, a missing field mapping for one `eventType`) |

With separate steps, "which step failed" alone tells you which of those it is, from the
Step Function execution history, with no digging into error payloads. Merge them, and
both failure modes surface from the same step — you'd have to read the Lambda's returned
error reason instead of just seeing which step is red.

**This is a deliberate tradeoff, not a hard requirement.** Collapsing validate (1) +
transform (2) + validate-canonical (3) into a single Lambda is a legitimate
simplification if the extra Step Function hops (cost, latency, orchestration overhead)
aren't worth that instant fault attribution. As designed today, they're kept separate for
that reason; revisit here if that tradeoff stops being worth it.

## Create vs. update: decided against

Originally designed a DynamoDB existence-lookup (`subjectId → oneTrustRecordId`) plus a
`Choice` branch to decide create vs. update. **Removed.** Reasoning: OneTrust's own API
performs an upsert — sending a new payload for an existing subject simply overrides the
prior record. We don't need to ask "does this exist" first; we just need the *order* of
events for the same subject preserved, so an older event can't overwrite a newer one.
That ordering requirement is what the next section (**Ordering guarantee**) solves.

## Ordering guarantee: FIFO queue before the Step Function, not just after it

**Why a direct EventBridge → Step Function target breaks ordering.** EventBridge can
target a Step Function execution directly (`StartExecution` is a native target type) —
but if it did, two events for the same subject would spawn two *independent, concurrently
running* Step Function executions. Each execution runs through 5+ Lambda calls (validate,
transform, canonical validate, build payload, validate payload), each with its own
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
  completes before a newer one's begins; the **outbound** queue (step 6) prevents the
  eventual dispatcher from reordering messages when it actually calls OneTrust (e.g. if
  the dispatcher runs multiple concurrent workers).

## Error handling rules

- **DLQ is reserved for network/connectivity failures only** (e.g. SQS calls timing out
  or being throttled), and only after retries are exhausted. A DLQ implies "retry later
  might succeed" — true for infra failures, not for data failures.
- **Data/logic failures** (schema validation, content validation, canonical validation,
  payload build, payload validation) will fail identically on retry, so they do **not**
  go to the DLQ. Instead: write the record + error detail to the **S3 fail-bucket** and
  raise a **CloudWatch alarm** (custom metric).
- **Every successful run** writes a record to the **S3 success-bucket**.
- No idempotency check / dedup step. Reprocessing the same event twice is harmless —
  it just writes the same OneTrust payload again (upsert). The actual risk is an event
  never being processed at all (EventBridge rule/target failure, Step Function failing
  to start, unhandled state error) — mitigated by a DLQ on the EventBridge rule itself
  plus `Catch` blocks on every state, not by deduping.

## Open items / not yet decided

- Schema registry mechanism for source schemas (S3 file vs. EventBridge Schema Registry)
  — not finalized.
- Dispatcher that will eventually read the SQS queue and call the real OneTrust API —
  not yet designed.
- Router logic for selecting which Step Function to invoke per source — not yet designed.
