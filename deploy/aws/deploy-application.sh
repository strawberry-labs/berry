#!/usr/bin/env bash
set -euo pipefail

: "${BERRY_AWS_PROFILE:?Set BERRY_AWS_PROFILE to the isolated AWS CLI profile}"
: "${BERRY_AWS_DOMAIN:?Set BERRY_AWS_DOMAIN to the exact production hostname}"
: "${BERRY_DEPLOY_COMMIT:?Set BERRY_DEPLOY_COMMIT to the full Git commit SHA}"

region="${BERRY_AWS_REGION:-eu-west-1}"
domain="$(printf '%s' "$BERRY_AWS_DOMAIN" | tr '[:upper:]' '[:lower:]')"
commit="$(printf '%s' "$BERRY_DEPLOY_COMMIT" | tr '[:upper:]' '[:lower:]')"

for command in aws jq dig; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is not installed: $command" >&2
    exit 1
  fi
done

if [[ ! "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo "BERRY_AWS_DOMAIN must be one DNS hostname." >&2
  exit 1
fi
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "BERRY_DEPLOY_COMMIT must be a full lowercase Git commit SHA." >&2
  exit 1
fi

stacks="$(aws cloudformation describe-stacks \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --output json)"
matches="$(jq -c --arg domain "$domain" '[
  .Stacks[]
  | select(any(.Parameters[]?; .ParameterKey == "DomainName" and (.ParameterValue | ascii_downcase) == $domain))
  | select(.StackStatus | test("^(CREATE|UPDATE)_COMPLETE$"))
]' <<<"$stacks")"
if [[ "$(jq 'length' <<<"$matches")" -ne 1 ]]; then
  echo "Expected exactly one healthy CloudFormation stack for the requested domain." >&2
  exit 1
fi

stack_name="$(jq -r '.[0].StackName' <<<"$matches")"
environment_name="$(jq -r '.[0].Parameters[] | select(.ParameterKey == "EnvironmentName") | .ParameterValue' <<<"$matches")"
instance_id="$(jq -r '.[0].Outputs[] | select(.OutputKey == "InstanceId") | .OutputValue' <<<"$matches")"
allocation_id="$(jq -r '.[0].Outputs[] | select(.OutputKey == "ElasticIp") | .OutputValue' <<<"$matches")"
if [[ -z "$stack_name" || -z "$environment_name" || -z "$instance_id" || -z "$allocation_id" \
  || "$stack_name" == "null" || "$environment_name" == "null" || "$instance_id" == "null" || "$allocation_id" == "null" ]]; then
  echo "The domain-matched stack is missing required application outputs." >&2
  exit 1
fi

instance="$(aws ec2 describe-instances \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --instance-ids "$instance_id" \
  --output json)"
instance_count="$(jq '[.Reservations[].Instances[]] | length' <<<"$instance")"
instance_state="$(jq -r '.Reservations[0].Instances[0].State.Name // ""' <<<"$instance")"
instance_role="$(jq -r '.Reservations[0].Instances[0].Tags[]? | select(.Key == "berry:role") | .Value' <<<"$instance")"
instance_environment="$(jq -r '.Reservations[0].Instances[0].Tags[]? | select(.Key == "berry:environment") | .Value' <<<"$instance")"
instance_stack="$(jq -r '.Reservations[0].Instances[0].Tags[]? | select(.Key == "aws:cloudformation:stack-name") | .Value' <<<"$instance")"
if [[ "$instance_count" -ne 1 || "$instance_state" != "running" || "$instance_role" != "application" \
  || "$instance_environment" != "$environment_name" || "$instance_stack" != "$stack_name" ]]; then
  echo "The stack's EC2 target failed state, role, environment, or ownership attestation." >&2
  exit 1
fi

public_ip="$(aws ec2 describe-addresses \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --allocation-ids "$allocation_id" \
  --query 'Addresses[0].PublicIp' \
  --output text)"
if [[ -z "$public_ip" || "$public_ip" == "None" ]]; then
  echo "The stack Elastic IP could not be resolved." >&2
  exit 1
fi
resolved_ip="$(dig +short A "$domain" | sort -u)"
if [[ "$resolved_ip" != "$public_ip" ]]; then
  echo "The requested domain does not resolve uniquely to the stack Elastic IP." >&2
  exit 1
fi

ssm_status="$(aws ssm describe-instance-information \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --filters "Key=InstanceIds,Values=$instance_id" \
  --query 'InstanceInformationList[0].PingStatus' \
  --output text)"
if [[ "$ssm_status" != "Online" ]]; then
  echo "The domain-attested EC2 target is not online in Systems Manager." >&2
  exit 1
fi

parameters="$(jq -cn --arg domain "$domain" --arg commit "$commit" '{commands: [
  "set -eu",
  "test -d /opt/berry/.git",
  "test -f /opt/berry/deploy/.env.production",
  "test \"$(stat -c %a /opt/berry/deploy/.env.production)\" = 600",
  ("test \"$(sed -n " + ("s/^BERRY_DOMAIN=//p" | @sh) + " /opt/berry/deploy/.env.production | tail -n 1)\" = " + ($domain | @sh)),
  "cd /opt/berry",
  "git -c safe.directory=/opt/berry fetch --prune origin main",
  ("git -c safe.directory=/opt/berry cat-file -e " + (($commit + "^{commit}") | @sh)),
  ("git -c safe.directory=/opt/berry merge-base --is-ancestor " + ($commit | @sh) + " origin/main"),
  "launcher=$(mktemp)",
  "trap \"rm -f -- $launcher\" EXIT INT TERM",
  ("git -c safe.directory=/opt/berry show " + (($commit + ":deploy/server-deploy.sh") | @sh) + " > \"$launcher\""),
  "chmod 700 \"$launcher\"",
  ("BERRY_DEPLOY_REPO_DIR=/opt/berry BERRY_DEPLOY_EXPECTED_DOMAIN=" + ($domain | @sh) + " \"$launcher\" " + ($commit | @sh))
]}')"

command_id="$(aws ssm send-command \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "Deploy domain-attested Berry application revision" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)"

echo "Target attestation passed for $domain; SSM deployment started."
for _attempt in $(seq 1 180); do
  status="$(aws ssm get-command-invocation \
    --profile "$BERRY_AWS_PROFILE" \
    --region "$region" \
    --command-id "$command_id" \
    --instance-id "$instance_id" \
    --query Status \
    --output text 2>/dev/null || true)"
  case "$status" in
    Success)
      aws ssm get-command-invocation \
        --profile "$BERRY_AWS_PROFILE" \
        --region "$region" \
        --command-id "$command_id" \
        --instance-id "$instance_id" \
        --query StandardOutputContent \
        --output text
      echo "SSM deployment completed successfully for $domain."
      exit 0
      ;;
    Failed|Cancelled|TimedOut|Undeliverable|Terminated)
      aws ssm get-command-invocation \
        --profile "$BERRY_AWS_PROFILE" \
        --region "$region" \
        --command-id "$command_id" \
        --instance-id "$instance_id" \
        --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
        --output json >&2
      exit 1
      ;;
  esac
  sleep 10
done

echo "Timed out waiting for the SSM deployment command." >&2
exit 1
