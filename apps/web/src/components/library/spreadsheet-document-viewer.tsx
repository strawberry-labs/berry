import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { DataGrid, type Column } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import type { SpreadsheetSheet, SpreadsheetWorkerRequest, SpreadsheetWorkerResponse } from "./spreadsheet-types";

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

  React.useEffect(() => {
    const worker = new Worker(new URL("./spreadsheet-parser.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setLoading(true);
    setError(null);
    setSheet(null);
    setSheetNames([]);

    worker.onmessage = (event: MessageEvent<SpreadsheetWorkerResponse>) => {
      if (event.data.type === "error") {
        setError(event.data.message);
        setLoading(false);
        return;
      }
      if (event.data.type === "ready") setSheetNames(event.data.sheetNames);
      setSheet(event.data.sheet);
      setSelection(firstSelection(event.data.sheet));
      setLoading(false);
    };
    worker.onerror = () => {
      setError("The spreadsheet preview could not be started.");
      setLoading(false);
    };
    worker.postMessage({
      type: "load",
      url: file.previewUrl,
      extension: file.name.split(".").at(-1)?.toLowerCase() ?? "xlsx",
    } satisfies SpreadsheetWorkerRequest);

    return () => {
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
    const visibleColumns = Math.max(1, Math.min(sheet.totalColumns, 500));
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
    if (!workerRef.current || name === sheet?.name) return;
    setLoading(true);
    setError(null);
    workerRef.current.postMessage({ type: "sheet", name } satisfies SpreadsheetWorkerRequest);
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
        {loading ? <div className="berry-spreadsheet-loading" role="status"><span className="berry-document-spinner" />Opening workbook…</div> : null}
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
