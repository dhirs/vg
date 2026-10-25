"""Shared AWS setup for this flow's scripts: reads creds from the repo-root .env.prod.

Without keys in .env.prod (e.g. a fresh account deployed with template.yaml), boto3's normal
credential chain is used instead — an AWS CLI profile (AWS_PROFILE) or environment variables.
"""
from pathlib import Path

import boto3

REPO_ROOT = Path(__file__).resolve().parents[2]
FLOW_DIR = Path(__file__).resolve().parents[1]
BUS_NAME = "cpms-eventbus-consent"
PREFIX = "cpms"  # everything this project stores in the shared bucket lives under cpms/


def load_env(path=REPO_ROOT / ".env.prod"):
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def client(service):
    env = load_env()
    if not env.get("AWS_ACCESS_KEY_ID"):
        return boto3.client(service, region_name=env.get("AWS_DEFAULT_REGION"))  # default credential chain
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
    bucket = load_env().get("AWS_BUCKET_NAME")
    if not bucket:
        raise SystemExit("No bucket: set AWS_BUCKET_NAME in .env.prod (or pass --bucket where supported).")
    return bucket
