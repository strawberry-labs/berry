import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outputPath, privateKeyPath, keyId, publicKeyOutputPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !privateKeyPath || !keyId) {
  console.error("usage: node scripts/sign-policy.mjs <input.json> <output.json> <private-key.pem> <key-id> [public-key-output]");
  process.exit(2);
}

const bundle = JSON.parse(readFileSync(inputPath, "utf8"));
if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("policy input must be a JSON object");
if (!Number.isInteger(bundle.version) || bundle.version < 1) throw new Error("policy version must be a positive integer");
if (!bundle.organization?.id || !bundle.organization?.name || !bundle.policy) throw new Error("policy organization and policy fields are required");
delete bundle.signature;

const privateKey = createPrivateKey(readFileSync(privateKeyPath));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("private key must be Ed25519");
const signature = sign(null, Buffer.from(canonicalJson(bundle)), privateKey).toString("base64");
bundle.signature = { algorithm: "ed25519", keyId, value: signature };
writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

if (publicKeyOutputPath) {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const raw = der.subarray(-32);
  if (raw.length !== 32) throw new Error("could not export raw Ed25519 public key");
  writeFileSync(publicKeyOutputPath, `${raw.toString("base64")}\n`, "utf8");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
