import { Sandbox } from "e2b";

const templateId = process.env.E2B_TEMPLATE_ID;
if (!templateId) {
  throw new Error("Set E2B_TEMPLATE_ID to the newly built template ID");
}

const sandbox = await Sandbox.create(templateId, { timeoutMs: 180_000 });
try {
  const command = [
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
  const result = await sandbox.commands.run(command, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) {
    throw new Error(`smoke test failed\n${result.stdout}\n${result.stderr}`);
  }
  console.log(JSON.stringify({ ok: true, templateId, stdout: result.stdout }, null, 2));
} finally {
  await sandbox.kill();
}
