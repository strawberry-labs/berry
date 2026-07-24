import fs from "node:fs";
import { defaultBuildLogger, Template } from "e2b";
import { template } from "./template.ts";

const alias = process.env.E2B_TEMPLATE_ALIAS;
if (!alias || !/^aesg-artifacts-\d{4}-\d{2}-v\d+$/.test(alias)) {
  throw new Error(
    "E2B_TEMPLATE_ALIAS must be a new versioned alias such as aesg-artifacts-2026-07-v7",
  );
}
if (process.env.AESG_FONTS_CONFIRMED !== "1") {
  throw new Error(
    "Production build blocked: verify the Verdana licence and set AESG_FONTS_CONFIRMED=1",
  );
}
for (const filename of [
  "Verdana.ttf",
  "Verdana-Bold.ttf",
  "Verdana-Italic.ttf",
  "Verdana-BoldItalic.ttf",
]) {
  const path = `deploy/e2b-aesg/fonts/Verdana/${filename}`;
  if (!fs.existsSync(path)) {
    throw new Error(`Missing licensed font file: ${path}`);
  }
}

const result = await Template.build(template, alias, {
  cpuCount: 4,
  memoryMB: 8192,
  onBuildLogs: defaultBuildLogger(),
});
console.log(
  JSON.stringify(
    {
      alias,
      templateId: result.templateId,
      buildId: result.buildId,
      name: result.name,
    },
    null,
    2,
  ),
);
