#!/usr/bin/env bash
# Run scripts/remaining-issue-evidence.sql against the production database of
# one domain-attested Berry instance over SSM, read-only.
#
#   scripts/aws-read-only-evidence.sh aesg-production ai.aesg.com 2026-09-14 > evidence.tsv
#
# The database URL is read from /opt/berry/deploy/.env.production on the server
# and never printed. The session forces default_transaction_read_only, and the
# SQL itself runs in one READ ONLY transaction that ends in ROLLBACK, so no
# statement can write. BERRY_EVIDENCE_DRY_RUN=1 prints the SSM parameters and
# exits before any AWS call.
set -euo pipefail

profile="${1:-}"
domain="$(printf '%s' "${2:-}" | tr '[:upper:]' '[:lower:]')"
since="${3:-$(date -u -v-30d +%F 2>/dev/null || date -u -d '30 days ago' +%F)}"
region="${BERRY_AWS_REGION:-eu-west-1}"
if [[ ! "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "Pass the window start as YYYY-MM-DD." >&2
  exit 1
fi
for command in aws jq base64 gzip; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command is not installed: $command" >&2; exit 1; }
done

sql_file="$(cd "$(dirname "$0")" && pwd)/remaining-issue-evidence.sql"
sql_b64="$(gzip -9c < "$sql_file" | base64 | tr -d '\n')"
parameters="$(jq -cn --arg sql "$sql_b64" --arg since "$since" '{commands: [
  "set -eu",
  "test -f /opt/berry/deploy/.env.production",
  "url=$(awk -F= '\''/^(DATABASE_URL|BERRY_DATABASE_URL|BERRY_POSTGRES_URL)=/ { sub(/^[^=]*=/, \"\"); print; exit }'\'' /opt/berry/deploy/.env.production)",
  "url=${url#\\\"}; url=${url%\\\"}; url=${url#\\'\''}; url=${url%\\'\''}",
  "test -n \"$url\"",
  "sql=$(mktemp)",
  "trap \"rm -f -- $sql\" EXIT INT TERM",
  ("printf %s " + ($sql | @sh) + " | base64 -d | gunzip > \"$sql\""),
  "export PGOPTIONS=\"-c default_transaction_read_only=on -c statement_timeout=120000\"",
  ("if command -v psql >/dev/null 2>&1; then psql \"$url\" -X -A -F \"\t\" -v since=" + ($since | @sh) + " -f \"$sql\"; else docker run --rm -i --network host -e PGOPTIONS postgres:16-alpine psql \"$url\" -X -A -F \"\t\" -v since=" + ($since | @sh) + " -f - < \"$sql\"; fi")
]}')"

if [[ "${BERRY_EVIDENCE_DRY_RUN:-}" == "1" ]]; then
  jq . <<<"$parameters"
  exit 0
fi

if [[ -z "$profile" || ! "$domain" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
  echo "Usage: $0 <aws-profile> <production-hostname> [YYYY-MM-DD]" >&2
  exit 1
fi

stacks="$(aws cloudformation describe-stacks --profile "$profile" --region "$region" --output json)"
matches="$(jq -c --arg domain "$domain" '[
  .Stacks[]
  | select(any(.Parameters[]?; .ParameterKey == "DomainName" and (.ParameterValue | ascii_downcase) == $domain))
  | select(.StackStatus | test("^(CREATE|UPDATE)_COMPLETE$"))
]' <<<"$stacks")"
if [[ "$(jq 'length' <<<"$matches")" -ne 1 ]]; then
  echo "Expected exactly one healthy CloudFormation stack for $domain." >&2
  exit 1
fi
instance_id="$(jq -r '.[0].Outputs[] | select(.OutputKey == "InstanceId") | .OutputValue' <<<"$matches")"

command_id="$(aws ssm send-command \
  --profile "$profile" \
  --region "$region" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "Berry read-only audit evidence" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)"

for _attempt in $(seq 1 90); do
  status="$(aws ssm get-command-invocation --profile "$profile" --region "$region" \
    --command-id "$command_id" --instance-id "$instance_id" --query Status --output text 2>/dev/null || true)"
  case "$status" in
    Success|Failed|Cancelled|TimedOut|Undeliverable|Terminated)
      aws ssm get-command-invocation --profile "$profile" --region "$region" \
        --command-id "$command_id" --instance-id "$instance_id" --query StandardOutputContent --output text
      echo "(SSM returns at most 24,000 characters of output; a cut-off end means rerun with a later start date.)" >&2
      if [[ "$status" != "Success" ]]; then
        aws ssm get-command-invocation --profile "$profile" --region "$region" \
          --command-id "$command_id" --instance-id "$instance_id" --query StandardErrorContent --output text >&2
        exit 1
      fi
      exit 0
      ;;
  esac
  sleep 5
done
echo "Timed out waiting for SSM command $command_id." >&2
exit 1
