import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "e2b";

const templateId = process.env.E2B_TEMPLATE_ID ?? process.env.BERRY_E2B_TEMPLATE_ID;
if (!templateId) throw new Error("Set E2B_TEMPLATE_ID or BERRY_E2B_TEMPLATE_ID to the template ID");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const localSkillsRoot = resolve(process.env.AESG_SKILLS_ROOT ?? join(scriptDirectory, "..", "skills"));
const runtimeSkillsRoot = "/workspace/runtime-skills/smoke";
const sandbox = await Sandbox.create(templateId, { timeoutMs: 180_000 });

try {
  const runChecked = async (label: string, command: string, timeoutMs = 120_000) => {
    try {
      return await sandbox.commands.run(command, { timeoutMs });
    } catch (error) {
      const result = (error as { result?: { exitCode?: number; stdout?: string; stderr?: string; error?: string } }).result;
      throw new Error(`${label} failed (exit ${result?.exitCode ?? "unknown"})\n${result?.stdout ?? ""}\n${result?.stderr ?? result?.error ?? String(error)}`);
    }
  };

  const localFiles = await recursiveFiles(localSkillsRoot);
  for (const localPath of localFiles) {
    const bytes = await readFile(localPath);
    const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await sandbox.files.write(`${runtimeSkillsRoot}/${relative(localSkillsRoot, localPath).replaceAll("\\", "/")}`, content);
  }

  const dependencyChecks = [
    ["Dynamic skill workspace", `test -d ${runtimeSkillsRoot} && test ! -e /managed-skills`],
    ["AESG branding package", `test -f ${runtimeSkillsRoot}/aesg-branding/assets/templates/AESG_General_Report_Template.docx`],
    ["CV Creator package", `test -f ${runtimeSkillsRoot}/cv-creator/scripts/generate_cv_from_spec.py`],
    ["Skill Creator package", `test -f ${runtimeSkillsRoot}/skill-creator/SKILL.md`],
    ["DOCX package", `test -f ${runtimeSkillsRoot}/docx/scripts/create_aesg_docx.py`],
    ["PDF package", `test -f ${runtimeSkillsRoot}/pdf/scripts/create_aesg_pdf.py`],
    ["XLSX package", `test -f ${runtimeSkillsRoot}/xlsx/scripts/create_aesg_xlsx.py`],
    ["PPTX package", `test -f ${runtimeSkillsRoot}/pptx/scripts/create_aesg_pptx.py`],
    ["Verdana font", "test \"$(fc-match -f '%{family}' Verdana)\" = Verdana"],
    ["Python artifact libraries", "python -c \"import docx,docxtpl,pptx,openpyxl,reportlab,pypdf\""],
    ["LibreOffice", "soffice --version"],
    ["Poppler", "pdfinfo -v"],
    ["QPDF", "qpdf --version"],
  ] as const;
  const dependencyOutput: string[] = [];
  for (const [label, command] of dependencyChecks) {
    const result = await runChecked(label, command);
    if (result.stdout) dependencyOutput.push(result.stdout);
  }

  const specs = smokeSpecs();
  await sandbox.commands.run("mkdir -p /workspace/tmp/smoke /workspace/outputs");
  await Promise.all(Object.entries(specs).map(([name, spec]) => sandbox.files.write(`/workspace/tmp/smoke/${name}.json`, JSON.stringify(spec))));

  const branding = `${runtimeSkillsRoot}/aesg-branding`;
  const generationCheck = [
    "set -eu",
    `python ${runtimeSkillsRoot}/docx/scripts/create_aesg_docx.py --spec /workspace/tmp/smoke/docx.json --output /workspace/outputs/aesg-smoke.docx --branding-skill-dir ${branding}`,
    `python ${runtimeSkillsRoot}/pdf/scripts/create_aesg_pdf.py --spec /workspace/tmp/smoke/pdf.json --output /workspace/outputs/aesg-smoke.pdf --docx-skill-dir ${runtimeSkillsRoot}/docx --branding-skill-dir ${branding}`,
    `python ${runtimeSkillsRoot}/xlsx/scripts/create_aesg_xlsx.py --spec /workspace/tmp/smoke/xlsx.json --output /workspace/outputs/aesg-smoke.xlsx --branding-skill-dir ${branding}`,
    `python ${runtimeSkillsRoot}/pptx/scripts/create_aesg_pptx.py --spec /workspace/tmp/smoke/pptx.json --output /workspace/outputs/aesg-smoke.pptx --branding-skill-dir ${branding}`,
    "python -c \"from PIL import Image; Image.new('RGB', (640, 800), (96, 128, 144)).save('/workspace/tmp/smoke/cv-photo.jpg', 'JPEG')\"",
    `python ${runtimeSkillsRoot}/cv-creator/scripts/generate_cv_from_spec.py --spec /workspace/tmp/smoke/cv.json --photo /workspace/tmp/smoke/cv-photo.jpg --batch-root /workspace/tmp/smoke/cv-batch --deliverables-dir /workspace/outputs`,
    ...["aesg-smoke.docx", "aesg-smoke.pdf", "aesg-smoke.xlsx", "aesg-smoke.pptx", "cv-creator-smoke_portrait.docx", "cv-creator-smoke_landscape.docx", "cv-creator-smoke_portrait.pptx", "cv-creator-smoke_landscape.pptx"]
      .map((name) => `python ${branding}/scripts/validate_artifact.py /workspace/outputs/${name}`),
    "test \"$(find /workspace/outputs -maxdepth 1 -type f | wc -l)\" -eq 8",
  ].join(" && ");
  const generationResult = await runChecked("Artifact generation", generationCheck, 240_000);

  const stagedBytes = Buffer.alloc(256 * 1024, 0xa5);
  const stageHandle = await sandbox.commands.run(
    "mkdir -p /workspace/inputs/smoke && sh -c 'base64 -d > \"$1\"' berry-stage /workspace/inputs/smoke/large.bin",
    { background: true, stdin: true, timeoutMs: 120_000 },
  );
  if (!("pid" in stageHandle)) throw new Error("E2B did not return a staging command handle");
  await stageHandle.sendStdin(stagedBytes.toString("base64"));
  await stageHandle.closeStdin();
  const stageResult = await stageHandle.wait();
  if (stageResult.exitCode !== 0) throw new Error(`streaming attachment staging failed\n${stageResult.stdout}\n${stageResult.stderr}`);
  const stagedHash = createHash("sha256").update(stagedBytes).digest("hex");
  await runChecked("Runtime reads", [
    "set -eu",
    `test \"$(sha256sum /workspace/inputs/smoke/large.bin | cut -d' ' -f1)\" = \"${stagedHash}\"`,
    "pdftotext -layout /workspace/outputs/aesg-smoke.pdf - | grep -q 'AESG Sandbox Validation'",
    `grep -q 'AESG' ${branding}/references/brand-system.md`,
  ].join(" && "));

  console.log(JSON.stringify({
    ok: true,
    templateId,
    stagedPackageFiles: localFiles.length,
    dependencies: dependencyOutput.join("\n"),
    artifacts: generationResult.stdout,
    runtimeReads: "database-shaped packages, eight artifacts, validators, and streamed input verified",
  }, null, 2));
} finally {
  await sandbox.kill();
}

