import { zodToJsonSchema } from "zod-to-json-schema";
import { HostMethodCatalog, PROTOCOL_VERSION } from "./index.ts";

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function renderHostProtocolDocs(): string {
  const methods = Object.entries(HostMethodCatalog).sort(([left], [right]) => left.localeCompare(right));
  const lines = [
    "# Berry Host Protocol",
    "",
    "Generated from `packages/shared/src/index.ts`. Do not edit by hand.",
    "",
    `Protocol version: \`${PROTOCOL_VERSION}\``,
    "",
    "## Handshake",
    "",
    "Clients send their `protocolVersion` in `host.handshake`. The host returns its protocol version and capability list. An incompatible major version fails with `protocol_mismatch`; clients must stop before issuing any mutating call.",
    "",
    "Socket clients must also send the token from `<socket-path>.token`. Missing or invalid tokens fail with `unauthorized`.",
    "",
    "## Methods",
    "",
  ];

  for (const [method, contract] of methods) {
    lines.push(
      `### \`${method}\``,
      "",
      "Params:",
      "",
      fencedJson(zodToJsonSchema(contract.params, `${method}.params`)),
      "",
      "Result:",
      "",
      fencedJson(zodToJsonSchema(contract.result, `${method}.result`)),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
