"""Create the ingestion half of the flow: event bus -> rule -> ingestion FIFO queue (+ DLQs).

Usage: python3 send_to_cpms/deploy/setup_ingestion.py
Idempotent: creates what's missing and re-applies settings on what exists, so it's safe
to re-run after changing anything below. Names follow design.md -> "Naming convention".
"""
import json

from aws_env import BUS_NAME, client

RULE_NAME = "cpms-rule-ingest"
INGESTION_QUEUE = "cpms-sqs-ingestion.fifo"
INGESTION_DLQ = "cpms-sqs-ingestion-dlq.fifo"
RULE_DLQ = "cpms-sqs-rule-dlq"  # EventBridge target DLQs must be standard (non-FIFO) queues

# The FIFO consumer Lambda will have a ~330s timeout (Express Step Function max 300s + margin);
# AWS recommends visibility timeout >= 6x the consumer timeout for SQS-triggered Lambdas.
VISIBILITY_TIMEOUT = 6 * 330
MAX_RECEIVES = 5                      # attempts before a message moves to the ingestion DLQ
RETENTION_14_DAYS = 14 * 24 * 3600
TAGS = {"project": "cpms"}

eb, sqs = client("events"), client("sqs")
account = client("sts").get_caller_identity()["Account"]
region = eb.meta.region_name


def queue(name, attrs):
    """Create the queue, or re-apply attributes if it exists. Returns (url, arn)."""
    if name.endswith(".fifo"):
        attrs = {"FifoQueue": "true", **attrs}
    try:
        url = sqs.get_queue_url(QueueName=name)["QueueUrl"]
        attrs.pop("FifoQueue", None)  # immutable after creation
        sqs.set_queue_attributes(QueueUrl=url, Attributes=attrs)
        print(f"updated  {name}")
    except sqs.exceptions.QueueDoesNotExist:
        url = sqs.create_queue(QueueName=name, Attributes=attrs, tags=TAGS)["QueueUrl"]
        print(f"created  {name}")
    return url, f"arn:aws:sqs:{region}:{account}:{name}"


def allow_eventbridge(queue_url, queue_arn, rule_arn):
    """Queue policy: only this rule may send to the queue."""
    policy = {
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "AllowCpmsRuleIngest",
            "Effect": "Allow",
            "Principal": {"Service": "events.amazonaws.com"},
            "Action": "sqs:SendMessage",
            "Resource": queue_arn,
            "Condition": {"ArnEquals": {"aws:SourceArn": rule_arn}},
        }],
    }
    sqs.set_queue_attributes(QueueUrl=queue_url, Attributes={"Policy": json.dumps(policy)})


# 1. Event bus
try:
    eb.create_event_bus(Name=BUS_NAME, Tags=[{"Key": k, "Value": v} for k, v in TAGS.items()])
    print(f"created  {BUS_NAME}")
except eb.exceptions.ResourceAlreadyExistsException:
    print(f"exists   {BUS_NAME}")

# 2. Queues: DLQs first, so the ingestion queue's redrive policy can point at its DLQ
encrypted = {"SqsManagedSseEnabled": "true"}
rule_dlq_url, rule_dlq_arn = queue(RULE_DLQ, {**encrypted, "MessageRetentionPeriod": str(RETENTION_14_DAYS)})
_, ingestion_dlq_arn = queue(INGESTION_DLQ, {**encrypted, "MessageRetentionPeriod": str(RETENTION_14_DAYS)})
ingestion_url, ingestion_arn = queue(INGESTION_QUEUE, {
    **encrypted,
    # EventBridge doesn't pass a deduplication ID; content-based dedup lets SQS derive one
    # from the message body (which includes EventBridge's unique event id).
    "ContentBasedDeduplication": "true",
    # High-throughput FIFO: ordering and dedup are per message group (= per email), so
    # throughput scales with the number of distinct emails instead of per-queue limits.
    "DeduplicationScope": "messageGroup",
    "FifoThroughputLimit": "perMessageGroupId",
    "VisibilityTimeout": str(VISIBILITY_TIMEOUT),
    "RedrivePolicy": json.dumps({"deadLetterTargetArn": ingestion_dlq_arn, "maxReceiveCount": MAX_RECEIVES}),
})

# 3. Rule: every cpms.* event on the bus -> ingestion queue, grouped by email
rule_arn = eb.put_rule(
    Name=RULE_NAME,
    EventBusName=BUS_NAME,
    EventPattern=json.dumps({"source": [{"prefix": "cpms."}]}),
    State="ENABLED",
    Description="All CPMS source events -> ingestion FIFO queue (MessageGroupId = subject email)",
    Tags=[{"Key": k, "Value": v} for k, v in TAGS.items()],
)["RuleArn"]
print(f"applied  {RULE_NAME}")

allow_eventbridge(ingestion_url, ingestion_arn, rule_arn)
allow_eventbridge(rule_dlq_url, rule_dlq_arn, rule_arn)

resp = eb.put_targets(Rule=RULE_NAME, EventBusName=BUS_NAME, Targets=[{
    "Id": "ingestion-fifo",
    "Arn": ingestion_arn,
    # Dynamic path: each event's lowercased email becomes its FIFO message group.
    "SqsParameters": {"MessageGroupId": "$.detail.subject.identifierValue"},
    "DeadLetterConfig": {"Arn": rule_dlq_arn},
    "RetryPolicy": {"MaximumRetryAttempts": 185, "MaximumEventAgeInSeconds": 24 * 3600},
}])
if resp["FailedEntryCount"]:
    raise SystemExit(f"put_targets failed: {resp['FailedEntries']}")
print(f"applied  target {RULE_NAME} -> {INGESTION_QUEUE}")
print(f"\nDone. Send an event from the form, then check {INGESTION_QUEUE} in the SQS console ({region}).")
