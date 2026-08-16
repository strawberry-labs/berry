import * as XLSX from "xlsx";
import { PREVIEW_LIMITS } from "./file-preview-policy";

export function assertDelimitedBounds(bytes: Uint8Array, delimiter: string): void {
  const text = new TextDecoder().decode(bytes);
  let quoted = false;
  let columns = 1;
  let cells = 0;
  let cellCharacters = 0;
  let lineHasContent = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\r" && text[index + 1] === "\n") continue;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
      lineHasContent = true;
    } else if (!quoted && character === delimiter) {
      if (cellCharacters > PREVIEW_LIMITS.maxSpreadsheetCellBytes) throw new Error("A spreadsheet cell is too large to preview safely.");
      columns += 1;
      if (columns > PREVIEW_LIMITS.maxSpreadsheetColumns) throw new Error("This spreadsheet contains too many columns to preview safely.");
      cellCharacters = 0;
      lineHasContent = true;
    } else if (!quoted && character === "\n") {
      if (cellCharacters > PREVIEW_LIMITS.maxSpreadsheetCellBytes) throw new Error("A spreadsheet cell is too large to preview safely.");
      cells += columns;
      if (cells > PREVIEW_LIMITS.maxSpreadsheetCells) throw new Error("This spreadsheet contains too many cells to preview safely.");
      columns = 1;
      cellCharacters = 0;
      lineHasContent = false;
    } else {
      cellCharacters += character?.length ?? 0;
      if (cellCharacters > PREVIEW_LIMITS.maxSpreadsheetCellBytes) throw new Error("A spreadsheet cell is too large to preview safely.");
      lineHasContent = true;
    }
  }
  if (cellCharacters > PREVIEW_LIMITS.maxSpreadsheetCellBytes) throw new Error("A spreadsheet cell is too large to preview safely.");
  if (lineHasContent) {
    cells += columns;
    if (cells > PREVIEW_LIMITS.maxSpreadsheetCells) throw new Error("This spreadsheet contains too many cells to preview safely.");
  }
}

export function assertWorkbookCellBounds(workbook: XLSX.WorkBook): void {
  let cells = 0;
  let outputCharacters = 0;
  for (const name of workbook.SheetNames) {
    const worksheet = workbook.Sheets[name];
    const range = XLSX.utils.decode_range(worksheet?.["!ref"] ?? "A1:A1");
    const rows = Math.max(1, range.e.r - range.s.r + 1);
    const columns = Math.max(1, range.e.c - range.s.c + 1);
    cells += Math.min(PREVIEW_LIMITS.maxSpreadsheetCells + 1, rows * columns);
    if (cells > PREVIEW_LIMITS.maxSpreadsheetCells) throw new Error("This workbook contains too many cells to preview safely.");
    for (const key of Object.keys(worksheet ?? {})) {
      if (key.startsWith("!")) continue;
      const value = String((worksheet as Record<string, { v?: unknown }>)[key]?.v ?? "");
      if (value.length > PREVIEW_LIMITS.maxSpreadsheetCellBytes) throw new Error("A spreadsheet cell is too large to preview safely.");
      outputCharacters += value.length;
      if (outputCharacters > PREVIEW_LIMITS.maxSpreadsheetOutputBytes) throw new Error("The spreadsheet preview output is too large to clone safely.");
    }
  }
}
