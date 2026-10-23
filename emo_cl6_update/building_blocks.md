# OneTrust Integration System — Building Blocks

Inventory of infrastructure components. For *why* decisions were made this way, see
`design.md`. This file is just the parts list. AWS resource names follow
`cpms-<component type>-<purpose>` — the full name for every block is in `design.md` →
"Naming convention".

## Event ingestion

| Block | Type | What it does |
|---|---|---|
| Source event bus | EventBridge custom bus `cpms-eventbus-consent` | Entry point. Every source (portal, Cvent, Kaltura, etc.) publishes events here. |
| EventBridge rule | EventBridge rule | Sends **every** source event to the ingestion FIFO queue — no per-source routing (one Step Function serves all sources). Targets the queue, **not** the Step Function directly — see `design.md` → "Ordering guarantee" for why. Sets the FIFO target's `MessageGroupId` per event with a **dynamic JSON path**, `$.detail.subject.identifierValue` (the email) — no Lambda needed in between. EventBridge constraints: the whole value must be the path (no prefix/suffix text), it can't use input-transformed values (so it **can't lowercase** — sources must send the email already lowercased), and the resolved value must be ≤ 100 chars. |
| EventBridge rule DLQ | SQS (EventBridge rule DLQ) | Catches events that fail to even reach the ingestion queue (target invocation failure, throttling) — the one gap not covered by in-Step-Function error handling. |

## Ordering (per-subject FIFO)

| Block | Type | What it does |
|---|---|---|
| Ingestion FIFO queue | SQS FIFO, `MessageGroupId` = email | **What `MessageGroupId` is:** a label on each message saying which "line" it belongs to. SQS releases messages with the same label strictly in order, one at a time (the next isn't handed out until the previous is fully processed); messages with different labels are processed in parallel. Labelling by email means one person's events can never overtake each other, while different people never wait on each other. A single fixed label would force every event for everyone through one line. Settings: content-based deduplication on (EventBridge supplies no dedup ID), high-throughput mode (dedup + throughput limits per message group), visibility timeout 6× the consumer Lambda timeout, redrive to the ingestion DLQ after 5 receives. Created by `deploy/setup_ingestion.py`. Sits between EventBridge and the Step Function. Serializes processing per subject so an older event's full run (including the outbound enqueue) completes before a newer event for the same subject starts. Without this, variable Step Function execution latency can let a newer event finish — and enqueue — before an older one, causing the older payload to overwrite the newer one at OneTrust. |
| Ingestion DLQ | SQS FIFO `cpms-sqs-ingestion-dlq.fifo` | Receives a message after it has failed processing 5 times (e.g. consumer Lambda crashing or timing out), so one stuck event can't block that email's line forever. Must be FIFO because its source queue is FIFO. |
| FIFO consumer | Lambda, SQS event source mapping (batch size 1) | Consumes the ingestion FIFO queue. Calls `StartSyncExecution` and **blocks until the Step Function run completes** before acknowledging the message — this is what actually enforces one-in-flight-execution-per-subject, not just the queue's existence. Raises (→ SQS retry, DLQ after 5) only when the run itself FAILED; a rejected event ends SUCCEEDED and is acknowledged. `cpms-lambda-fifo-consumer`, code in `lambdas/fifo_consumer/`, created by `deploy/setup_processing.py`. |

## Orchestration — Step Function (single, all sources)

| Block | Type | What it does |
|---|---|---|
| Consent sync workflow | **Express** Step Functions state machine (not Standard — required for `StartSyncExecution`) | Orchestrates steps 1–7 from `design.md`. `cpms-sfn-consent-sync`. **One state machine for all sources** — see `design.md` → "One Step Function for all sources". Invoked synchronously by the FIFO consumer Lambda. |
| Validate source event | Lambda | Step 1. Structural (JSON Schema) + content validation (taxonomy codes via Redis, timestamp sanity). Returns `{ valid, errors }`. Failure here means **the source sent bad data**. Dev: reads schema (by `schemaVersion`) and taxonomy from `cpms/` in S3 on every invocation. `cpms-lambda-validate-source`, code in `lambdas/validate_source/`. |
| Transform to canonical | Lambda | Step 2. **One universal mapping** (not per-source — every source conforms to the single `source_event` schema). Maps `preferences[]` from the source event's `preferences[]`, derives `legalBasis` from `purposeCode`, restructures `header`/`provenance`, carries `occurredAt`/`captureMethod`, defaults `correlationId` to `eventId`, normalizes `identifierType`. **Validates its own output** against `canonical_consent.schema.json` before returning. Raises on anything unexpected or off-contract (= our bug). `cpms-lambda-transform-canonical`, code in `lambdas/transform_canonical/`. |
| Filter stale items | Lambda | Step 3. Reads the subject's watermark object from the watermark bucket (keeps ETag), drops consent/preference items with `capturedAt` ≤ the stored value. All dropped → run ends as `skipped_stale`. `cpms-lambda-filter-stale`, code in `lambdas/filter_stale/`. |
| Build OneTrust receipts | Lambda | Step 4. Turns the stale-filtered canonical record into complete OneTrust Consent Receipt requests — one per distinct `capturedAt` (a receipt has a single `interactionDate`), ≤ 20 purposes each — translating codes → OneTrust UUIDs via the taxonomy. **Validates every request it built** against `schemas/onetrust_request.schema.json` before returning — the only check before OneTrust, since OneTrust's API does no data-type validation. Mapping in `design.md` → "Outbound message format". `cpms-lambda-build-payload`, code in `lambdas/build_payload/`. Host + collection point JWT from `.env.prod` (dummy until set). |
| Enqueue request | Step Functions `Map` (MaxConcurrency 1) + native SQS integration | Step 5. `SendMessage` directly from the state machine — no Lambda — one message per request, strictly in order, to `cpms-sqs-outbound.fifo`, `MessageGroupId = subjectId`. Failure after retries fails the run (SQS retries the event). |
| Advance watermark | Lambda | Step 6. After a successful enqueue, merges the sent items' `capturedAt` into the watermark object via conditional `PutObject` (`If-Match` ETag / `If-None-Match: *`); re-reads and retries on 412. Merge is monotonic (never moves a watermark back). `cpms-lambda-advance-watermark`, code in `lambdas/advance_watermark/`; shares `lambdas/shared/watermark.py` with step 3. |
| Write success record | Step Functions native S3 integration | Step 7. Writes the run's full state + outcome (`sent` / `skipped_stale`) to `cpms/success/<eventId>/<run>.json` — no Lambda. Keyed by eventId so results can be looked up from the event. |

## Taxonomy reference + cache

**Dev:** only the taxonomy file exists — Lambdas read it straight from S3 each invocation. The notification, updater, and Redis rows below are **prod only** (see `design.md` → "Development environment").

| Block | Type | What it does |
|---|---|---|
| Taxonomy file | S3 object | Source of truth for valid `purposeCode`/`topicCode`/`channel` values and their mapping to OneTrust IDs. Reviewable, versioned. |
| Taxonomy change notification | S3 event notification | Fires on object update, triggers the updater Lambda. |
| Taxonomy cache updater | Lambda | Reads the updated taxonomy file from S3, writes it into Redis (Sets/mapping). The only thing that writes to the cache. |
| Taxonomy cache | ElastiCache (Redis) | Shared, always-current read path for taxonomy lookups. Read by "Validate source event" (step 1) and "Build OneTrust payload" (step 4). Requires a VPC. |

## Storage

**Dev:** no separate buckets — each store below is a `cpms/…` prefix inside the existing project bucket (`AWS_BUCKET_NAME` in `.env.prod`). See `design.md` → "Development environment" for the paths.

| Block | Type | What it does |
|---|---|---|
| Fail bucket | S3 (dev: `cpms/fail/<eventId>/<run>.json`) | One record per data/logic failure (schema, content, canonical, payload build/validate) — includes the error detail. Paired with a CloudWatch alarm, not a DLQ. |
| Success bucket | S3 (dev: `cpms/success/<eventId>/<run>.json`) | One record per successful run — event, canonical payload, generated OneTrust payload, timestamp. |
| Watermark bucket | S3 (dev: `cpms/watermarks/` prefix in the project bucket) | One JSON object per subject (`watermarks/<sha256(subjectId)>.json`) holding the last-sent `capturedAt` per consent/preference item. Read by step 3, written by step 6. Needed because FIFO only preserves *arrival* order: without it, an older decision that arrives late (batch export, replay) would be sent after a newer one and roll it back at OneTrust — e.g. re-opting someone in after they opted out. See `design.md` → "Out-of-order arrival". Versioning optional (gives an audit trail of watermark moves). |
| Schema store | S3 | Holds `source_event.schema.json` (and, once written, the canonical schema) — loaded by validation Lambdas. |

## Queueing (OneTrust dispatch)

| Block | Type | What it does |
|---|---|---|
| Outbound request queue | SQS **FIFO**, `MessageGroupId = subjectId` | Holds complete OneTrust Consent Receipt requests (`method`, `url`, `headers`, `body`, `correlationId` — contract: `schemas/onetrust_request.schema.json`), sent by the dispatcher exactly as given, for later dispatch, since we don't have live paid API access yet. FIFO + per-subject grouping prevents the eventual dispatcher from reordering a subject's messages if it runs multiple concurrent workers. `cpms-sqs-outbound.fifo`: content-based dedup, high-throughput mode, 14-day retention (SQS max — undispatched requests expire after that), redrive to the outbound DLQ after 5 receives. |
| Outbound DLQ | SQS FIFO `cpms-sqs-outbound-dlq.fifo` | Receives requests the dispatcher failed to deliver 5 times. FIFO because its source queue is FIFO. (Enqueue failures don't land here — they fail the run and SQS retries the event.) |

## Observability

| Block | Type | What it does |
|---|---|---|
| Failure alarm | CloudWatch alarm (custom metric) | Fires on data/logic failures written to the fail bucket. This is the "someone should look at this" signal, since those failures won't resolve themselves on retry. |

## Not yet built / designed

- **Dispatcher** — will eventually read the outbound request queue and make the real OneTrust API call once paid access exists. Not designed.
- **VPC + VPC endpoints** — **prod only** (dev has no Redis, so no VPC). Required for any Lambda touching Redis (step 1, step 4, taxonomy cache updater); endpoints needed for those same Lambdas to reach S3/SQS without going through NAT. Not provisioned yet.
