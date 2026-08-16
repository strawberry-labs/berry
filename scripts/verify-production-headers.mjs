import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const caddy = readFileSync(resolve(root, "deploy/Caddyfile"), "utf8");
const policy = readFileSync(resolve(root, "apps/web/src/lib/site-csp.ts"), "utf8");
const rootRoute = readFileSync(resolve(root, "apps/web/src/routes/__root.tsx"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`[headers] ${message}`);
}

assert(caddy.includes('Content-Security-Policy "default-src \'none\'; sandbox"'), "file responses must retain sandbox CSP");
assert(!caddy.includes("script-src 'self' 'unsafe-inline'"), "Caddy must not reintroduce an unsafe inline application policy");
assert(policy.includes("'nonce-${options.nonce}'"), "SSR policy must require a per-response nonce");
for (const directive of ["default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'self'", "form-action 'self'", "script-src-attr 'none'", "worker-src 'self' blob:"]) {
  assert(policy.includes(directive), `missing ${directive}`);
}
assert(!policy.includes("script-src 'self' 'unsafe-inline'"), "script policy must not allow inline script execution");
assert(!policy.includes("connect-src 'self' https:"), "connect policy must not wildcard every HTTPS origin");
assert(rootRoute.includes("nonce={nonce}"), "the inline theme bootstrap must carry the SSR nonce");
console.log("[headers] production CSP checks passed");
