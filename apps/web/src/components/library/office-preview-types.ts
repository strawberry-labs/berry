export type OfficePreviewKind = "docx" | "pptx" | "spreadsheet";

export type OfficePreviewWorkerRequest = {
  type: "inspect";
  url: string;
  kind: OfficePreviewKind;
  sourceBytes: number;
  maxSourceBytes: number;
  maxExpandedBytes: number;
  maxEntryCount: number;
  maxEntryBytes: number;
  maxSlides: number;
  maxPages: number;
};

export type OfficePreviewWorkerResponse =
  | { type: "ready"; entries: number; expandedBytes: number; slides: number | null; pages: number | null; bytes: ArrayBuffer }
  | { type: "error"; message: string };
