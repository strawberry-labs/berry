import * as XLSX from "xlsx";
import type { SpreadsheetSheet, SpreadsheetWorkerRequest, SpreadsheetWorkerResponse } from "./spreadsheet-types";
import { readResponseBytes } from "./preview-stream";
import { readZipEntries, readZipEntry, validateZipPayload } from "./zip-preview";
import { PREVIEW_LIMITS } from "./file-preview-policy";
import { assertDelimitedBounds, assertWorkbookCellBounds } from "./spreadsheet-preview-bounds";

const MAX_PREVIEW_ROWS = PREVIEW_LIMITS.maxSpreadsheetRows;
const MAX_PREVIEW_COLUMNS = PREVIEW_LIMITS.maxSpreadsheetColumns;
const MAX_PREVIEW_CELLS = PREVIEW_LIMITS.maxSpreadsheetCells;

let workbook: XLSX.WorkBook | null = null;

self.onmessage = (event: MessageEvent<SpreadsheetWorkerRequest>) => {
  if (event.data.type === "load") {
    void loadWorkbook(event.data.url, event.data.extension, event.data.maxSourceBytes, event.data.maxSheets);
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

async function loadWorkbook(url: string, extension: string, maxSourceBytes: number, maxSheets: number) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`File request failed (${response.status})`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxSourceBytes) throw new Error("The workbook is too large to preview safely.");
    const bytes = await readResponseBytes(response, maxSourceBytes);
    if (extension === "xls" && hasZipSignature(new Uint8Array(bytes))) {
      throw new Error("A legacy XLS preview cannot open a ZIP payload safely.");
    }
    if (extension === "xlsx") {
      const zipBytes = new Uint8Array(bytes);
      const zipEntries = readZipEntries(zipBytes, PREVIEW_LIMITS.archiveEntryCount);
      if (!zipEntries.some((entry) => entry.name === "[Content_Types].xml") || !zipEntries.some((entry) => entry.name === "xl/workbook.xml")) {
        throw new Error("The archive is not a valid spreadsheet.");
      }
      const worksheetCount = zipEntries.filter((entry) => /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)).length;
      if (worksheetCount === 0) throw new Error("This workbook does not contain a visible sheet.");
      if (worksheetCount > maxSheets) throw new Error("This workbook contains too many sheets to preview safely.");
      await validateZipPayload(zipBytes, {
        sourceBytes: maxSourceBytes,
        expandedBytes: PREVIEW_LIMITS.spreadsheetExpandedBytes,
        entryCount: PREVIEW_LIMITS.archiveEntryCount,
        entryBytes: PREVIEW_LIMITS.spreadsheetEntryBytes,
        expansionRatio: 100,
      }, zipEntries);
      let cellCount = 0;
      for (const entry of zipEntries.filter((candidate) => /^xl\/worksheets\//i.test(candidate.name))) {
        const xml = new TextDecoder().decode(await readZipEntry(zipBytes, entry, PREVIEW_LIMITS.spreadsheetEntryBytes));
        // OOXML permits namespace prefixes and self-closing cell elements;
        // count both before handing the workbook to SheetJS so a malformed
        // package cannot hide cells from the pre-parse budget.
        const cells = /<(?:[A-Za-z_][\w.-]*:)?c(?:\s|\/?>)/g;
        while (cells.exec(xml)) {
          cellCount += 1;
          if (cellCount > MAX_PREVIEW_CELLS) throw new Error("This workbook contains too many cells to preview safely.");
        }
      }
    } else if (extension === "csv" || extension === "tsv") {
      assertDelimitedBounds(new Uint8Array(bytes), extension === "tsv" ? "\t" : ",");
    }
    workbook = XLSX.read(bytes, {
      type: "array",
      cellDates: true,
      cellFormula: true,
      cellText: true,
      // Keep SheetJS sparse so a far-right cell cannot allocate a dense
      // million-column matrix before serializeSheet applies the preview window.
      dense: false,
      sheetRows: MAX_PREVIEW_ROWS + 1,
      ...(extension === "tsv" ? { FS: "\t" } : {}),
    });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) throw new Error("This workbook does not contain a visible sheet.");
    if (workbook.SheetNames.length > maxSheets) throw new Error("This workbook contains too many sheets to preview safely.");
    assertWorkbookCellBounds(workbook);
    post({ type: "ready", sheetNames: workbook.SheetNames, sheet: serializeSheet(firstSheet) });
  } catch (error) {
    workbook = null;
    post({ type: "error", message: errorMessage(error) });
  }
}

function hasZipSignature(bytes: Uint8Array): boolean {
  // Do not only inspect byte zero. Self-extracting ZIPs and other valid ZIP
  // payloads may carry a prefix before the first local/central/EOCD record.
  // A legacy BIFF workbook must never be handed to SheetJS when it contains
  // any ZIP record, because the unbounded ZIP path would bypass our archive
  // preflight. This conservative scan fails closed for suspicious BIFF data.
  for (let offset = 0; offset + 3 < bytes.length; offset += 1) {
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b) continue;
    const third = bytes[offset + 2];
    const fourth = bytes[offset + 3];
    if ((third === 0x03 && fourth === 0x04) || (third === 0x01 && fourth === 0x02) || (third === 0x05 && fourth === 0x06) || (third === 0x07 && fourth === 0x08)) return true;
  }
  return false;
}

function serializeSheet(name: string): SpreadsheetSheet {
  if (!workbook) throw new Error("The workbook is not ready yet.");
  const worksheet = workbook.Sheets[name];
  if (!worksheet) throw new Error(`Sheet “${name}” was not found.`);

  const usedRange = XLSX.utils.decode_range(worksheet["!ref"] ?? "A1:A1");
  const totalRows = Math.max(1, usedRange.e.r - usedRange.s.r + 1);
  const totalColumns = Math.max(1, usedRange.e.c - usedRange.s.c + 1);
  const visibleColumns = Math.min(totalColumns, MAX_PREVIEW_COLUMNS);
  const visibleRows = Math.min(totalRows, MAX_PREVIEW_ROWS, Math.max(1, Math.floor(MAX_PREVIEW_CELLS / visibleColumns)));
  const previewRange = {
    s: usedRange.s,
    e: {
      r: Math.min(usedRange.e.r, usedRange.s.r + visibleRows - 1),
      c: Math.min(usedRange.e.c, usedRange.s.c + visibleColumns - 1),
    },
  };
  const rows = XLSX.utils.sheet_to_json<string[]>(worksheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
    range: previewRange,
  });
  let outputCharacters = 0;
  for (const row of rows) {
    for (const value of row) {
      const text = String(value ?? "");
      if (text.length > PREVIEW_LIMITS.maxSpreadsheetCellBytes) throw new Error("A spreadsheet cell is too large to preview safely.");
      outputCharacters += text.length;
      if (outputCharacters > PREVIEW_LIMITS.maxSpreadsheetOutputBytes) throw new Error("The spreadsheet preview output is too large to clone safely.");
    }
  }

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
