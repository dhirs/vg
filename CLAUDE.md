# Repo guide

OneTrust integration system (CPMS — Consent and Preference Management Service). Sources
(secure portal, Cvent, Kaltura, etc.) emit consent/preference events; AWS pipelines
validate, normalize, and generate OneTrust API requests. We don't have paid OneTrust API
access yet, so requests are generated correctly and queued rather than sent live.

## Folder hierarchy

This repo holds **multiple flows**, each in its own top-level folder. A flow is a
self-contained piece of the overall CPMS system — e.g. "take a source trigger and turn it
into a OneTrust update" is one flow; "fan out a OneTrust-side update to other systems" is
a different flow. Each flow folder is internally structured the same way:

```
<flow_name>/
  design.md           - decisions and why, for this flow
  building_blocks.md  - infrastructure parts list, for this flow
  schemas/             - JSON Schema contracts used by this flow
  diagrams/            - .drawio diagrams for this flow
  web/                 - (optional) local test app for this flow (Node.js): e.g. a page that
                         sends events and shows what CPMS generated (`npm install && npm start`)
  lambdas/<name>/      - Lambda code (handler.py + optional requirements.txt), one folder per function
  deploy/              - boto3 scripts that create/update this flow's AWS resources and
                         upload schemas/taxonomy (idempotent — safe to re-run)
```

Root only holds this `CLAUDE.md`, `README.md`, and the flow folders — no design content
lives at root.

### Current flows

- **`send_to_cpms/`** — source triggers → OneTrust consent/preference update. Covers:
  EventBridge ingestion, the single Step Function shared by all sources (validate → transform → canonical →
  build OneTrust payload → enqueue), the taxonomy reference/cache, and success/fail
  recording. This is the flow designed so far.

- *(discovery)* **`consent_fanout/`** — getting OneTrust consent updates into downstream
  systems (SFMC, Dynamics CRM, AEP, Marketo), preferably through OneTrust's own
  integrations rather than code we build. For now it holds one questions file per target
  system (e.g. `SFMC.md`); `design.md` / `building_blocks.md` / `schemas/` get added once
  the route for each system is decided.

## What's inside a flow folder

- **`design.md`** — the living design doc for that flow. Captures *decisions and why*:
  the end-to-end flow, each Step Function state, error-handling rules, caching
  architecture, and what was explicitly decided against and why. Read this first for
  architectural context on a given flow. Has an "Open items" section — check it before
  assuming something is settled.

- **`building_blocks.md`** — the parts list for that flow. Every infrastructure component
  (Lambdas, S3 buckets, SQS queues, ElastiCache, Step Function states) with a one-line
  description of what it does. No rationale here — that's in `design.md`. Use this for
  "what exists" or "what do I need to provision," not "why does it work this way."

- **`schemas/`** — JSON Schema contracts for that flow (e.g. `source_event.schema.json`
  in `send_to_cpms/`). These are both the documentation for whoever integrates with the
  flow *and* the literal input to the validation Lambdas — same artifact, so contract and
  enforcement can't drift apart.

- **`diagrams/`** — `.drawio` architecture diagrams for that flow (e.g.
  `New_Consent_Record.drawio` in `send_to_cpms/`), editable in draw.io/diagrams.net. Visual
  companion to `design.md`, not a replacement — rationale still lives in the doc.

- **`README.md`** (root) — placeholder, not yet written up.

## Conventions for this repo

- Each flow gets its own folder with its own `design.md` / `building_blocks.md` /
  `schemas/` — don't mix flows into one design doc.
- Design decisions go in that flow's `design.md`, not scattered across chat — keep it
  current as things get agreed on.
- Infrastructure components go in that flow's `building_blocks.md` as they're introduced.
- Schemas are real JSON Schema files under `schemas/`, not samples/prose — they double as
  runtime validation input, not just documentation.
- Taxonomy value sets (`purposeCode`/`topicCode`/`channel`) are never hardcoded as schema
  `enum`s — they're validated against an external taxonomy reference (S3 source of truth
  → Redis read path) so new codes are a data change, not a schema/code change.

## Working with AWS

- **Every AWS component is named `cpms-<component type>-<purpose>`**, e.g.
  `cpms-eventbus-consent`, `cpms-lambda-validate-source`, `cpms-sqs-ingestion.fifo`.
  Type segments and the full list of names are in the flow's `design.md` → "Naming
  convention".
- **No new S3 buckets.** All S3 storage uses the existing bucket in `.env.prod`
  (`AWS_BUCKET_NAME`), under the `cpms/` key prefix (schemas, taxonomy, watermarks,
  success/fail records).
- **Dev has no ElastiCache/VPC** — taxonomy is read directly from S3.

- Interact with AWS using inline Python (`boto3`), **not the AWS CLI** — e.g. a
  `python3 - <<'EOF' ... EOF` heredoc or a short throwaway script.
- Credentials and settings come from `.env.prod` at repo root (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `AWS_BUCKET_NAME`). Parse the file in the
  script and pass the values to the `boto3` client explicitly; never print or echo secret
  values.
- `.env.prod` holds live secrets — never commit it.

## Running the test app (`send_to_cpms/web/`)

Local Node.js app. Left sidebar: **Non-logged in flows** (new consent record — **Event
registration** via EMO, **Account registration** via CL6 / Vanguard 365) and **Logged in
flows** (update consent — **Secure portal** and **Email Unsubscribe**, both of which find the
person's email and redirect to OneTrust's preference centre via a magic link).
Below them, **Open questions** shows each `consent_fanout/<doc>.md` (so far `SFMC` and `AEP`) question
by question, read live from the file, with comments saved to
`consent_fanout/comments/<doc>.json`. To add a file, add its name to `QUESTION_DOCS` in
`server.js` and a sidebar link in `public/index.html`.

**Start it:**

```bash
./send_to_cpms/web/start.sh
```

Installs dependencies on first run, stops anything already on port 8600, starts the server
and opens <http://localhost:8600>. Ctrl+C stops it. (Equivalent by hand:
`cd send_to_cpms/web && npm install && npm start`.)

**Needs:** Node 20+, and the repo-root `.env.prod` (AWS keys + `AWS_BUCKET_NAME`) — the
server reads it; the browser never sees credentials.

**Nothing to start in AWS.** The bus, queues, Lambdas and state machine are already
deployed and run on their own. Re-run the deploy scripts only after changing them:
- `python3 send_to_cpms/deploy/upload_assets.py` — after editing anything in `schemas/`
  or `taxonomy/`
- `python3 send_to_cpms/deploy/setup_processing.py` — after editing a Lambda or the state
  machine (it ends with an AccessDenied on the failure alarm until the IAM user gets
  `cloudwatch:PutMetricAlarm`; everything before that is applied)
- `python3 send_to_cpms/deploy/setup_ingestion.py` — after editing the bus / rule / ingestion queue

**Using it:** register on the EMO or CL6 page (any email) → that person is added to the
stub CRM (`send_to_cpms/web/data/stub-crm.json`) and stub Marketo
(`send_to_cpms/web/data/stub-marketo.json`), both git-ignored. Then either sign in to the
**Secure portal** with the same email (no password) and click your preferences link, or open
**Email Unsubscribe**, pick the person and click the link in the sample Marketo email. Both
look up the email (CRM / Marketo), get a OneTrust magic link and redirect to a local stand-in
for OneTrust's preference centre. After a server change, restart with the script; after a
page change, a hard refresh (Cmd+Shift+R) is enough.
