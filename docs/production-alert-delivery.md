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
