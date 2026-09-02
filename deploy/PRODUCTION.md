# Berry single-box production deployment

This topology is for one private organization at `ai.example.com`. Caddy is the only public container. It terminates TLS and serves the web app and API on one origin; RDS stays private in the VPC, while Redis and the application containers remain on Docker's internal network or loopback. Published files and audit exports use native AWS S3 in `eu-west-1` through the EC2 instance profile.

For a repeatable AWS installation, use the CloudFormation stack in
[`deploy/aws`](./aws/README.md).

## Server and account prerequisites

- One x86-64 EC2 instance in AWS Ireland (`eu-west-1`) running Ubuntu 24.04 LTS, with enough memory and disk to build the monorepo and run the Compose services. Since E2B provides execution and S3 stores files, the instance does not need local sandbox or object-storage capacity. Enable the instance metadata endpoint, require IMDSv2, and set the metadata response hop limit to `2` so the AWS SDK inside Docker can retrieve instance-profile credentials.
- One Elastic IP attached to the EC2 instance. Keep the domain's existing authoritative nameservers and create one `A` record: host `ai` pointing to that Elastic IP. Add `AAAA` only when IPv6 is configured and reachable. Native S3 does not require a `files.ai.example.com` record.
- Security-group ingress for TCP 80 and 443 only. Use AWS Systems Manager Session Manager for administration; do not expose SSH, 3001, 3108, 5432, 6379, 9000, or 9001.
- One private RDS PostgreSQL instance reachable only from the EC2 security group. Create separate `berry` and `mem0` databases, enable `pgcrypto` and `vector`, require TLS, and enable automated backups with point-in-time recovery.
- Docker Engine with the Compose v2 plugin, Git, curl, openssl, and enough free disk to build the monorepo image.
- Two private S3 buckets in `eu-west-1`, one for artifacts and one for audit exports. The EC2 instance profile needs `s3:ListBucket` on both buckets; artifact objects need `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion`, and `s3:AbortMultipartUpload`, while audit objects need only `s3:PutObject`. Keep Block Public Access enabled. Configure CORS only on the artifact bucket so `https://ai.example.com` can upload through presigned URLs and read the returned `ETag`; the audit bucket remains server-only.
- BerryRouter inference URL/key, exact Router IDs and effective prices per million tokens for every deployed model, the chat-completions path, and an image model/path.
- An E2B Cloud team with billing enabled, a server API key, and either the built-in `base` template or a reviewed custom template ID. The E2B key is injected only into the private API container and never reaches the web app or browser.
- BerryCrawl public HTTPS MCP URL and bearer key.

The official `api.berrycrawl.com/api/v1/mcp` adapter uses Berry's reviewed tool
catalog. Web search, single-page scrape, brand lookup, crawl start, and crawl
job polling are present on the first model call; the remaining BerryCrawl tools
stay behind `tool_search`. If a live schema changes, Berry disables that tool
until the bundled catalog is reviewed and updated. Credit-consuming read calls
use manual recovery after an ambiguous worker interruption so Berry does not
replay and bill the same request twice.
- A retention policy for RDS automated backups and snapshots. Configure S3 versioning, lifecycle, and retention separately for the two object buckets.

The AWS production profile does not start PostgreSQL, Mem0 PostgreSQL, or MinIO containers and does not expose a second files hostname. Local development can still use the single-host database and MinIO services.

## External service contracts required by this build

Inference must expose an OpenAI-compatible streaming `POST /chat/completions` beneath `BERRY_ROUTER_INFERENCE_BASE_URL`. It must preserve streaming text, tool-call deltas, token usage, model identity, and provider identity. Image generation must accept OpenAI-style `POST /images/generations` with `model`, `prompt`, `n`, `size`, and `response_format`, returning `data[0].b64_json` or `data[0].url`.

The checked-in production environment example includes the GA route
`google-vertex/gemini-3.7-flash` for upstream `gemini-3.7-flash`. Berry exposes
text and image input, text output, tools, JSON, vision, and the supported low,
medium, and high thinking levels; medium is the upstream default. The route does
not advertise audio, video, PDF, or explicit prompt caching because its current
BerryRouter adapter does not expose those request controls.

Gemini 3.7 Flash cost hints are USD per million tokens for Google's global
Standard endpoint through December 31, 2026: input `0.75`, output (including
visible and reasoning tokens) `3.75`, and cache read `0.075`. Starting January 1,
2027, those list prices become `1.50`, `7.50`, and `0.15`. Recheck the effective
BerryRouter charge before that date and use any customer multiplier or discount
instead of the provider list price. Berry Chat stores only `BERRY_ROUTER_API_KEY`;
the Google Vertex credential stays in BerryRouter.

