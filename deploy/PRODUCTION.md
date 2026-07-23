# Berry single-box production deployment

This topology is for one private organization with roughly 5–10 users at `aesg-v2.berry.me`. Caddy is the only public container. It terminates TLS and serves the web app and API on one origin; Postgres, Redis, MinIO, the web process, and the API remain on Docker's internal network or loopback.

## Server and account prerequisites

- One x86-64 Hetzner server running Ubuntu 24.04 LTS. The recommended starting shape is CPX42 (8 shared AMD vCPU, 16 GB RAM, 320 GB SSD); CCX23 (4 dedicated AMD vCPU, 16 GB RAM, 160 GB SSD) is the predictable-performance alternative. Add a public IPv4 address and enable Hetzner backups. Since E2B provides execution, the box does not need local sandbox capacity. An 8 GB machine can smoke-test the stack, but 16 GB leaves safe headroom for image builds, Postgres, object storage, and concurrent streams.
- DNS control for `berry.me`; create `A` records for both `aesg-v2.berry.me` and `files.aesg-v2.berry.me` pointing to the server. The second host serves only presigned MinIO transfers, so 200–300 MB files bypass the API process. Add `AAAA` only when IPv6 is configured and reachable.
- Firewall ingress for TCP 80 and 443, UDP 443, and SSH from administrator IPs only. Do not expose 3001, 3108, 5432, 6379, 9000, or 9001.
- Docker Engine with the Compose v2 plugin, Git, curl, openssl, and enough free disk to build the monorepo image.
- BerryRouter inference URL/key, exact Router IDs for Kimi 2.6 and GLM 5.2, their input/output prices per million tokens, the chat-completions path, and an image model/path.
- An E2B Cloud team with billing enabled, a server API key, and either the built-in `base` template or a reviewed custom template ID. The E2B key is injected only into the private API container and never reaches the web app or browser.
- BerryCrawl public HTTPS MCP URL and bearer key.
- The initial account email allow-list, plus a decision on whether subsequent self-service signup remains enabled.
- An off-box destination for the dated Postgres and MinIO backups created by the included backup script.

This deployment uses a pinned, network-private MinIO Community image. It is suitable for the 5–10-user test, but its data shares the Hetzner failure domain and the historical Community images are not maintained. Copy every dated backup off the server and enable Hetzner server backups.

## External service contracts required by this build

Inference must expose an OpenAI-compatible streaming `POST /chat/completions` beneath `BERRY_ROUTER_INFERENCE_BASE_URL`. It must preserve streaming text, tool-call deltas, token usage, model identity, and provider identity. Image generation must accept OpenAI-style `POST /images/generations` with `model`, `prompt`, `n`, `size`, and `response_format`, returning `data[0].b64_json` or `data[0].url`.

Code execution does not pass through BerryRouter. The API uses the official E2B JavaScript SDK with `E2B_API_KEY` to create and reconnect sandboxes, stream commands, read and write files, and resolve preview hosts. Sandboxes are created with authenticated inbound traffic, the Berry network policy, and an automatic filesystem-preserving pause after `BERRY_SANDBOX_TTL_SECONDS`. A later turn reconnects by stable tenant/request metadata, including after an API process restart. `BERRY_E2B_KEEP_MEMORY_ON_PAUSE=false` is the recommended default: it preserves the filesystem but cold-boots on resume instead of retaining process memory.

`BERRY_E2B_TEMPLATE_ID=base` is enough for the first Node/Python test. For a controlled client deployment, build and pin a custom E2B template containing every required runtime and package. E2B compute size comes from that template/account configuration; `BERRY_SANDBOX_CPU_COUNT`, `BERRY_SANDBOX_MEMORY_MIB`, and `BERRY_SANDBOX_DISK_MIB` are Berry's metering estimates and must match the selected template. Set `BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS` to the selected template's total current price in USD micros/hour and `BERRY_BUDGET_SANDBOX_EXEC_ESTIMATE_MICROS` to a conservative pre-execution reservation. Berry reconciles the reservation against measured command runtime.

