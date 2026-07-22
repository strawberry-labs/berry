import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderHostProtocolDocs } from "../src/protocol-docs.ts";

const outPath = resolve("../../docs/protocol/host-methods.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, renderHostProtocolDocs());
