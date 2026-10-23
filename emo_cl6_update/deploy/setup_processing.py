"""Create the processing half: FIFO consumer -> Express state machine (steps 1-6) -> outbound FIFO queue.

Usage: python3 emo_cl6_update/deploy/setup_processing.py
Run setup_ingestion.py first (this wires the consumer to cpms-sqs-ingestion.fifo).
Idempotent: creates what's missing, updates code/config/definition on what exists.

State machine today:
  1 ValidateSource -> 2 TransformCanonical -> 3 FilterStale -> all stale? -> "skipped_stale"
     no -> 4 BuildPayload -> 5 Enqueue (each request, in order) -> 6 AdvanceWatermark -> "sent"
  "sent" / "skipped_stale" -> 7 WriteSuccess (cpms/success/<eventId>/<run>.json)
  any data/logic failure  -> cpms/fail/<eventId>/<run>.json -> metric -> "rejected"
OneTrust host / collection point JWT come from ONETRUST_HOST / ONETRUST_COLLECTION_POINT_JWT in
.env.prod; until those exist, a trial host and a dummy JWT are used (receipts are queued, not sent).
  any step failing on data/logic -> mark failedStep -> write cpms/fail/<run>.json -> metric -> "rejected"
"""
import io
import json
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from aws_env import FLOW_DIR, PREFIX, bucket_name, client, load_env

INGESTION_QUEUE = "cpms-sqs-ingestion.fifo"
OUTBOUND_QUEUE = "cpms-sqs-outbound.fifo"
OUTBOUND_DLQ = "cpms-sqs-outbound-dlq.fifo"  # FIFO because its source queue is FIFO (dispatcher redrive)
STATE_MACHINE = "cpms-sfn-consent-sync"
ALARM = "cpms-alarm-failures"
METRIC_NAMESPACE, METRIC_NAME = "CPMS", "DataFailures"
RUNTIME = "python3.12"
LAMBDAS = {
    # function name: (code folder under lambdas/, timeout seconds)
    "cpms-lambda-validate-source": ("validate_source", 30),
    "cpms-lambda-transform-canonical": ("transform_canonical", 30),
    "cpms-lambda-filter-stale": ("filter_stale", 30),
    "cpms-lambda-build-payload": ("build_payload", 30),
    "cpms-lambda-advance-watermark": ("advance_watermark", 30),
    # Express sync runs max 300s; consumer must outlive that. Ingestion queue visibility = 6x this.
    "cpms-lambda-fifo-consumer": ("fifo_consumer", 330),
}
TAGS = {"project": "cpms"}

iam, lam, sfn, logs, cw, sqs = (client(s) for s in ("iam", "lambda", "stepfunctions", "logs", "cloudwatch", "sqs"))
account = client("sts").get_caller_identity()["Account"]
region = lam.meta.region_name
bucket = bucket_name()
arn = lambda service, resource: f"arn:aws:{service}:{region}:{account}:{resource}"  # noqa: E731
sm_arn = arn("states", f"stateMachine:{STATE_MACHINE}")
queue_arn = arn("sqs", INGESTION_QUEUE)
outbound_arn = arn("sqs", OUTBOUND_QUEUE)
env_file = load_env()
ONETRUST_ENV = {
    "ONETRUST_HOST": env_file.get("ONETRUST_HOST", "privacyportaltrial.onetrust.com"),
    "ONETRUST_COLLECTION_POINT_JWT": env_file.get("ONETRUST_COLLECTION_POINT_JWT", "dummy-collection-point-jwt"),
}


def retry(fn, attempts=12, delay=5):
    """New IAM roles take a few seconds to become assumable; retry until they are."""
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            if i == attempts - 1 or not any(s in str(e) for s in ("assume", "AccessDenied", "not authorized", "InvalidParameterValue")):
                raise
            time.sleep(delay)