Providers registered through Settings are inactive until an administrator runs the guarded health check. Add every permitted exact hostname to `BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS`; HTTPS is mandatory by default. Store additional credential references in the untracked `BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON` object or inject the referenced environment variable into the API container. Never place raw provider keys in the admin form.

Code execution does not pass through BerryRouter. The API uses the official E2B JavaScript SDK with `E2B_API_KEY` to create and reconnect sandboxes, stream commands, read and write files, and resolve preview hosts. Sandboxes are created with authenticated inbound traffic, the Berry network policy, and an automatic filesystem-preserving pause after `BERRY_SANDBOX_TTL_SECONDS`. A later turn reconnects by stable tenant/request metadata, including after an API process restart. `BERRY_E2B_KEEP_MEMORY_ON_PAUSE=false` is the recommended default: it preserves the filesystem but cold-boots on resume instead of retaining process memory.

`BERRY_E2B_TEMPLATE_ID=base` is enough for the first Node/Python test. For a controlled client deployment, build and pin a custom E2B template containing every required runtime and package. E2B compute size comes from that template/account configuration; `BERRY_SANDBOX_CPU_COUNT`, `BERRY_SANDBOX_MEMORY_MIB`, and `BERRY_SANDBOX_DISK_MIB` are Berry's metering estimates and must match the selected template. Set `BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS` to the selected template's total current price in USD micros/hour and `BERRY_BUDGET_SANDBOX_EXEC_ESTIMATE_MICROS` to a conservative pre-execution reservation. Berry reconciles the reservation against measured command runtime.

Model turns, image generations, and direct E2B operations write first-party usage records. The sandbox provider records runtime and configured resource estimates; set the `BERRY_BUDGET_SANDBOX_*_ESTIMATE_MICROS` values from the actual E2B plan before enforcing hard dollar limits. For authoritative Router or BerryCrawl charges beyond built-in records, configure those services to send signed usage events to `POST https://ai.example.com/v1/orgs/00000000-0000-7000-8000-000000000001/usage/events` using the `router-prod` key ID and the matching secret from `BERRY_USAGE_SIGNING_SECRETS`.

## First deployment

```sh
sudo install -d -m 0750 /opt/berry
sudo chown -R "$USER":"$USER" /opt/berry
git clone YOUR_REPOSITORY_URL /opt/berry
cd /opt/berry
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
# Run the hex command for each independent database, usage-signing, and setup value.
openssl rand -hex 32
openssl rand -base64 36
openssl rand -base64 32
./deploy/production-up.sh
```

Fill every `REPLACE_WITH` value before running the script. A one-shot migration
container applies additive Postgres migrations with the schema-owner account,
then creates or refreshes three non-bypass runtime roles. The platform role gets
explicit read-only RLS policies only for its operational reporting tables. The
long-lived services never receive the schema-owner credential. Caddy obtains
and renews the certificate after DNS resolves and ports 80/443 are reachable.

Apply this CORS policy to the artifact bucket before opening onboarding. Replace
the bucket placeholder; do not apply this rule to the audit bucket.

```sh
aws s3api put-bucket-cors \
  --bucket YOUR_ARTIFACT_BUCKET \
  --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://ai.example.com"],"AllowedMethods":["PUT"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]}'
```

Before enabling Google Workspace, Gmail, or Calendar in the admin UI, complete
the organization-owned OAuth, Workspace Admin, Picker, scope, and connector-key
checklist in [`docs/google-connectors-self-hosting.md`](../docs/google-connectors-self-hosting.md).

Before enabling **Continue with Google**, create a separate identity-only OAuth
client and follow [`docs/google-workspace-sso-self-hosting.md`](../docs/google-workspace-sso-self-hosting.md).
The SSO client ID and encrypted secret are configured in Berry's admin UI, not
in `deploy/.env.production`. The production profile permits Google sign-in only.

For an existing installation created with the former 15-minute sandbox timeout,
update only the non-secret TTL setting before the next deployment:

```sh
cd /opt/berry
cp -a deploy/.env.production deploy/.env.production.bak-sandbox-ttl-300
sed -i 's/^BERRY_SANDBOX_TTL_SECONDS=.*/BERRY_SANDBOX_TTL_SECONDS=300/' deploy/.env.production
grep '^BERRY_SANDBOX_TTL_SECONDS=' deploy/.env.production
```

`deploy/server-deploy.sh` refuses values above 300 seconds. It never replaces
the production environment file or prints its secrets. The API and worker also
cap the effective runtime value at 300 seconds, so the first rollout is protected
even though it begins under the previous deployment script.

