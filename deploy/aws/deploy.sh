#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
template_file="$repo_dir/deploy/aws/berry-single-instance.yaml"

: "${BERRY_AWS_PROFILE:?Set BERRY_AWS_PROFILE to the isolated AWS CLI profile}"
: "${BERRY_AWS_DOMAIN:?Set BERRY_AWS_DOMAIN to the public hostname}"
: "${BERRY_AWS_VPC_ID:?Set BERRY_AWS_VPC_ID to an existing VPC ID}"
: "${BERRY_AWS_APP_SUBNET_ID:?Set BERRY_AWS_APP_SUBNET_ID to the EC2 subnet ID}"
: "${BERRY_AWS_DB_SUBNET_IDS:?Set BERRY_AWS_DB_SUBNET_IDS to comma-separated RDS subnet IDs}"
: "${BERRY_AWS_AVAILABILITY_ZONE:?Set BERRY_AWS_AVAILABILITY_ZONE to the EC2/RDS Availability Zone}"
: "${BERRY_AWS_EIP_ALLOCATION_ID:?Set BERRY_AWS_EIP_ALLOCATION_ID to the existing Elastic IP allocation ID}"
: "${BERRY_AWS_ALERT_EMAIL:?Set BERRY_AWS_ALERT_EMAIL to the operations alert address}"

region="${BERRY_AWS_REGION:-eu-west-1}"
stack_name="${BERRY_AWS_STACK_NAME:-berry-production}"
environment_name="${BERRY_AWS_ENVIRONMENT_NAME:-berry-production}"
instance_type="${BERRY_AWS_INSTANCE_TYPE:-c6a.2xlarge}"
root_volume_size="${BERRY_AWS_ROOT_VOLUME_SIZE:-200}"
database_class="${BERRY_AWS_DATABASE_CLASS:-db.m6g.xlarge}"
database_engine_version="${BERRY_AWS_DATABASE_ENGINE_VERSION:-16.14}"
database_storage="${BERRY_AWS_DATABASE_STORAGE:-100}"
database_max_storage="${BERRY_AWS_DATABASE_MAX_STORAGE:-500}"
monthly_budget="${BERRY_AWS_MONTHLY_BUDGET:-600}"

aws cloudformation validate-template \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --template-body "file://$template_file" \
  >/dev/null

aws cloudformation deploy \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --stack-name "$stack_name" \
  --template-file "$template_file" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "EnvironmentName=$environment_name" \
    "DomainName=$BERRY_AWS_DOMAIN" \
    "VpcId=$BERRY_AWS_VPC_ID" \
    "AppSubnetId=$BERRY_AWS_APP_SUBNET_ID" \
    "DatabaseSubnetIds=$BERRY_AWS_DB_SUBNET_IDS" \
    "DatabaseAvailabilityZone=$BERRY_AWS_AVAILABILITY_ZONE" \
    "ElasticIpAllocationId=$BERRY_AWS_EIP_ALLOCATION_ID" \
    "InstanceType=$instance_type" \
    "RootVolumeSize=$root_volume_size" \
    "DatabaseInstanceClass=$database_class" \
    "DatabaseEngineVersion=$database_engine_version" \
    "DatabaseAllocatedStorage=$database_storage" \
    "DatabaseMaxAllocatedStorage=$database_max_storage" \
    "MonthlyBudget=$monthly_budget" \
    "AlertEmail=$BERRY_AWS_ALERT_EMAIL" \
  --tags \
    "berry:environment=$environment_name" \
    "berry:managed-by=cloudformation"

aws cloudformation describe-stacks \
  --profile "$BERRY_AWS_PROFILE" \
  --region "$region" \
  --stack-name "$stack_name" \
  --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' \
  --output table