async function recursiveFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await recursiveFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function smokeSpecs() {
  return {
    docx: { kind: "report", title: "AESG Sandbox Validation", subtitle: "DOCX generation smoke test", date: "13 August 2026", sections: [{ heading: "Executive summary", paragraphs: ["The branded document generator is ready for production."], bullets: ["Template retained.", "Output validated."] }] },
    pdf: { kind: "report", title: "AESG Sandbox Validation", subtitle: "PDF generation smoke test", date: "13 August 2026", sections: [{ heading: "Executive summary", paragraphs: ["The branded PDF route is ready for production."] }] },
    xlsx: { title: "AESG Sandbox Validation", sheet: "Status", columns: [{ key: "workstream", label: "Workstream", width: 28 }, { key: "status", label: "Status", width: 16 }, { key: "progress", label: "Progress", width: 14, format: "0%" }], rows: [{ workstream: "Brand compliance", status: "Ready", progress: 1 }, { workstream: "Runtime validation", status: "Ready", progress: 1 }], chart: { type: "bar", category: "workstream", value: "progress", title: "Readiness" } },
    pptx: { title: "AESG Sandbox Validation", slides: [{ layout: "cover", title: "AESG Sandbox Validation", subtitle: "General Template smoke test", date: "13 August 2026" }, { layout: "three_columns", title: "Generation workflow", section: "Runtime validation", columns: [{ title: "Create", body: "Generate from the retained template." }, { title: "Validate", body: "Run structural and brand checks." }, { title: "Publish", body: "Persist only the final deliverable." }] }] },
    cv: { source_filename: "cv-creator-smoke.pdf", name: "Jordan Rahman", role: "Sustainability Consultant", overview: "Sustainability consultant experienced in environmental performance, project coordination, and certification delivery.", work_experience: [{ start_date: "2022", end_date: "Present", role: "Sustainability Consultant", organisation: "AESG", location: "Dubai, UAE", description: "" }], key_expertise: ["Sustainability advisory", "Green building certifications"], qualifications: ["MSc Sustainable Design, 2021"], memberships: [], selected_projects: [{ name: "Regional mixed-use development", duration: "2023 - Present", role: "Sustainability Consultant", client: "", location: "Riyadh, KSA", description: "Supported sustainability coordination and certification documentation.", bullets: [] }], confirm_no_work_experience: false, confirm_no_selected_projects: false },
  };
}
