# Deploying CPMS into your own AWS account

Puts the whole `send_to_cpms` backend — event bus, queues, Lambdas, state machine, bucket, alarm —
into **your** AWS account as one CloudFormation stack, then runs the test app on your machine
against it. No credentials are shared: you use your own AWS login throughout.

```
test app (your machine) ──PutEvents──▶ cpms-eventbus-consent ──▶ cpms-sqs-ingestion.fifo ──▶ cpms-lambda-fifo-consumer
                                                                                                 │
   reads the result ◀── s3://cpms-<account>-<region>/cpms/success|fail/ ◀── cpms-sfn-consent-sync ┘
                                                                              └──▶ cpms-sqs-outbound.fifo (OneTrust receipts)
```

The stack is defined in `send_to_cpms/template.yaml` (AWS SAM — CloudFormation plus Lambda
packaging); the state machine's definition is `send_to_cpms/statemachine/consent_sync.asl.json`.

## What you need

- An AWS account and a login with admin rights (or rights to create CloudFormation stacks, IAM
  roles, Lambda, SQS, EventBridge, Step Functions, S3, CloudWatch Logs and alarms).
- Installed locally:
  - **git**
  - **Python 3.12** — the Lambdas are built for it (`brew install python@3.12`, or `uv python install 3.12`)
  - **AWS CLI v2** — for your login
  - **AWS SAM CLI** — builds and deploys the stack ([install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html); on a Mac: `brew install aws-sam-cli`)
  - **Node.js 20+** — for the test app
  - **boto3** — for the schema upload (`python3 -m pip install boto3`)

## 1. Get the code

```bash
git clone https://github.com/dhirs/vg.git
cd vg
```

## 2. Log in to your AWS account

Use an AWS CLI profile (SSO or access key — whatever your account uses), and pick a region:

```bash
aws configure sso --profile cpms        # or: aws configure --profile cpms
export AWS_PROFILE=cpms
export AWS_REGION=eu-west-2              # your region
aws sts get-caller-identity              # shows your account ID — check it's the right one
```

Keep these two `export`s in every terminal you use below.

## 3. Build and deploy the backend

```bash
cd send_to_cpms
sam build
sam deploy --guided --stack-name cpms --capabilities CAPABILITY_NAMED_IAM --region "$AWS_REGION"
```

- `sam build` packages each Lambda with its dependencies (as Linux builds, even on a Mac).
- `sam deploy --guided` asks a few questions the first time:
  - **OneTrustHost / OneTrustCollectionPointJwt** — press Enter for the defaults (nothing is sent
    to OneTrust; receipts are generated and queued).
  - **Confirm changes before deploy** — `y` lets you review the change set first.
  - **Allow SAM CLI IAM role creation** — `y` (the stack creates one role per Lambda and one for
    the state machine).
  - **Save arguments to samconfig.toml** — `y`; next time just run `sam deploy`. (`samconfig.toml`
    is git-ignored.)
- SAM also creates a small bucket of its own (`aws-sam-cli-managed-default-…`) to hold the
  packaged Lambda code.

When it finishes, note the **`BucketName`** output (`cpms-<account-id>-<region>`).

## 4. Upload the schemas and taxonomy

The Lambdas read these from the bucket on every run:

```bash
python3 deploy/upload_assets.py --bucket cpms-<account-id>-<region>
```

It uses your `AWS_PROFILE`. Re-run it whenever `schemas/` or `taxonomy/` change.

## 5. Run the test app against your stack

Create **`.env.prod` at the repo root** (git-ignored) with just your region and the bucket:

```bash
cd ..   # repo root
cat > .env.prod <<EOF
AWS_DEFAULT_REGION=$AWS_REGION
AWS_BUCKET_NAME=cpms-<account-id>-<region>
EOF
./send_to_cpms/web/start.sh
```

No keys go in the file: with none set, the app uses your `AWS_PROFILE` login. (A file with
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` also works — then those are used instead.) The
app opens at <http://localhost:8600>.

## 6. Run the whole flow

1. **Event registration** → enter any email → fill in the form → **Register now** → **Send to CPMS**.
2. The **Event sent to CPMS** tab shows the event; within a few seconds **OneTrust payload** shows
   the receipt CPMS generated — the pipeline ran in your account.
3. In the AWS console you can see it happen:
   - **Step Functions → cpms-sfn-consent-sync** — the execution and each step
   - **S3 → your bucket → `cpms/success/`** — the run record
   - **SQS → cpms-sqs-outbound.fifo** — the queued OneTrust receipt
4. Then try **Account registration**, the **Secure portal** (sign in with an email you registered,
   no password) and **Email Unsubscribe** — those two use local stubs, no AWS.

## Updating

- **Changed a Lambda or the state machine:** `cd send_to_cpms && sam build && sam deploy`
- **Changed `schemas/` or `taxonomy/`:** re-run step 4.
- **Pulled new code:** `git pull`, then both of the above if anything under `send_to_cpms/` changed.

## Removing it

```bash
cd send_to_cpms && sam delete --stack-name cpms --region "$AWS_REGION"
```

The data bucket is kept on purpose (so records aren't lost by accident). To remove it too, empty
it in the S3 console and delete it.

## If something goes wrong

| Symptom | Fix |
|---|---|
| `sam build` says *Binary validation failed for python3.12* | Python 3.12 isn't on your `PATH` — install it (see *What you need*) |
| Deploy fails with *requires capabilities: [CAPABILITY_NAMED_IAM]* | add `--capabilities CAPABILITY_NAMED_IAM` |
| Deploy fails with *… already exists* | a `cpms-*` resource with that name is already in the account/region (e.g. from an earlier attempt) — delete it, or deploy to another region |
| The app exits with *Missing settings* | `.env.prod` needs `AWS_DEFAULT_REGION` and `AWS_BUCKET_NAME` |
| Registrations fail with *security token* / *credentials* errors | `export AWS_PROFILE=…` in the terminal that runs `start.sh`; for SSO, `aws sso login --profile cpms` again |
| **OneTrust payload** shows *rejected* at ValidateSource | step 4 wasn't run (the Lambdas can't find the schemas/taxonomy) |
| Nothing arrives at all | Step Functions console → look at the latest execution; CloudWatch Logs → `/aws/lambda/cpms-lambda-fifo-consumer` |
