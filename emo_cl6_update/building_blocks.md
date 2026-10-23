# OneTrust Integration System — Building Blocks

Inventory of infrastructure components. For *why* decisions were made this way, see
`design.md`. This file is just the parts list.

## Event ingestion

| Block | Type | What it does |
|---|---|---|
| Source event bus | EventBridge | Entry point. Every source (portal, Cvent, Kaltura, etc.) publishes events here. |
| Router | EventBridge rule(s) | Decides which **ingestion FIFO queue** to send the event to based on the event (`source`/`detail-type`). Targets the ingestion queue, **not** the Step Function directly — see `design.md` → "Ordering guarantee" for why. Not yet designed in detail. |
| Router DLQ | SQS (EventBridge rule DLQ) | Catches events that fail to even reach the ingestion queue (target invocation failure, throttling) — the one gap not covered by in-Step-Function error handling. |

## Ordering (per-subject FIFO)

| Block | Type | What it does |
|---|---|---|
| Ingestion FIFO queue | SQS FIFO, `MessageGroupId = subjectId` | Sits between EventBridge and the Step Function. Serializes processing per subject so an older event's full run (including the outbound enqueue) completes before a newer event for the same subject starts. Without this, variable Step Function execution latency can let a newer event finish — and enqueue — before an older one, causing the older payload to overwrite the newer one at OneTrust. |
| FIFO consumer | Lambda, SQS event source mapping (batch size 1) | Consumes the ingestion FIFO queue. Calls `StartSyncExecution` and **blocks until the Step Function run completes** before acknowledging the message — this is what actually enforces one-in-flight-execution-per-subject, not just the queue's existence. |

## Orchestration — Step Function (per source)

| Block | Type | What it does |
|---|---|---|
| Consent sync workflow | **Express** Step Functions state machine (not Standard — required for `StartSyncExecution`) | Orchestrates steps 1–8 from `design.md`. One per source (or parameterized per source). Invoked synchronously by the FIFO consumer Lambda. |
| Validate source event | Lambda | Step 1. Structural (JSON Schema) + content validation (taxonomy codes via Redis, timestamp sanity). Returns `{ valid, errors }`. Failure here means **the source sent bad data**. |
| Transform to canonical | Lambda | Step 2. **One universal mapping** (not per-source — every source conforms to the single `source_event` schema). Builds `preferences[]` from scratch (doesn't exist upstream), derives `legalBasis` from `purposeCode`, restructures `header`/`provenance`. Real logic, not a pass-through — see `design.md` → "Why steps 1, 2 and 3 are separate." |
| Validate canonical | Lambda | Step 3. Schema check on the canonical object. Failure here (or step 2's) means **our own transform logic is wrong** — a different failure cause from step 1, which is why it's kept separate rather than merged into one Lambda. |
| Build OneTrust payload | Lambda | Step 4. Generates the OneTrust-shaped upsert request body, translating `purposeCode`/`topicCode`/`channel` → OneTrust IDs via the Redis taxonomy mapping. |
| Validate OneTrust payload | Lambda | Step 5. Checks the generated payload against OneTrust's published API schema. |
| Enqueue request | Step Functions native SQS integration | Step 6. `SendMessage` directly from the state machine — no Lambda needed. Targets the outbound FIFO queue, `MessageGroupId = subjectId`. |
| Write success record | Lambda | Step 7. Writes the full record (event, canonical, OneTrust payload) to the success bucket. |

## Taxonomy reference + cache

| Block | Type | What it does |
|---|---|---|
| Taxonomy file | S3 object | Source of truth for valid `purposeCode`/`topicCode`/`channel` values and their mapping to OneTrust IDs. Reviewable, versioned. |
| Taxonomy change notification | S3 event notification | Fires on object update, triggers the updater Lambda. |
| Taxonomy cache updater | Lambda | Reads the updated taxonomy file from S3, writes it into Redis (Sets/mapping). The only thing that writes to the cache. |
| Taxonomy cache | ElastiCache (Redis) | Shared, always-current read path for taxonomy lookups. Read by "Validate source event" (step 1) and "Build OneTrust payload" (step 4). Requires a VPC. |

## Storage

| Block | Type | What it does |
|---|---|---|
| Fail bucket | S3 | One record per data/logic failure (schema, content, canonical, payload build/validate) — includes the error detail. Paired with a CloudWatch alarm, not a DLQ. |
| Success bucket | S3 | One record per successful run — event, canonical payload, generated OneTrust payload, timestamp. |
| Schema store | S3 | Holds `source_event.schema.json` (and, once written, the canonical schema) — loaded by validation Lambdas. |

## Queueing (OneTrust dispatch)

| Block | Type | What it does |
|---|---|---|
| Outbound request queue | SQS **FIFO**, `MessageGroupId = subjectId` | Holds fully-formatted OneTrust API requests (`method`, `url`, `headers`, `body`, `correlationId`) for later dispatch, since we don't have live paid API access yet. FIFO + per-subject grouping prevents the eventual dispatcher from reordering a subject's messages if it runs multiple concurrent workers. |
| Outbound DLQ | SQS | Catches network/connectivity failures only (e.g. the enqueue call itself failing after retries) — not data/logic failures. |

## Observability

| Block | Type | What it does |
|---|---|---|
| Failure alarm | CloudWatch alarm (custom metric) | Fires on data/logic failures written to the fail bucket. This is the "someone should look at this" signal, since those failures won't resolve themselves on retry. |

## Not yet built / designed

- **Dispatcher** — will eventually read the outbound request queue and make the real OneTrust API call once paid access exists. Not designed.
- **VPC + VPC endpoints** — required for any Lambda touching Redis (step 1, step 4, taxonomy cache updater); endpoints needed for those same Lambdas to reach S3/SQS without going through NAT. Not provisioned yet.
