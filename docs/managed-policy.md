# Managed policy bundles

Berry accepts an MDM-delivered `berry-policy.json` whose Ed25519 signature is verified by the Rust desktop shell before the host can read it. A bundle controls managed execpolicy rules, model/MCP/plugin allowlists, the maximum sandbox access tier, and telemetry.

## Managed locations

- macOS: `/Library/Managed Preferences/com.berry.chat/berry-policy.json`
- Linux: `/etc/berry/berry-policy.json`
- Windows: `%PROGRAMDATA%\Berry\berry-policy.json`
- Test or custom deployment: set `BERRY_MANAGED_POLICY_PATH`.

The trust anchor is a base64-encoded raw 32-byte Ed25519 public key. Put it beside the bundle as `<policy-path>.pub` (for example, `berry-policy.json.pub`) or set `BERRY_MANAGED_POLICY_PUBLIC_KEY`. The public key is intentionally not read from the signed bundle.

## Sign a bundle

Start from `config/berry-policy.example.json`, which is intentionally unsigned.

```sh
openssl genpkey -algorithm ED25519 -out berry-policy-private.pem
node scripts/sign-policy.mjs \
  config/berry-policy.example.json \
  berry-policy.json \
  berry-policy-private.pem \
  example-org-2026 \
  berry-policy.json.pub
```

If the installed OpenSSL does not support Ed25519, generate the same PKCS#8 PEM with Node.js:

```sh
node -e "const fs=require('node:fs'),c=require('node:crypto'); const {privateKey}=c.generateKeyPairSync('ed25519'); fs.writeFileSync('berry-policy-private.pem', privateKey.export({format:'pem',type:'pkcs8'}))"
```

Keep the private key outside the app and MDM payload. Distribute only `berry-policy.json` and `berry-policy.json.pub`. The signer and Rust verifier both sign recursively key-sorted compact JSON after removing the top-level `signature` field.

## Enforcement semantics

- Empty allowlists do not restrict that resource class. Non-empty lists accept exact values or `*` wildcards against resource IDs and names. Models also match model ID, `<provider-id>/<model-id>`, and `<provider-kind>/<model-id>`.
- Managed execpolicy rules enter the `managed` layer and remain read-only. The normal strictest-decision rule still applies.
- `sandboxFloor` is the maximum access Berry may grant: `read-only` caps every task at read-only; `workspace-write` prevents danger/full-access execution; `danger-full-access` adds no managed cap.
- `telemetry` may be `disabled`, `optional`, or `required`. Managed disabled/required values cannot be overridden in settings.
- Expired, malformed, missing-key, or signature-invalid bundles are rejected as a whole. They are not partially applied. Security settings show the rejection, and the local audit log records it.

Platform-login distribution is intentionally deferred to Phase 9. The Phase 6 path is MDM/file-drop only.
