# Production runtime alert delivery

Prometheus sends Berry runtime alerts to the Compose Alertmanager. Alertmanager
uses the EC2 instance role and AWS SDK credential chain to publish to the SNS
topic already created by `deploy/aws/berry-single-instance.yaml`; no static AWS
access keys belong in Compose or the production environment.

## Enable delivery during deployment

1. Update the CloudFormation stack so the EC2 role receives the narrowly scoped
   `sns:Publish` permission for `AlertTopic`.
2. Read the stack's `AlertTopicArn` output and confirm the email subscription is
   accepted in SNS.
3. Back up `deploy/.env.production`, then set only:

   ```dotenv
   BERRY_ALERT_SNS_TOPIC_ARN=arn:aws:sns:eu-west-1:ACCOUNT_ID:TOPIC_NAME
   BERRY_ALERT_SNS_REGION=eu-west-1
   ```

4. Recreate Alertmanager and Prometheus through the normal deployment script.
   The script pulls both pinned images and preserves the production environment
   file.
5. Check Alertmanager logs for `Alertmanager notifications are routed to AWS
   SNS`, verify both local readiness endpoints, and fire a controlled warning to
   confirm receipt and resolution email delivery.

When the topic ARN is blank, Alertmanager remains healthy and retains alerts for
its UI, but logs a startup warning and does not send external notifications.
That fallback is for staged rollout only and is not production notification
readiness.

# Administrator email about AI provider credit

The worker emails organization administrators when an AI provider account runs
out of credit or quota, and when an OpenRouter or DeepSeek balance falls below a
threshold. Users meanwhile see that the AI provider is out of credit and that
they should contact support or their administrator.

## What is sent, and to whom

- **Out of credit.** A model call that fails with HTTP 402, or image generation
  that reports `insufficient_quota`/exhausted credit, raises the alert in the
  background; the user's run is never delayed or changed by it. A balance check
  that finds no credit raises the same alert.
- **Running low.** Every `BERRY_PROVIDER_BALANCE_CHECK_INTERVAL_MINUTES` (default
  30, `0` disables) the worker checks the router (`BERRY_ROUTER_INFERENCE_BASE_URL`)
  and each enabled organization provider whose host is `openrouter.ai`
  (`/api/v1/key`, `/api/v1/credits`) or `api.deepseek.com` (`/user/balance`).
  Other providers are not checked. A key is only sent to its own provider host.
- **At most one email per organization, provider and problem in 24 hours**,
  across all workers and restarts (recorded in `alert_events`; each send in
  `delivery_attempts` with the SES message ID or the error). A send SES
  refused with a client error (HTTP 4xx other than 408, such as an unverified
  identity or throttling), or one that never reached SES, is retried, up to 5
  attempts; a delivered one is never resent. A send whose result is unknown
  stays `pending` with "The email may have been sent…" in `error` and is never
  sent again automatically. That covers an SES server or gateway error (HTTP
  5xx: SES can accept a message and still return one), a request timeout, a
  lost connection, and a worker that stopped mid-send. To find them:
  `SELECT id,created_at,error FROM delivery_attempts WHERE status='pending' AND error LIKE 'The email may have been sent%'`.
  Check SES before resolving one by hand.
- **Recipients:** the email destinations of an enabled "Credit health" alert
  rule; otherwise every configured email destination under Reports & alerts;
  otherwise the organization's active owners and admins with verified email
  addresses. Switching off the automatic rule "Provider credit alerts
  (automatic)" stops these emails for that organization.

## Configuration (worker)

| Variable | Default | Meaning |
| --- | --- | --- |
| `BERRY_EMAIL_PROVIDER` | `none` | `ses` to send; `none` sends nothing and changes nothing |
| `BERRY_EMAIL_FROM` | — | Verified SES sender, e.g. `Berry <alerts@example.com>` |
| `BERRY_SES_REGION` | `AWS_REGION` | SES region, e.g. `eu-west-1` |
| `BERRY_SES_CONFIGURATION_SET` | — | Optional SES configuration set |
| `BERRY_PROVIDER_BALANCE_CHECK_INTERVAL_MINUTES` | `30` | 5–1440; `0` disables the balance check |
| `BERRY_PROVIDER_LOW_BALANCE_THRESHOLD` | `10` | Low-balance threshold in the account's currency |
| `BERRY_PROVIDER_LOW_BALANCE_THRESHOLDS_JSON` | `{}` | Per provider ID or `openrouter`/`deepseek`, e.g. `{"router":25}` |

An unusable value (unknown provider, missing sender or region) disables email
and logs one warning; the worker keeps running. Credentials come from the
standard AWS credential chain (the EC2 instance role); never configure AWS keys.

## AWS SES setup

1. In SES (same region as `BERRY_SES_REGION`), verify the sender domain (DKIM
   CNAME records) or the single sender address used in `BERRY_EMAIL_FROM`.
2. Request production access for the account ("move out of the sandbox"). Until
   then SES only delivers to verified recipient addresses.
3. Give the EC2 instance role `ses:SendEmail` on the identity (and the
   configuration set, if used). The CloudFormation template does not grant it:

   ```json
   {
     "Sid": "SendAdministratorEmail",
     "Effect": "Allow",
     "Action": "ses:SendEmail",
     "Resource": [
       "arn:aws:ses:eu-west-1:ACCOUNT_ID:identity/example.com",
       "arn:aws:ses:eu-west-1:ACCOUNT_ID:configuration-set/berry-alerts"
     ]
   }
   ```

4. Back up `deploy/.env.production`, set `BERRY_EMAIL_PROVIDER=ses`,
   `BERRY_EMAIL_FROM` and `BERRY_SES_REGION`, and redeploy the worker services.
5. Check the delivery history under Reports & alerts after the first alert; a
   failed row shows the SES error (for example an unverified identity).
