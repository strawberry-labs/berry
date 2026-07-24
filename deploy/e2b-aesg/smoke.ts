import { Sandbox } from "e2b";

const templateId = process.env.E2B_TEMPLATE_ID;
if (!templateId) {
  throw new Error("Set E2B_TEMPLATE_ID to the newly built template ID");
}

const sandbox = await Sandbox.create(templateId, { timeoutMs: 180_000 });
try {
  const dependencyCheck = [
    "set -eu",
    "test -d /workspace/.berry/managed-skills/aesg-branding",
    "test -f /workspace/.berry/managed-skills/docx/scripts/create_aesg_docx.py",
    "test -f /workspace/.berry/managed-skills/pdf/scripts/create_aesg_pdf.py",
    "test -f /workspace/.berry/managed-skills/xlsx/scripts/create_aesg_xlsx.py",
    "test -f /workspace/.berry/managed-skills/pptx/scripts/create_aesg_pptx.py",
    "test \"$(fc-match -f '%{family}' Verdana)\" = Verdana",
    "python -c \"import docx,pptx,openpyxl,reportlab,pypdf\"",
    "soffice --version",
    "pdfinfo -v",
    "qpdf --version",
  ].join(" && ");
  const dependencyResult = await sandbox.commands.run(dependencyCheck, {
    timeoutMs: 120_000,
  });
  if (dependencyResult.exitCode !== 0) {
    throw new Error(
      `dependency smoke test failed\n${dependencyResult.stdout}\n${dependencyResult.stderr}`,
    );
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

  const skillRoot = "/workspace/.berry/managed-skills";
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
  const generationResult = await sandbox.commands.run(generationCheck, {
    timeoutMs: 180_000,
  });
  if (generationResult.exitCode !== 0) {
    throw new Error(
      `artifact smoke test failed\n${generationResult.stdout}\n${generationResult.stderr}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        templateId,
        dependencies: dependencyResult.stdout,
        artifacts: generationResult.stdout,
      },
      null,
      2,
    ),
  );
} finally {
  await sandbox.kill();
}
