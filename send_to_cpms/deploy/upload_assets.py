"""Upload this flow's schemas and taxonomy to the project bucket (AWS_BUCKET_NAME in .env.prod).

Usage: python3 send_to_cpms/deploy/upload_assets.py [--bucket NAME]
Re-run after any change under schemas/ or taxonomy/ — the repo is the source of truth,
S3 is the deployed copy the Lambdas read. --bucket overrides AWS_BUCKET_NAME (e.g. the
BucketName output of a stack deployed from template.yaml).
"""
import argparse
import json

from aws_env import FLOW_DIR, PREFIX, bucket_name, s3_client

parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument("--bucket", help="bucket to upload to (default: AWS_BUCKET_NAME in .env.prod)")
args = parser.parse_args()
s3, bucket = s3_client(), args.bucket or bucket_name()
uploads = []
for path in sorted((FLOW_DIR / "schemas").glob("*.schema.json")):
    name = path.name.removesuffix(".schema.json")
    uploads.append((path, f"{PREFIX}/schemas/{name}/1.0/{path.name}"))
uploads.append((FLOW_DIR / "taxonomy/taxonomy.sample.json", f"{PREFIX}/taxonomy/taxonomy.json"))

for path, key in uploads:
    json.loads(path.read_text())  # refuse to upload a file that isn't valid JSON
    s3.upload_file(str(path), bucket, key, ExtraArgs={"ContentType": "application/json"})
    print(f"s3://{bucket}/{key}")
