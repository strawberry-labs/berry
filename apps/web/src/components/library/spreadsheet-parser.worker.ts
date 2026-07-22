import * as XLSX from "xlsx";
import type { SpreadsheetSheet, SpreadsheetWorkerRequest, SpreadsheetWorkerResponse } from "./spreadsheet-types";

const MAX_PREVIEW_ROWS = 100_000;
const MAX_PREVIEW_COLUMNS = 500;

let workbook: XLSX.WorkBook | null = null;

self.onmessage = (event: MessageEvent<SpreadsheetWorkerRequest>) => {
  if (event.data.type === "load") {
    void loadWorkbook(event.data.url, event.data.extension);
    return;
  }

  if (!workbook) {
    post({ type: "error", message: "The workbook is not ready yet." });
    return;
  }

  try {
    post({ type: "sheet", sheet: serializeSheet(event.data.name) });
  } catch (error) {
    post({ type: "error", message: errorMessage(error) });
  }
};

async function loadWorkbook(url: string, extension: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`File request failed (${response.status})`);
    const bytes = await response.arrayBuffer();
    workbook = XLSX.read(bytes, {
      type: "array",
      cellDates: true,
      cellFormula: true,
      cellText: true,
      dense: true,
      ...(extension === "tsv" ? { FS: "\t" } : {}),
    });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) throw new Error("This workbook does not contain a visible sheet.");
    post({ type: "ready", sheetNames: workbook.SheetNames, sheet: serializeSheet(firstSheet) });
  } catch (error) {
    workbook = null;
    post({ type: "error", message: errorMessage(error) });
  }
}

function serializeSheet(name: string): SpreadsheetSheet {
  if (!workbook) throw new Error("The workbook is not ready yet.");
  const worksheet = workbook.Sheets[name];
  if (!worksheet) throw new Error(`Sheet “${name}” was not found.`);

  const usedRange = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1:A1");
  const totalRows = Math.max(1, usedRange.e.r - usedRange.s.r + 1);
  const totalColumns = Math.max(1, usedRange.e.c - usedRange.s.c + 1);
  const previewRange = {
    s: usedRange.s,
    e: {
      r: Math.min(usedRange.e.r, usedRange.s.r + MAX_PREVIEW_ROWS - 1),
      c: Math.min(usedRange.e.c, usedRange.s.c + MAX_PREVIEW_COLUMNS - 1),
    },
  };
  const rows = XLSX.utils.sheet_to_json<string[]>(worksheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
    range: previewRange,
  });

  return {
    name,
    rows,
    columnOffset: usedRange.s.c,
    rowOffset: usedRange.s.r,
    totalColumns,
    totalRows,
    truncated: totalRows > MAX_PREVIEW_ROWS || totalColumns > MAX_PREVIEW_COLUMNS,
  };
}

function post(message: SpreadsheetWorkerResponse) {
  self.postMessage(message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
