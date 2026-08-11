import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBuildLogger, Template } from "e2b";
import { template } from "./template.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const buildRoot = path.join(repositoryRoot, "deploy/e2b-aesg/.build-context");
const expectedSuffix = path.join("deploy", "e2b-aesg", ".build-context");
if (!buildRoot.endsWith(expectedSuffix)) {
  throw new Error(`Refusing unexpected build context path: ${buildRoot}`);
}

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
  const fontPath = path.join(
    repositoryRoot,
    `deploy/e2b-aesg/fonts/Verdana/${filename}`,
  );
  if (!fs.existsSync(fontPath)) {
    throw new Error(`Missing licensed font file: ${fontPath}`);
  }
}

fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });
fs.cpSync(
  path.join(repositoryRoot, "deploy/skills"),
  path.join(buildRoot, "skills"),
  { recursive: true },
);
fs.cpSync(
  path.join(repositoryRoot, "deploy/e2b-aesg/requirements.lock"),
  path.join(buildRoot, "requirements.lock"),
);
fs.cpSync(
  path.join(repositoryRoot, "deploy/e2b-aesg/fonts"),
  path.join(buildRoot, "fonts"),
  { recursive: true },
);

const contextFiles: Array<{ path: string; bytes: number }> = [];
const visit = (directory: string) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Build context must not contain symlinks: ${absolute}`);
    }
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    const relative = path.relative(buildRoot, absolute);
    if (relative.split(path.sep).some((part) => part.startsWith(".env"))) {
      throw new Error(`Build context contains a forbidden environment file: ${relative}`);
    }
    contextFiles.push({ path: relative, bytes: fs.statSync(absolute).size });
  }
};
visit(buildRoot);
const topLevel = fs.readdirSync(buildRoot).sort();
if (JSON.stringify(topLevel) !== JSON.stringify(["fonts", "requirements.lock", "skills"])) {
  throw new Error(`Unexpected build-context roots: ${topLevel.join(", ")}`);
}
const contextBytes = contextFiles.reduce((total, file) => total + file.bytes, 0);
if (process.env.AESG_PREPARE_ONLY === "1") {
  console.log(
    JSON.stringify(
      {
        ok: true,
        buildRoot,
        files: contextFiles.length,
        bytes: contextBytes,
        topLevel,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const result = await Template.build(template, alias, {
  cpuCount: 1,
  memoryMB: 1024,
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