def role(name, service, policy, managed=()):
    trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": service}, "Action": "sts:AssumeRole"}]}
    try:
        role_arn = iam.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps(trust),
                                   Tags=[{"Key": k, "Value": v} for k, v in TAGS.items()])["Role"]["Arn"]
        print(f"created  {name}")
    except iam.exceptions.EntityAlreadyExistsException:
        iam.update_assume_role_policy(RoleName=name, PolicyDocument=json.dumps(trust))
        role_arn = iam.get_role(RoleName=name)["Role"]["Arn"]
        print(f"updated  {name}")
    iam.put_role_policy(RoleName=name, PolicyName="cpms-inline", PolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": policy}))
    for policy_arn in managed:
        iam.attach_role_policy(RoleName=name, PolicyArn=policy_arn)
    return role_arn


def package(folder):
    """Zip handler.py plus any requirements, built for the Lambda runtime (Linux x86_64, CPython 3.12)."""
    src = FLOW_DIR / "lambdas" / folder
    with tempfile.TemporaryDirectory() as build:
        shutil.copy(src / "handler.py", build)
        for shared in (FLOW_DIR / "lambdas" / "shared").glob("*.py"):  # helpers used by several Lambdas
            shutil.copy(shared, build)
        if (src / "requirements.txt").exists():
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(src / "requirements.txt"), "--target", build,
                            "--platform", "manylinux2014_x86_64", "--implementation", "cp", "--python-version", "3.12",
                            "--only-binary=:all:", "--upgrade"], check=True)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in Path(build).rglob("*"):
                if f.is_file() and "__pycache__" not in f.parts:
                    z.write(f, f.relative_to(build))
        return buf.getvalue()


def function(name, role_arn, env):
    folder, timeout = LAMBDAS[name]
    code = package(folder)
    config = dict(Role=role_arn, Handler="handler.handler", Runtime=RUNTIME, Timeout=timeout, MemorySize=256,
                  Environment={"Variables": env})
    try:
        lam.get_function(FunctionName=name)
        lam.update_function_code(FunctionName=name, ZipFile=code)
        lam.get_waiter("function_updated_v2").wait(FunctionName=name)
        retry(lambda: lam.update_function_configuration(FunctionName=name, **config))
        print(f"updated  {name}")
    except lam.exceptions.ResourceNotFoundException:
        retry(lambda: lam.create_function(FunctionName=name, Code={"ZipFile": code}, Tags=TAGS, **config))
        print(f"created  {name}")
    lam.get_waiter("function_active_v2").wait(FunctionName=name)
    lam.get_waiter("function_updated_v2").wait(FunctionName=name)
    return arn("lambda", f"function:{name}")


LAMBDA_INFRA_ERRORS = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]


def lambda_task(function_arn, payload, result_path, next_state, failed_state, result_selector=None):
    """Lambda step: retries AWS-side errors; after that they fail the run (SQS retries the message).
    Any other error (a bug in our code) is a logic failure -> recorded, not retried.
    payload is a JSONPath string (pass that node) or a Parameters-style dict."""
    payload_param = {"Payload.$": payload} if isinstance(payload, str) else {"Payload": payload}
    task = {
        "Type": "Task",
        "Resource": "arn:aws:states:::lambda:invoke",
        "Parameters": {"FunctionName": function_arn, **payload_param},
        "ResultSelector": result_selector or {"result.$": "$.Payload"},
        "ResultPath": result_path,
        "Retry": [{"ErrorEquals": LAMBDA_INFRA_ERRORS, "IntervalSeconds": 1, "MaxAttempts": 3, "BackoffRate": 2}],
        "Catch": [
            {"ErrorEquals": LAMBDA_INFRA_ERRORS, "ResultPath": "$.error", "Next": "InfraFailure"},
            {"ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": failed_state},
        ],
        "Next": next_state,
    }
    return task


def failed(step):
    """Pass state that tags the record with which step failed, then joins the shared fail path."""
    return {"Type": "Pass", "Result": step, "ResultPath": "$.failedStep", "Next": "RecordFailure"}


