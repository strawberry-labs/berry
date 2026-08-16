export type SpreadsheetSheet = {
  name: string;
  rows: string[][];
  columnOffset: number;
  rowOffset: number;
  totalColumns: number;
  totalRows: number;
  truncated: boolean;
};

export type SpreadsheetWorkerRequest =
  | { type: "load"; url: string; extension: string; maxSourceBytes: number; maxSheets: number }
  | { type: "sheet"; name: string };

export type SpreadsheetWorkerResponse =
  | { type: "ready"; sheetNames: string[]; sheet: SpreadsheetSheet }
  | { type: "sheet"; sheet: SpreadsheetSheet }
  | { type: "error"; message: string };
