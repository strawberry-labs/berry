import { Sandbox } from "e2b";
import { createHash } from "node:crypto";

const templateId = process.env.E2B_TEMPLATE_ID ?? process.env.BERRY_E2B_TEMPLATE_ID;
if (!templateId) {
  throw new Error("Set E2B_TEMPLATE_ID or BERRY_E2B_TEMPLATE_ID to the template ID");
}

const sandbox = await Sandbox.create(templateId, { timeoutMs: 180_000 });
try {
  const runChecked = async (label: string, command: string, timeoutMs = 120_000) => {
    try {
      return await sandbox.commands.run(command, { timeoutMs });
    } catch (error) {
      const result = (error as {
        result?: { exitCode?: number; stdout?: string; stderr?: string; error?: string };
      }).result;
      throw new Error(
        `${label} failed (exit ${result?.exitCode ?? "unknown"})\n`
        + `${result?.stdout ?? ""}\n${result?.stderr ?? result?.error ?? String(error)}`,
      );
    }
  };
  const dependencyChecks = [
    ["AESG branding skill", "test -d /managed-skills/aesg-branding"],
    ["DOCX skill", "test -f /managed-skills/docx/scripts/create_aesg_docx.py"],
    ["PDF skill", "test -f /managed-skills/pdf/scripts/create_aesg_pdf.py"],
    ["XLSX skill", "test -f /managed-skills/xlsx/scripts/create_aesg_xlsx.py"],
    ["PPTX skill", "test -f /managed-skills/pptx/scripts/create_aesg_pptx.py"],
    ["Verdana font", "test \"$(fc-match -f '%{family}' Verdana)\" = Verdana"],
    ["Python artifact libraries", "python -c \"import docx,pptx,openpyxl,reportlab,pypdf\""],
    ["LibreOffice", "soffice --version"],
    ["Poppler", "pdfinfo -v"],
    ["QPDF", "qpdf --version"],
  ] as const;
  const dependencyOutput: string[] = [];
  for (const [label, command] of dependencyChecks) {
    const result = await runChecked(label, command);
    if (result.stdout) dependencyOutput.push(result.stdout);
  }

  const specs = {
    docx: {
      kind: "report",
      title: "AESG Sandbox Validation",
      subtitle: "DOCX generation smoke test",
      date: "24 July 2026",
      sections: [
        {
          heading: "Executive summary",
          paragraphs: ["The branded document generator is ready for production."],
          bullets: ["Template retained.", "Verdana declared.", "Output validated."],
        },
      ],
    },
    pdf: {
      kind: "report",
      title: "AESG Sandbox Validation",
      subtitle: "PDF generation smoke test",
      date: "24 July 2026",
      sections: [
        {
          heading: "Executive summary",
          paragraphs: ["The branded PDF route is ready for production."],
        },
      ],
    },
    xlsx: {
      title: "AESG Sandbox Validation",
      sheet: "Status",
      columns: [
        { key: "workstream", label: "Workstream", width: 28 },
        { key: "status", label: "Status", width: 16 },
        { key: "progress", label: "Progress", width: 14, format: "0%" },
      ],
      rows: [
        { workstream: "Brand compliance", status: "Ready", progress: 1 },
        { workstream: "Runtime validation", status: "Ready", progress: 1 },
      ],
      chart: {
        type: "bar",
        category: "workstream",
        value: "progress",
        title: "Readiness",
      },
    },
    pptx: {
      title: "AESG Sandbox Validation",
      slides: [
        { layout: "title", title: "AESG Sandbox Validation" },
        {
          layout: "three_columns",
          columns: [
            { title: "Create", body: "Generate from the retained template." },
            { title: "Validate", body: "Run structural and brand checks." },
            { title: "Publish", body: "Persist only the final deliverable." },
          ],
        },
      ],
    },
  };

  await sandbox.commands.run("mkdir -p /workspace/tmp/smoke /workspace/outputs");
  await Promise.all(
    Object.entries(specs).map(([name, spec]) =>
      sandbox.files.write(
        `/workspace/tmp/smoke/${name}.json`,
        JSON.stringify(spec),
      ),
    ),
  );

  const skillRoot = "/managed-skills";
  const generationCheck = [
    "set -eu",
    `python ${skillRoot}/docx/scripts/create_aesg_docx.py --spec /workspace/tmp/smoke/docx.json --output /workspace/outputs/aesg-smoke.docx`,
    `python ${skillRoot}/pdf/scripts/create_aesg_pdf.py --spec /workspace/tmp/smoke/pdf.json --output /workspace/outputs/aesg-smoke.pdf`,
    `python ${skillRoot}/xlsx/scripts/create_aesg_xlsx.py --spec /workspace/tmp/smoke/xlsx.json --output /workspace/outputs/aesg-smoke.xlsx`,
    `python ${skillRoot}/pptx/scripts/create_aesg_pptx.py --spec /workspace/tmp/smoke/pptx.json --output /workspace/outputs/aesg-smoke.pptx`,
    `python ${skillRoot}/aesg-branding/scripts/validate_artifact.py /workspace/outputs/aesg-smoke.docx`,
    `python ${skillRoot}/aesg-branding/scripts/validate_artifact.py /workspace/outputs/aesg-smoke.pdf`,
    `python ${skillRoot}/aesg-branding/scripts/validate_artifact.py /workspace/outputs/aesg-smoke.xlsx`,
    `python ${skillRoot}/aesg-branding/scripts/validate_artifact.py /workspace/outputs/aesg-smoke.pptx`,
    "test \"$(find /workspace/outputs -maxdepth 1 -type f | wc -l)\" -eq 4",
    "test -z \"$(find /workspace/outputs -maxdepth 1 -type f ! \\( -name '*.docx' -o -name '*.pdf' -o -name '*.xlsx' -o -name '*.pptx' \\) -print -quit)\"",
  ].join(" && ");
  const generationResult = await runChecked(
    "Artifact generation",
    generationCheck,
    180_000,
  );

  const stagedBytes = Buffer.alloc(256 * 1024, 0xa5);
  const stagedBase64 = stagedBytes.toString("base64");
  const stageHandle = await sandbox.commands.run(
    "mkdir -p /workspace/inputs/smoke && sh -c 'base64 -d > \"$1\"' berry-stage /workspace/inputs/smoke/large.bin",
    {
      background: true,
      stdin: true,
      timeoutMs: 120_000,
    },
  );
  if (!("pid" in stageHandle)) throw new Error("E2B did not return a staging command handle");
  await stageHandle.sendStdin(stagedBase64);
  await stageHandle.closeStdin();
  const stageResult = await stageHandle.wait();
  if (stageResult.exitCode !== 0) {
    throw new Error(`streaming attachment staging failed\n${stageResult.stdout}\n${stageResult.stderr}`);
  }
  const stagedHash = createHash("sha256").update(stagedBytes).digest("hex");
  await runChecked("Runtime reads", [
    "set -eu",
    `test "$(sha256sum /workspace/inputs/smoke/large.bin | cut -d' ' -f1)" = "${stagedHash}"`,
    "pdftotext -layout /workspace/outputs/aesg-smoke.pdf - | grep -q 'AESG Sandbox Validation'",
    "grep -q 'AESG' /managed-skills/aesg-branding/references/brand-system.md",
  ].join(" && "), 120_000);

  console.log(
    JSON.stringify(
      {
        ok: true,
        templateId,
        dependencies: dependencyOutput.join("\n"),
        artifacts: generationResult.stdout,
        runtimeReads: "large streamed input, PDF text, and managed skill reference verified",
      },
      null,
      2,
    ),
  );
} finally {
  await sandbox.kill();
}
