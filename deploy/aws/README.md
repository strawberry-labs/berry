# AWS single-instance deployment

This stack runs Berry on one EC2 instance with private RDS PostgreSQL and two
native S3 buckets. It reuses an existing VPC, subnets, and Elastic IP. Caddy on
EC2 terminates HTTPS, so the stack does not create an ALB or NAT Gateway.

The application server is managed through AWS Systems Manager Session Manager.
Port 22 is not exposed. RDS accepts PostgreSQL traffic only from the EC2
security group. S3 Block Public Access, encryption, and versioning are enabled.

## Prerequisites

- An isolated AWS CLI profile with permission to manage CloudFormation, EC2,
  RDS, S3, IAM, SSM, SNS, CloudWatch, Budgets, and Secrets Manager.
- An Elastic IP whose address is already used by the application's DNS `A`
  record.
- One public EC2 subnet and at least two RDS subnets in different Availability
  Zones. Keep EC2 and the primary RDS instance in the same Availability Zone.
- Enough EC2 On-Demand Standard-instance vCPU quota for the selected instance.
- A local, untracked `deploy/.env.production`. CloudFormation does not read,
  upload, replace, or print this file.

## Deploy

Set the non-secret infrastructure values and run the helper:

```sh
export BERRY_AWS_PROFILE=customer-production
export BERRY_AWS_REGION=eu-west-1
export BERRY_AWS_STACK_NAME=berry-customer-production
export BERRY_AWS_ENVIRONMENT_NAME=berry-customer-production
export BERRY_AWS_DOMAIN=ai.example.com
export BERRY_AWS_VPC_ID=vpc-0123456789abcdef0
export BERRY_AWS_APP_SUBNET_ID=subnet-0123456789abcdef0
export BERRY_AWS_DB_SUBNET_IDS=subnet-0123456789abcdef0,subnet-0fedcba9876543210
export BERRY_AWS_AVAILABILITY_ZONE=eu-west-1a
export BERRY_AWS_EIP_ALLOCATION_ID=eipalloc-0123456789abcdef0
export BERRY_AWS_ALERT_EMAIL=operations@example.com

./deploy/aws/deploy.sh
```

The production defaults are an 8-vCPU/16-GiB `c6a.2xlarge` EC2 instance with a
200-GiB encrypted gp3 root volume and a 4-vCPU/16-GiB
`db.m6g.xlarge` PostgreSQL instance with 100 GiB of gp3 storage. RDS storage can
grow automatically to 500 GiB. Override these values with the corresponding
`BERRY_AWS_*` variables in `deploy/aws/deploy.sh`.

The stack creates a monthly AWS Budget and sends alerts at 50%, 80%, and a
forecasted 100%. Confirm the separate SNS subscription email to receive EC2 and
RDS operational alarms.

## Application deployment

The EC2 bootstrap installs Docker, Compose, PostgreSQL client tools, Git, AWS
CLI, SSM Agent, EC2 Instance Connect, unattended security updates, and an 8-GiB
swap file. It deliberately does not clone Berry or copy production secrets.

After the stack completes:

1. Read the stack outputs for the instance ID, RDS endpoint, RDS secret ARN,
   artifact bucket, and audit bucket.
2. Create the `mem0` database and login through a private SSM-backed session.
3. Fill only the five RDS URLs and two bucket names in the local
   `deploy/.env.production`.
4. Run `configure-production-env.sh`, then `transfer-production-env.sh`. The
   transfer uses a one-time encrypted Secrets Manager value and removes both
   the temporary secret and IAM permission when it finishes. Do not place the
   environment in S3, Parameter Store, command history, user data, or
   CloudFormation parameters.
5. Push the reviewed commit to the deployment branch, then deploy it through
   the domain-attested SSM helper. The helper resolves exactly one healthy
   CloudFormation stack by `DomainName`, verifies stack/instance tags, SSM
   status, and DNS-to-EIP ownership, then asks the target host to verify its
   non-secret `BERRY_DOMAIN` before changing the checkout:

   ```sh
   export BERRY_AWS_PROFILE=customer-production
   export BERRY_AWS_REGION=eu-west-1
   export BERRY_AWS_DOMAIN=ai.example.com
   export BERRY_DEPLOY_COMMIT=0123456789abcdef0123456789abcdef01234567
   ./deploy/aws/deploy-application.sh
   ```

   The exact commit must be reachable from `origin/main`. The helper never
   uploads, replaces, or prints `deploy/.env.production`.

The RDS instance and both S3 buckets retain data if the stack is removed. EC2
termination protection and RDS deletion protection are enabled. Disable those
protections deliberately before replacing or deleting the stack.
