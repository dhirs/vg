"""Shared AWS setup for this flow's scripts: reads creds from the repo-root .env.prod."""
from pathlib import Path

import boto3

REPO_ROOT = Path(__file__).resolve().parents[2]
FLOW_DIR = Path(__file__).resolve().parents[1]
BUS_NAME = "cpms-eventbus-consent"
PREFIX = "cpms"  # everything this project stores in the shared bucket lives under cpms/


def load_env(path=REPO_ROOT / ".env.prod"):
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def client(service):
    env = load_env()
    return boto3.client(
        service,
        aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
        region_name=env["AWS_DEFAULT_REGION"],
    )


def events_client():
    return client("events")


def s3_client():
    return client("s3")


def bucket_name():
    return load_env()["AWS_BUCKET_NAME"]
