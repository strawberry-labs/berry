#!/usr/bin/env sh
set -eu

target=/tmp/alertmanager.yml
topic_arn="${BERRY_ALERT_SNS_TOPIC_ARN:-}"
region="${BERRY_ALERT_SNS_REGION:-eu-west-1}"

case "$region" in
  ""|*[!a-z0-9-]*)
    echo "BERRY_ALERT_SNS_REGION must be an AWS region name." >&2
    exit 1
    ;;
esac

if [ -n "$topic_arn" ]; then
  case "$topic_arn" in
    *[!A-Za-z0-9:_./+=-]*|*"&"*|*"|"*)
      echo "BERRY_ALERT_SNS_TOPIC_ARN contains unsupported characters." >&2
      exit 1
      ;;
  esac
  case "$topic_arn" in
    arn:aws*:sns:"$region":*:*) ;;
    *)
      echo "BERRY_ALERT_SNS_TOPIC_ARN must be an SNS ARN in $region." >&2
      exit 1
      ;;
  esac
  sed \
    -e "s|__BERRY_ALERT_SNS_TOPIC_ARN__|$topic_arn|g" \
    -e "s|__BERRY_ALERT_SNS_REGION__|$region|g" \
    /etc/alertmanager/alertmanager.sns.yml > "$target"
  echo "Alertmanager notifications are routed to AWS SNS in $region."
else
  cp /etc/alertmanager/alertmanager.fallback.yml "$target"
  echo "WARNING: BERRY_ALERT_SNS_TOPIC_ARN is unset; alerts are visible in Alertmanager but notifications are disabled." >&2
fi

exec /bin/alertmanager \
  --config.file="$target" \
  --storage.path=/alertmanager \
  --data.retention="${BERRY_ALERTMANAGER_RETENTION:-120h}" \
  --web.listen-address=0.0.0.0:9093 \
  --cluster.listen-address=