Use URL-safe hexadecimal values for the Postgres, setup, and usage-webhook secrets because the Postgres password is interpolated into a connection URL. Use separate values from `openssl rand -base64 36` for `BETTER_AUTH_SECRET` and `openssl rand -base64 32` for `BERRY_CONNECTOR_ENCRYPTION_KEY`. The launcher validates the decoded connector key length and refuses to start while any `REPLACE_WITH` placeholder remains.

The launcher prints only the application URL. Append `#setup=<BERRY_SETUP_TOKEN>` locally in the browser; do not send or store the complete tokenized URL. Configure the organization, brand, approved Workspace domain, identity OAuth client, connector scopes, and initial owner email. The verified owner claims the account with Google. Berry creates the owner membership, default workspace ownership, and initial budgets in a locked, idempotent transaction, then closes setup.

`BERRY_AUTH_SIGNUP_ENABLED=false` should remain the default. Workspace users are admitted on their first verified Google sign-in. The owner can pre-authorize additional administrators; ordinary domain users receive the member role. After verifying owner sign-in, clear both `BERRY_SETUP_OWNER_EMAIL` and `BERRY_SETUP_TOKEN` from the environment and restart the API; the completed database state remains authoritative.

## Go-live verification

The onboarding system check is the authoritative S3 permission test. It runs a complete multipart write/read/delete cycle against the artifact bucket and a conditional write against the audit bucket. A successful `head-bucket` command alone is only a bucket and network smoke test.

```sh
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.aws.yaml ps
curl -fsS https://ai.example.com/healthz
curl -I https://ai.example.com/
aws s3api head-bucket --bucket YOUR_ARTIFACT_BUCKET
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.aws.yaml exec -T api node -e "import('@aws-sdk/client-s3').then(async ({S3Client,HeadBucketCommand})=>{const client=new S3Client({region:process.env.BERRY_ARTIFACT_S3_REGION});await client.send(new HeadBucketCommand({Bucket:process.env.BERRY_ARTIFACT_S3_BUCKET}));client.destroy();console.log('EC2 role can access artifact S3')})"
curl -i -X OPTIONS "https://YOUR_ARTIFACT_BUCKET.s3.eu-west-1.amazonaws.com/cors-smoke" \
  -H 'Origin: https://ai.example.com' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type'
docker compose --env-file deploy/.env.production -f deploy/compose.yaml -f deploy/compose.aws.yaml logs --tail=200 api web worker caddy
```

Then verify in the browser: Google sign-in/sign-out with the owner, a reserved administrator, an ordinary Workspace member, a blocked member, and an outside-domain account; create and switch projects; create a task; send one turn through each configured model; run a BerryCrawl-backed research skill; paste, drop, and upload a file larger than 200 MB; open PDF, DOCX, XLSX, and PPTX previews; generate an image; execute code in an E2B sandbox and open its published output; set a small test budget and confirm an over-budget turn is blocked; inspect usage/model/audit data; restart the stack and confirm projects, tasks, messages, generated file records, and an E2B workspace test file remain.

Project records, tasks, messages, governance, budgets, usage, and audit data are durable in Postgres. Published artifacts and audit exports are durable in S3. E2B session files survive idle timeout and API restart through pause/reconnect. They are still provider-managed working state, not the system of record: explicit sandbox deletion, E2B account retention changes, or provider failure can remove them, so important outputs must be published to S3 as artifacts.

## Operations

- Deploy an update with `./deploy/server-deploy.sh origin/main`. The script
  serializes deployments, refuses non-fast-forward targets, classifies the Git
  diff, and builds all affected images together so BuildKit can reuse the
  dependency and package-build layers. It then runs only required migrations or
  role setup, restarts only affected services, and waits for Compose and public
  health checks before recording the deployed commit.
- A web-only change builds and restarts only `web`. An API-only change builds
  and restarts only `api`. Changes to shared packages expand to the exact
  consumers declared by `deploy/deployment-impact.sh`; its behavior is covered
  by `pnpm check:deploy`.
- Keep RDS automated backups and point-in-time recovery enabled for both databases, copy snapshots across accounts or Regions when policy requires it, and test an RDS restore quarterly. Protect S3 independently with versioning and lifecycle rules. The local `deploy/backup.sh` and `deploy/restore.sh` scripts are for the non-AWS Compose profile and must not be used against RDS.
- Apply OS security updates automatically. Rebuild and redeploy Berry from a pinned Git commit; do not edit a running container.
- Monitor disk, memory, Postgres health, Redis health, HTTP 5xx rate, Caddy certificate renewal, BerryRouter/E2B latency, budget rejections, and backup freshness.
- Keep `deploy/.env.production` mode `0600`, never commit it, and rotate BerryRouter, E2B, BerryCrawl, auth, database, usage-signing, and SCIM secrets after any suspected exposure.