Model turns, image generations, and direct E2B operations write first-party usage records. The sandbox provider records runtime and configured resource estimates; set the `BERRY_BUDGET_SANDBOX_*_ESTIMATE_MICROS` values from the actual E2B plan before enforcing hard dollar limits. For authoritative Router or BerryCrawl charges beyond built-in records, configure those services to send signed usage events to `POST https://aesg-v2.berry.me/v1/orgs/00000000-0000-7000-8000-000000000001/usage/events` using the `router-prod` key ID and the matching secret from `BERRY_USAGE_SIGNING_SECRETS`.

## First deployment

```sh
sudo install -d -m 0750 /opt/berry /var/backups/berry
sudo chown -R "$USER":"$USER" /opt/berry /var/backups/berry
git clone YOUR_REPOSITORY_URL /opt/berry
cd /opt/berry
cp deploy/.env.production.example deploy/.env.production
chmod 600 deploy/.env.production
# Run the hex command four times for Postgres, MinIO, usage signing, and setup.
openssl rand -hex 32
openssl rand -base64 36
./deploy/production-up.sh
```

Fill every `REPLACE_WITH` value before running the script. The API runs additive Postgres migrations before listening. Caddy obtains and renews the certificate after DNS resolves and ports 80/443 are reachable.

Use URL-safe hexadecimal values for the Postgres, MinIO, setup, and usage-webhook secrets because the Postgres password is interpolated into a connection URL and the setup key is printed in a URL fragment. Use a separate 36-byte base64 value for `BETTER_AUTH_SECRET`. The launcher refuses to start while any `REPLACE_WITH` placeholder remains.

The launcher prints a one-time URL containing the setup key in the URL fragment, which is not sent in HTTP requests. Open it and create the configured owner account. Berry creates the owner, organization membership, default workspace ownership, and initial budgets in one locked database transaction. The database then reports setup complete, so the endpoint cannot create another owner even if the key is reused.

`BERRY_AUTH_SIGNUP_ENABLED=false` should remain the default. Owners and admins can create later email/password accounts and set each user's limit from Settings → Governance without reopening self-service signup. After verifying owner sign-in, clear both `BERRY_SETUP_OWNER_EMAIL` and `BERRY_SETUP_TOKEN` from the environment and restart the API; the completed database state remains authoritative.

## Go-live verification

```sh
docker compose --env-file deploy/.env.production -f deploy/compose.yaml ps
curl -fsS https://aesg-v2.berry.me/healthz
curl -I https://aesg-v2.berry.me/
curl -I https://files.aesg-v2.berry.me/minio/health/live
docker compose --env-file deploy/.env.production -f deploy/compose.yaml logs --tail=200 api web worker caddy
```

Then verify in the browser: signup/sign-in/sign-out; create and switch projects; create a task; send one turn through each configured model; run a BerryCrawl-backed research skill; paste, drop, and upload a file larger than 200 MB; open PDF, DOCX, XLSX, and PPTX previews; generate an image; execute code in an E2B sandbox and open its published output; set a small test budget and confirm an over-budget turn is blocked; inspect usage/model/audit data; restart the stack and confirm projects, tasks, messages, generated file records, and an E2B workspace test file remain.

Project records, tasks, messages, governance, budgets, usage, and audit data are durable in Postgres. Published artifacts and audit exports are durable in MinIO. E2B session files survive idle timeout and API restart through pause/reconnect. They are still provider-managed working state, not the system of record: explicit sandbox deletion, E2B account retention changes, or provider failure can remove them, so important outputs must be published to MinIO as artifacts.

## Operations

- Run `deploy/backup.sh` daily from systemd/cron, copy the dated Postgres and MinIO archive off-box, retain at least 7 daily and 4 weekly copies, and test restores quarterly.
- Restore drills use `BERRY_RESTORE_CONFIRM=YES ./deploy/restore.sh /path/to/backup`. The script verifies checksums, stops the application writers, restores Postgres and both object buckets, then restarts the application services.
- Apply OS security updates automatically. Rebuild and redeploy Berry from a pinned Git commit; do not edit a running container.
- Monitor disk, memory, Postgres health, Redis health, HTTP 5xx rate, Caddy certificate renewal, BerryRouter/E2B latency, budget rejections, and backup freshness.
- Keep `deploy/.env.production` mode `0600`, never commit it, and rotate BerryRouter, E2B, BerryCrawl, auth, database, MinIO, usage-signing, and SCIM secrets after any suspected exposure.
