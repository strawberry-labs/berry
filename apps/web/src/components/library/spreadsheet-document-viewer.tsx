import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { DataGrid, type Column } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import type { SpreadsheetSheet, SpreadsheetWorkerRequest, SpreadsheetWorkerResponse } from "./spreadsheet-types";
import { fileExtension, filePreviewDecision, PREVIEW_LIMITS } from "./file-preview-policy";

type GridRow = {
  rowNumber: number;
  cells: string[];
};

type Selection = {
  address: string;
  value: string;
};

export default function SpreadsheetDocumentViewer({ file }: { file: StoredFile }) {
  const workerRef = React.useRef<Worker | null>(null);
  const [sheetNames, setSheetNames] = React.useState<string[]>([]);
  const [sheet, setSheet] = React.useState<SpreadsheetSheet | null>(null);
  const [selection, setSelection] = React.useState<Selection>({ address: "A1", value: "" });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const requestTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = React.useRef(false);
  const pendingSheetRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const decision = filePreviewDecision(file);
    cancelledRef.current = false;
    pendingSheetRef.current = null;
    if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current);
    requestTimeoutRef.current = null;
    setLoading(true);
    setError(null);
    setSheet(null);
    setSheetNames([]);
    if (!decision.allowed || decision.kind !== "spreadsheet") {
      setError(decision.reason ?? "This workbook cannot be previewed safely.");
      setLoading(false);
      return () => undefined;
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL("./spreadsheet-parser.worker.ts", import.meta.url), { type: "module" });
    } catch {
      setError("The spreadsheet preview could not be started safely.");
      setLoading(false);
      return () => undefined;
    }
    workerRef.current = worker;
    let cancelled = false;

    worker.onmessage = (event: MessageEvent<SpreadsheetWorkerResponse>) => {
      if (cancelled || cancelledRef.current) return;
      if (event.data.type === "error") {
        cancelled = true;
        cancelledRef.current = true;
        pendingSheetRef.current = null;
        if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current);
        requestTimeoutRef.current = null;
        worker.terminate();
        workerRef.current = null;
        setError(event.data.message);
        setLoading(false);
        return;
      }
      if (event.data.type === "ready") setSheetNames(event.data.sheetNames);
      if (event.data.type === "sheet" && pendingSheetRef.current !== event.data.sheet.name) return;
      pendingSheetRef.current = null;
      if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
      setSheet(event.data.sheet);
      setSelection(firstSelection(event.data.sheet));
      setLoading(false);
    };
    worker.onerror = () => {
      if (cancelled || cancelledRef.current) return;
      cancelled = true;
      cancelledRef.current = true;
      pendingSheetRef.current = null;
      if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
      worker.terminate();
      workerRef.current = null;
      setError("The spreadsheet preview could not be started.");
      setLoading(false);
    };
    try {
      worker.postMessage({
        type: "load",
        url: file.previewUrl,
        extension: fileExtension(file.name) || "xlsx",
        maxSourceBytes: decision.maxSourceBytes ?? PREVIEW_LIMITS.spreadsheetBytes,
        maxSheets: PREVIEW_LIMITS.maxSpreadsheetSheets,
      } satisfies SpreadsheetWorkerRequest);
    } catch {
      cancelled = true;
      cancelledRef.current = true;
      pendingSheetRef.current = null;
      worker.terminate();
      workerRef.current = null;
      setError("The spreadsheet preview could not be started safely.");
      setLoading(false);
      return () => undefined;
    }
    requestTimeoutRef.current = setTimeout(() => {
      cancelled = true;
      cancelledRef.current = true;
      pendingSheetRef.current = null;
      worker.terminate();
      workerRef.current = null;
      setError("Spreadsheet preview inspection timed out. Download the workbook to open it safely.");
      setLoading(false);
    }, 15_000);

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      pendingSheetRef.current = null;
      if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
      workerRef.current = null;
      worker.terminate();
    };
  }, [file.id, file.name, file.previewUrl]);

  const rows = React.useMemo<GridRow[]>(() => sheet?.rows.map((cells, index) => ({
    rowNumber: (sheet.rowOffset ?? 0) + index + 1,
    cells,
  })) ?? [], [sheet]);

  const columns = React.useMemo<Column<GridRow>[]>(() => {
    if (!sheet) return [];
    const visibleColumns = Math.max(1, Math.min(sheet.totalColumns, PREVIEW_LIMITS.maxSpreadsheetColumns));
    return [
      {
        key: "__rowNumber",
        name: "",
        width: 52,
        minWidth: 52,
        maxWidth: 52,
        frozen: true,
        cellClass: "berry-spreadsheet-row-number",
        headerCellClass: "berry-spreadsheet-corner",
        renderCell: ({ row }) => row.rowNumber,
      },
      ...Array.from({ length: visibleColumns }, (_, columnIndex): Column<GridRow> => ({
        key: `c${columnIndex}`,
        name: spreadsheetColumn(sheet.columnOffset + columnIndex),
        width: 120,
        minWidth: 72,
        maxWidth: 420,
        resizable: true,
        renderCell: ({ row }) => row.cells[columnIndex] ?? "",
      })),
    ];
  }, [sheet]);

  const openSheet = React.useCallback((name: string) => {
    if (!workerRef.current || cancelledRef.current || name === sheet?.name) return;
    setLoading(true);
    setError(null);
    if (requestTimeoutRef.current) clearTimeout(requestTimeoutRef.current);
    try {
      pendingSheetRef.current = name;
      workerRef.current.postMessage({ type: "sheet", name } satisfies SpreadsheetWorkerRequest);
      requestTimeoutRef.current = setTimeout(() => {
        cancelledRef.current = true;
        pendingSheetRef.current = null;
        workerRef.current?.terminate();
        workerRef.current = null;
        setError("This sheet took too long to prepare. Download the workbook to open it safely.");
        setLoading(false);
      }, 15_000);
    } catch {
      pendingSheetRef.current = null;
      workerRef.current.terminate();
      workerRef.current = null;
      setError("The spreadsheet sheet could not be opened safely.");
      setLoading(false);
    }
  }, [sheet?.name]);

  if (error) throw new Error(error);

  return (
    <div className="berry-spreadsheet-viewer" aria-label={`Preview of ${file.name}`}>
      <div className="berry-spreadsheet-formula-bar">
        <output className="berry-spreadsheet-address" aria-label="Selected cell">{selection.address}</output>
        <span className="berry-spreadsheet-fx" aria-hidden="true">fx</span>
        <output className="berry-spreadsheet-value" aria-label="Selected cell value">{selection.value}</output>
      </div>
      <div className="berry-spreadsheet-grid-wrap">
        {sheet ? (
          <DataGrid
            className="rdg-light berry-spreadsheet-grid"
            columns={columns}
            rows={rows}
            rowKeyGetter={(row) => row.rowNumber}
            rowHeight={29}
            headerRowHeight={29}
            enableVirtualization
            onCellClick={({ column, row }) => {
              if (column.key === "__rowNumber") {
                setSelection({ address: String(row.rowNumber), value: "" });
                return;
              }
              const columnIndex = Number(column.key.slice(1));
              setSelection({
                address: `${spreadsheetColumn((sheet.columnOffset ?? 0) + columnIndex)}${row.rowNumber}`,
                value: row.cells[columnIndex] ?? "",
              });
            }}
          />
        ) : null}
        {loading ? <div className="berry-spreadsheet-loading" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} className="text-[var(--berry-spreadsheet-accent)]" label="Opening workbook" /></div> : null}
      </div>
      <footer className="berry-spreadsheet-footer">
        <span className="berry-spreadsheet-status">Ready</span>
        <div className="berry-spreadsheet-tabs" role="tablist" aria-label="Workbook sheets">
          {sheetNames.map((name) => (
            <button
              type="button"
              role="tab"
              aria-selected={name === sheet?.name}
              className={name === sheet?.name ? "is-active" : undefined}
              key={name}
              onClick={() => openSheet(name)}
            >
              {name}
            </button>
          ))}
        </div>
        {sheet ? <span className="berry-spreadsheet-dimensions">{sheet.totalRows.toLocaleString()} rows · {sheet.totalColumns.toLocaleString()} columns{sheet.truncated ? " · preview capped" : ""}</span> : null}
      </footer>
    </div>
  );
}

function firstSelection(sheet: SpreadsheetSheet): Selection {
  return {
    address: `${spreadsheetColumn(sheet.columnOffset)}${sheet.rowOffset + 1}`,
    value: sheet.rows[0]?.[0] ?? "",
  };
}

function spreadsheetColumn(index: number) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}