def definition(arns):
    verdict = {"valid.$": "$.Payload.valid", "errors.$": "$.Payload.errors"}
    return {
        "Comment": "CPMS consent sync — steps 1-7. See design.md -> Step Function states.",
        "StartAt": "ValidateSource",
        "States": {
            # Step 1 — source sent bad data?
            "ValidateSource": lambda_task(arns["cpms-lambda-validate-source"], "$.sourceEvent", "$.validation",
                                          "IsSourceValid", "ValidateSourceFailed", verdict),
            "IsSourceValid": {"Type": "Choice", "Default": "ValidateSourceFailed",
                              "Choices": [{"Variable": "$.validation.valid", "BooleanEquals": True, "Next": "TransformCanonical"}]},
            "ValidateSourceFailed": failed("ValidateSource"),
            # Step 2 — our transform, which validates its own output; raises on anything unexpected or off-contract
            "TransformCanonical": lambda_task(arns["cpms-lambda-transform-canonical"], "$.sourceEvent", "$.canonical",
                                              "FilterStale", "TransformCanonicalFailed", {"record.$": "$.Payload"}),
            "TransformCanonicalFailed": failed("TransformCanonical"),
            # Step 3 — drop items not newer than the subject's watermark (design.md -> "Out-of-order arrival")
            "FilterStale": lambda_task(arns["cpms-lambda-filter-stale"], "$.canonical.record", "$.staleCheck",
                                       "IsAllStale", "FilterStaleFailed",
                                       {"record.$": "$.Payload.record", "dropped.$": "$.Payload.dropped",
                                        "allStale.$": "$.Payload.allStale", "etag.$": "$.Payload.etag"}),
            "FilterStaleFailed": failed("FilterStale"),
            "IsAllStale": {"Type": "Choice", "Default": "BuildPayload",
                           "Choices": [{"Variable": "$.staleCheck.allStale", "BooleanEquals": True, "Next": "SkippedStale"}]},
            # an expected outcome, not a failure: nothing newer to send
            "SkippedStale": {
                "Type": "Pass",
                "Parameters": {"outcome": "skipped_stale", "dropped.$": "$.staleCheck.dropped", "eventId.$": "$.canonical.record.header.eventId"},
                "ResultPath": "$.result",
                "Next": "WriteSuccess",
            },
            # Step 4 — build OneTrust receipt requests, validated against onetrust_request.schema.json inside the Lambda
            "BuildPayload": lambda_task(arns["cpms-lambda-build-payload"], "$.staleCheck.record", "$.payload",
                                        "Enqueue", "BuildPayloadFailed", {"requests.$": "$.Payload.requests"}),
            "BuildPayloadFailed": failed("BuildPayload"),
            # Step 5 — one SQS message per request, strictly in order (oldest interactionDate first)
            "Enqueue": {
                "Type": "Map",
                "ItemsPath": "$.payload.requests",
                "MaxConcurrency": 1,
                "ItemSelector": {"request.$": "$$.Map.Item.Value", "groupId.$": "$.canonical.record.subject.subjectId"},
                "ItemProcessor": {
                    "ProcessorConfig": {"Mode": "INLINE"},
                    "StartAt": "SendRequest",
                    "States": {"SendRequest": {
                        "Type": "Task",
                        "Resource": "arn:aws:states:::sqs:sendMessage",
                        "Parameters": {"QueueUrl": outbound_url, "MessageBody.$": "$.request", "MessageGroupId.$": "$.groupId"},
                        "Retry": [{"ErrorEquals": ["States.ALL"], "IntervalSeconds": 1, "MaxAttempts": 4, "BackoffRate": 2}],
                        "End": True,
                    }},
                },
                "ResultPath": None,
                # Enqueue failing after retries is AWS-side: fail the run so SQS retries the whole event.
                # Re-sending requests that did get queued is harmless (content dedup + OneTrust's interactionDate rule).
                "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "InfraFailure"}],
                "Next": "AdvanceWatermark",
            },
            # Step 6 — must stay AFTER the enqueue: moving the watermark first would lose the decision if enqueue failed.
            "AdvanceWatermark": lambda_task(arns["cpms-lambda-advance-watermark"],
                                            {"record.$": "$.staleCheck.record", "etag.$": "$.staleCheck.etag"},
                                            "$.watermark", "Sent", "SentWatermarkNotAdvanced", {"result.$": "$.Payload"}),
            # The requests are already queued, so this is not a rejection. Worst case a later replay re-sends
            # the same decisions, which OneTrust ignores by interactionDate.
            "SentWatermarkNotAdvanced": {
                "Type": "Pass",
                "Parameters": {"outcome": "sent", "warning": "watermark not advanced", "error.$": "$.error",
                               "requestsQueued.$": "States.ArrayLength($.payload.requests)",
                               "requests.$": "$.payload.requests", "dropped.$": "$.staleCheck.dropped"},
                "ResultPath": "$.result",
                "Next": "WriteSuccess",
            },
            "Sent": {
                "Type": "Pass",
                "Parameters": {"outcome": "sent",
                               "requestsQueued.$": "States.ArrayLength($.payload.requests)",
                               "requests.$": "$.payload.requests", "dropped.$": "$.staleCheck.dropped",
                               "watermarkAdvanced.$": "$.watermark.result.advanced"},
                "ResultPath": "$.result",
                "Next": "WriteSuccess",
            },
            # Step 7 — the run's full record (source event, canonical record, requests, outcome), keyed by eventId
            "WriteSuccess": {
                "Type": "Task",
                "Resource": "arn:aws:states:::aws-sdk:s3:putObject",
                "Parameters": {
                    "Bucket": bucket,
                    "Key.$": f"States.Format('{PREFIX}/success/{{}}/{{}}.json', $.recordId, $$.Execution.Name)",
                    "Body.$": "$",
                    "ContentType": "application/json",
                },
                "ResultPath": None,
                "Retry": [{"ErrorEquals": ["States.ALL"], "IntervalSeconds": 1, "MaxAttempts": 3, "BackoffRate": 2}],
                # the decision is already queued (or correctly skipped); a missing record must not re-run the event
                "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.recordError", "Next": "Done"}],
                "Next": "Done",
            },
            "Done": {"Type": "Pass", "OutputPath": "$.result", "End": True},
            # Shared fail path for data/logic failures
            "RecordFailure": {
                "Type": "Task",
                "Resource": "arn:aws:states:::aws-sdk:s3:putObject",
                "Parameters": {
                    "Bucket": bucket,
                    "Key.$": f"States.Format('{PREFIX}/fail/{{}}/{{}}.json', $.recordId, $$.Execution.Name)",
                    # pass the object itself: the SDK integration serializes it to JSON (JsonToString would double-encode)
                    "Body.$": "$",
                    "ContentType": "application/json",
                },
                "ResultPath": None,
                "Retry": [{"ErrorEquals": ["States.ALL"], "IntervalSeconds": 1, "MaxAttempts": 3, "BackoffRate": 2}],
                "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "InfraFailure"}],
                "Next": "EmitFailureMetric",
            },
            "EmitFailureMetric": {
                "Type": "Task",
                "Resource": "arn:aws:states:::aws-sdk:cloudwatch:putMetricData",
                "Parameters": {"Namespace": METRIC_NAMESPACE, "MetricData": [{"MetricName": METRIC_NAME, "Value": 1, "Unit": "Count"}]},
                "ResultPath": None,
                "Retry": [{"ErrorEquals": ["States.ALL"], "IntervalSeconds": 1, "MaxAttempts": 3, "BackoffRate": 2}],
                # the fail record is already written; don't re-run the event just because the metric failed
                "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.metricError", "Next": "Rejected"}],
                "Next": "Rejected",
            },
            "Rejected": {
                "Type": "Pass",
                "Parameters": {"outcome": "rejected", "failedStep.$": "$.failedStep",
                               "failRecord.$": f"States.Format('s3://{bucket}/{PREFIX}/fail/{{}}/{{}}.json', $.recordId, $$.Execution.Name)"},
                "End": True,
            },
            "InfraFailure": {"Type": "Fail", "Error": "InfraFailure", "Cause": "AWS-side failure after retries; SQS will retry the message"},
        },
    }


