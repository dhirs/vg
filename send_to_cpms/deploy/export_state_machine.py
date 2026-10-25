"""Regenerate statemachine/consent_sync.asl.json (used by template.yaml) from setup_processing.py.

Usage: python3 send_to_cpms/deploy/export_state_machine.py
setup_processing.py stays the single source of the state machine's definition; run this after
changing it so the CloudFormation template deploys the same thing. Needs no AWS access: it
extracts the definition-building functions without running the rest of the script, and fills
the template's ${…} placeholders (DefinitionSubstitutions in template.yaml) in place of ARNs.
"""
import ast
import json

from aws_env import FLOW_DIR, PREFIX

SOURCE = FLOW_DIR / "deploy" / "setup_processing.py"
TARGET = FLOW_DIR / "statemachine" / "consent_sync.asl.json"
STEP_LAMBDAS = ["cpms-lambda-validate-source", "cpms-lambda-transform-canonical", "cpms-lambda-filter-stale",
                "cpms-lambda-build-payload", "cpms-lambda-advance-watermark"]


def placeholder(function_name):
    """cpms-lambda-filter-stale -> ${FilterStaleArn}"""
    return "${" + "".join(p.capitalize() for p in function_name.removeprefix("cpms-lambda-").split("-")) + "Arn}"


tree = ast.parse(SOURCE.read_text())
wanted_functions = {"lambda_task", "failed", "definition"}
wanted_names = {"LAMBDA_INFRA_ERRORS", "METRIC_NAMESPACE", "METRIC_NAME"}


def assigns_wanted(node):
    targets = [e for t in node.targets for e in (t.elts if isinstance(t, ast.Tuple) else [t])]
    return any(getattr(t, "id", None) in wanted_names for t in targets)


body = [n for n in tree.body
        if (isinstance(n, ast.FunctionDef) and n.name in wanted_functions) or (isinstance(n, ast.Assign) and assigns_wanted(n))]
namespace = {"PREFIX": PREFIX, "bucket": "${Bucket}", "outbound_url": "${OutboundQueueUrl}"}
exec(compile(ast.Module(body=body, type_ignores=[]), str(SOURCE), "exec"), namespace)

definition = namespace["definition"]({name: placeholder(name) for name in STEP_LAMBDAS})
TARGET.parent.mkdir(exist_ok=True)
TARGET.write_text(json.dumps(definition, indent=2) + "\n")
print(f"wrote {TARGET.relative_to(FLOW_DIR.parent)} ({len(definition['States'])} states)")
