#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${BERRY_AWS_ENV_FILE:-$repo_dir/deploy/.env.production}"

: "${BERRY_AWS_PROFILE:?Set BERRY_AWS_PROFILE to the isolated AWS CLI profile}"

for command in aws jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is not installed: $command" >&2
    exit 1
  fi
done

region="${BERRY_AWS_REGION:-eu-west-1}"
stack_name="${BERRY_AWS_STACK_NAME:-berry-production}"
policy_name="${stack_name}-env-transfer"
secret_arn=""
instance_role=""

cleanup() {
  if [[ -n "$instance_role" ]]; then
    aws iam delete-role-policy \
      --profile "$BERRY_AWS_PROFILE" \
      --role-name "$instance_role" \
      --policy-name "$policy_name" \
      >/dev/null 2>&1 || true
  fi
  if [[ -n "$secret_arn" ]]; then
    aws secretsmanager delete-secret \
      --profile "$BERRY_AWS_PROFILE" \
      --region "$region" \
      --secret-id "$secret_arn" \
      --force-delete-without-recovery \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ ! -f "$env_file" ]]; then
  echo "Missing production environment file: $env_file" >&2
  exit 1
fi
if [[ "$(wc -c <"$env_file" | tr -d '[:space:]')" -gt 65536 ]]; then
  echo "The production environment exceeds the Secrets Manager 64-KiB limit." >&2
  exit 1
fi

stack_output() {
  aws cloudformation describe-stacks \
    --profile "$BERRY_AWS_PROFILE" \
    --region "$region" \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='${1}'].OutputValue | [0]" \
    --output text
}

instance_id="$(stack_output InstanceId)"
instance_profile_arn="$(aws ec2 describe-instances \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --instance-ids "$instance_id" \
  --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' \
  --output text)"
if [[ -z "$instance_id" || "$instance_id" == "None" || -z "$instance_profile_arn" || "$instance_profile_arn" == "None" ]]; then
  echo "Could not resolve the EC2 instance and its IAM instance profile from stack $stack_name." >&2
  exit 1
fi

instance_profile_name="${instance_profile_arn##*/}"
instance_role="$(aws iam get-instance-profile \
  --profile "$BERRY_AWS_PROFILE" \
  --instance-profile-name "$instance_profile_name" \
  --query 'InstanceProfile.Roles[0].RoleName' \
  --output text)"
if [[ -z "$instance_role" || "$instance_role" == "None" ]]; then
  echo "Could not resolve the EC2 IAM role from instance profile $instance_profile_name." >&2
  exit 1
fi

secret_name="${stack_name}/env-transfer-$(date +%s)-$$"
secret_arn="$(aws secretsmanager create-secret \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --name "$secret_name" \
  --description "One-time encrypted Berry production environment transfer" \
  --secret-string "file://$env_file" \
  --tags Key=berry:environment,Value="$stack_name" Key=berry:purpose,Value=env-transfer \
  --query ARN \
  --output text)"

policy_document="$(jq -cn --arg secret_arn "$secret_arn" '{
  Version: "2012-10-17",
  Statement: [{
    Sid: "ReadOneTimeEnvironmentTransfer",
    Effect: "Allow",
    Action: "secretsmanager:GetSecretValue",
    Resource: $secret_arn
  }]
}')"
aws iam put-role-policy \
  --profile "$BERRY_AWS_PROFILE" \
  --role-name "$instance_role" \
  --policy-name "$policy_name" \
  --policy-document "$policy_document"

parameters="$(jq -cn --arg secret_arn "$secret_arn" --arg region "$region" '{commands: [
  "set -eu",
  "umask 077",
  "install -m 0600 -o ubuntu -g ubuntu /dev/null /opt/berry/deploy/.env.production",
  ("for attempt in $(seq 1 12); do if aws secretsmanager get-secret-value --region " + ($region | @sh) + " --secret-id " + ($secret_arn | @sh) + " --query SecretString --output text > /opt/berry/deploy/.env.production; then break; fi; sleep 5; done"),
  "test -s /opt/berry/deploy/.env.production",
  "test $(stat -c %a /opt/berry/deploy/.env.production) = 600",
  "! grep -q REPLACE_WITH /opt/berry/deploy/.env.production",
  "chown ubuntu:ubuntu /opt/berry/deploy/.env.production"
]}')"

command_id="$(aws ssm send-command \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "Install encrypted Berry production environment" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)"

if ! aws ssm wait command-executed \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --command-id "$command_id" \
  --instance-id "$instance_id"; then
  aws ssm get-command-invocation \
    --profile "$BERRY_AWS_PROFILE" \
    --region "$region" \
    --command-id "$command_id" \
    --instance-id "$instance_id" \
    --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
    --output json >&2
  exit 1
fi

echo "Transferred $env_file to EC2 through a one-time encrypted secret without printing credentials."