def s3_role(name, reads, writes=()):
    """Lambda role reading (and optionally writing) the given cpms/ prefixes.
    ListBucket so a missing key is NoSuchKey, not AccessDenied."""
    policy = [
        {"Effect": "Allow", "Action": "s3:GetObject", "Resource": [f"arn:aws:s3:::{bucket}/{PREFIX}/{p}/*" for p in reads]},
        {"Effect": "Allow", "Action": "s3:ListBucket", "Resource": f"arn:aws:s3:::{bucket}",
         "Condition": {"StringLike": {"s3:prefix": [f"{PREFIX}/{p}/*" for p in reads]}}},
    ]
    if writes:
        policy.append({"Effect": "Allow", "Action": "s3:PutObject", "Resource": [f"arn:aws:s3:::{bucket}/{PREFIX}/{p}/*" for p in writes]})
    return role(name, "lambda.amazonaws.com", policy, managed=["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"])


# --- Outbound queue: complete OneTrust requests waiting for the dispatcher
def queue(name, attrs):
    """Create the FIFO queue, or re-apply attributes if it exists. Returns its URL."""
    try:
        url = sqs.get_queue_url(QueueName=name)["QueueUrl"]
        sqs.set_queue_attributes(QueueUrl=url, Attributes=attrs)
        print(f"updated  {name}")
    except sqs.exceptions.QueueDoesNotExist:
        url = sqs.create_queue(QueueName=name, Attributes={"FifoQueue": "true", **attrs}, tags=TAGS)["QueueUrl"]
        print(f"created  {name}")
    return url


RETENTION_14_DAYS = str(14 * 24 * 3600)  # SQS maximum — undispatched requests expire after this
queue(OUTBOUND_DLQ, {"SqsManagedSseEnabled": "true", "MessageRetentionPeriod": RETENTION_14_DAYS})
outbound_url = queue(OUTBOUND_QUEUE, {
    "SqsManagedSseEnabled": "true",
    "MessageRetentionPeriod": RETENTION_14_DAYS,
    "ContentBasedDeduplication": "true",
    "DeduplicationScope": "messageGroup",
    "FifoThroughputLimit": "perMessageGroupId",
    "RedrivePolicy": json.dumps({"deadLetterTargetArn": arn("sqs", OUTBOUND_DLQ), "maxReceiveCount": 5}),
})

# --- Step Lambdas: name -> (cpms/ prefixes read, prefixes written)
STEP_S3_ACCESS = {
    "cpms-lambda-validate-source": (["schemas", "taxonomy"], []),
    "cpms-lambda-transform-canonical": (["taxonomy", "schemas"], []),
    "cpms-lambda-filter-stale": (["watermarks"], []),
    "cpms-lambda-build-payload": (["taxonomy", "schemas"], []),
    "cpms-lambda-advance-watermark": (["watermarks"], ["watermarks"]),
}
step_arns = {}
for fn_name, (reads, writes) in STEP_S3_ACCESS.items():
    fn_role = s3_role(fn_name.replace("cpms-", "cpms-role-", 1), reads, writes)
    extra_env = ONETRUST_ENV if fn_name == "cpms-lambda-build-payload" else {}
    step_arns[fn_name] = function(fn_name, fn_role, {"BUCKET": bucket, "PREFIX": PREFIX, **extra_env})

# --- State machine (Express: required for the consumer's StartSyncExecution)
log_group = f"/aws/vendedlogs/states/{STATE_MACHINE}"
try:
    logs.create_log_group(logGroupName=log_group, tags=TAGS)
    logs.put_retention_policy(logGroupName=log_group, retentionInDays=30)
except logs.exceptions.ResourceAlreadyExistsException:
    pass
sfn_role = role("cpms-role-sfn-consent-sync", "states.amazonaws.com", [
    {"Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": [a for f in step_arns.values() for a in (f, f"{f}:*")]},
    {"Effect": "Allow", "Action": "s3:PutObject",
     "Resource": [f"arn:aws:s3:::{bucket}/{PREFIX}/fail/*", f"arn:aws:s3:::{bucket}/{PREFIX}/success/*"]},
    {"Effect": "Allow", "Action": "sqs:SendMessage", "Resource": outbound_arn},
    {"Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",
     "Condition": {"StringEquals": {"cloudwatch:namespace": METRIC_NAMESPACE}}},
    {"Effect": "Allow", "Resource": "*", "Action": [  # Step Functions log delivery to CloudWatch Logs
        "logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery",
        "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"]},
])
sm_config = dict(
    definition=json.dumps(definition(step_arns)),
    roleArn=sfn_role,
    loggingConfiguration={"level": "ALL", "includeExecutionData": True,
                          "destinations": [{"cloudWatchLogsLogGroup": {"logGroupArn": arn("logs", f"log-group:{log_group}:*")}}]},
)
if any(m["name"] == STATE_MACHINE for p in sfn.get_paginator("list_state_machines").paginate() for m in p["stateMachines"]):
    retry(lambda: sfn.update_state_machine(stateMachineArn=sm_arn, **sm_config))
    print(f"updated  {STATE_MACHINE}")
else:
    retry(lambda: sfn.create_state_machine(name=STATE_MACHINE, type="EXPRESS", tags=[{"key": k, "value": v} for k, v in TAGS.items()], **sm_config))
    print(f"created  {STATE_MACHINE}")

# --- FIFO consumer Lambda + its trigger on the ingestion queue
consumer_role = role("cpms-role-lambda-fifo-consumer", "lambda.amazonaws.com", [
    {"Effect": "Allow", "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"],
     "Resource": queue_arn},
    {"Effect": "Allow", "Action": "states:StartSyncExecution", "Resource": sm_arn},
], managed=["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"])
consumer_arn = function("cpms-lambda-fifo-consumer", consumer_role, {"STATE_MACHINE_ARN": sm_arn})

if not lam.list_event_source_mappings(FunctionName=consumer_arn, EventSourceArn=queue_arn)["EventSourceMappings"]:
    retry(lambda: lam.create_event_source_mapping(FunctionName=consumer_arn, EventSourceArn=queue_arn, BatchSize=1, Enabled=True))
    print(f"created  trigger {INGESTION_QUEUE} -> cpms-lambda-fifo-consumer")
else:
    print(f"exists   trigger {INGESTION_QUEUE} -> cpms-lambda-fifo-consumer")

# --- Failure alarm (no notification target yet)
cw.put_metric_alarm(
    AlarmName=ALARM, Namespace=METRIC_NAMESPACE, MetricName=METRIC_NAME, Statistic="Sum", Period=300,
    EvaluationPeriods=1, Threshold=1, ComparisonOperator="GreaterThanOrEqualToThreshold", TreatMissingData="notBreaching",
    AlarmDescription="Data/logic failures recorded under cpms/fail/ — these won't fix themselves on retry.",
    Tags=[{"Key": k, "Value": v} for k, v in TAGS.items()],
)
print(f"applied  {ALARM}")
print("\nDone. Send an event from the form; outcomes appear in the cpms-lambda-fifo-consumer logs, rejections under "
      f"s3://{bucket}/{PREFIX}/fail/.")
