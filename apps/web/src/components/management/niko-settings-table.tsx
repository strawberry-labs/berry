"use client";

import * as React from "react";
import type { ReactNode } from "react";

import { DataTableColumnHeader } from "@berry/desktop-ui/components/niko-table/components/data-table-column-header";
import { DataTableColumnSortMenu } from "@berry/desktop-ui/components/niko-table/components/data-table-column-sort";
import { DataTableColumnTitle } from "@berry/desktop-ui/components/niko-table/components/data-table-column-title";
import {
  DataTableEmptyDescription,
  DataTableEmptyFilteredMessage,
  DataTableEmptyMessage,
  DataTableEmptyTitle,
} from "@berry/desktop-ui/components/niko-table/components/data-table-empty-state";
import { DataTableFilterMenu } from "@berry/desktop-ui/components/niko-table/components/data-table-filter-menu";
import { DataTableSearchFilter } from "@berry/desktop-ui/components/niko-table/components/data-table-search-filter";
import { DataTableSortMenu } from "@berry/desktop-ui/components/niko-table/components/data-table-sort-menu";
import { DataTableToolbarSection } from "@berry/desktop-ui/components/niko-table/components/data-table-toolbar-section";
import { DataTableViewMenu } from "@berry/desktop-ui/components/niko-table/components/data-table-view-menu";
import { DataTable as NikoDataTable } from "@berry/desktop-ui/components/niko-table/core/data-table";
import { DataTableRoot } from "@berry/desktop-ui/components/niko-table/core/data-table-root";
import { useDataTable } from "@berry/desktop-ui/components/niko-table/core/data-table-context";
import {
  DataTableBody,
  DataTableEmptyBody,
  DataTableHeader,
  DataTableSkeleton,
} from "@berry/desktop-ui/components/niko-table/core/data-table-structure";
import type { DataTableColumnDef } from "@berry/desktop-ui/components/niko-table/types";
import { cn } from "@berry/desktop-ui/lib/utils";
import { useInsideSection } from "./section-context";
import { useFillHeight } from "../infinite-scroll-trigger";

/** Rows rendered per scroll step; tables grow by this many as you near the bottom. */
const ROW_BATCH = 50;

type SettingsTableRow = {
  id: string;
  sourceIndex: number;
  cells: ReactNode[];
  values: Array<string | number>;
};

/**
 * Cell components can describe themselves to the table without the table
 * importing them: a static `tableSortValue(props)` gives the value to sort by
 * and `tableAlignEnd` right-aligns the column (see `Num`). Plain elements can
 * carry `data-sort` instead.
 */
type TableCellProtocol = {
  tableSortValue?: (props: Record<string, unknown>) => string | number;
  tableAlignEnd?: boolean;
  tableText?: (props: Record<string, unknown>) => ReactNode;
};

function cellProtocol(node: ReactNode): TableCellProtocol | null {
  if (!React.isValidElement(node)) return null;
  const type = node.type as unknown;
  return typeof type === "function" || (typeof type === "object" && type !== null)
    ? (type as TableCellProtocol)
    : null;
}

function sortKey(node: ReactNode): string | number | undefined {
  if (!React.isValidElement<Record<string, unknown>>(node)) return undefined;
  const fromComponent = cellProtocol(node)?.tableSortValue?.(node.props);
  if (fromComponent !== undefined) return fromComponent;
  const attribute = node.props["data-sort"];
  return typeof attribute === "number" || typeof attribute === "string" ? attribute : undefined;
}

function alignsEnd(node: ReactNode): boolean {
  return cellProtocol(node)?.tableAlignEnd === true;
}

function cellText(node: ReactNode): string {
  const sortable = sortKey(node);
  if (sortable !== undefined) return String(sortable);
  if (node == null || typeof node === "boolean") return "";
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(cellText).join(" ");
  if (React.isValidElement<Record<string, unknown>>(node)) {
    const content = cellProtocol(node)?.tableText?.(node.props) ?? (node.props.children as ReactNode);
    return cellText(content);
  }
  return "";
}

/**
 * Shared Settings table backed by the installed Niko Table registry source.
 * The compatibility props keep existing screens concise while every table gets
 * the same typed TanStack model, advanced filters, sorting, visibility, empty
 * states, horizontal scrolling, and pagination controls.
 */
export function DataTable({
  label,
  columns,
  rows,
  onRowSelect,
  activeRow,
  rowLabel,
  initialPageSize = 10,
  searchable = rows.length > 5,
  skeleton,
  flexColumn,
  columnWidths,
}: {
  label: string;
  columns: string[];
  rows: Array<Array<ReactNode>>;
  onRowSelect?: (index: number) => void;
  activeRow?: number | null;
  rowLabel?: (index: number) => string;
  initialPageSize?: number;
  searchable?: boolean;
  /** Placeholder mode for `TableSkeleton`: real header, inert bars where the
   * toolbar and pagination sit, no sorting or selection. */
  skeleton?: { toolbar: boolean; pagination: boolean };
  /** The column that takes the spare width, e.g. a name with a description. */
  flexColumn?: number;
  /** Starting widths in px for the other columns; leave a slot undefined for the default. */
  columnWidths?: Array<number | undefined>;
}) {
  const insideSection = useInsideSection();
  // Search, filter, sort and column menus only earn their space once a table
  // is long enough to need them; short tables stay a plain list.
  const showTools = skeleton ? skeleton.toolbar : searchable;
  // Rows render in batches as the table scrolls instead of in pages.
  const batch = Math.max(initialPageSize, ROW_BATCH);
  const [visibleRows, setVisibleRows] = React.useState(batch);
  const hasMoreRows = !skeleton && visibleRows < rows.length;
  const showMoreRows = React.useCallback(() => setVisibleRows((count) => count + batch), [batch]);
  // A table that ends the page grows to the bottom of the screen; others keep a fixed cap.
  const regionRef = React.useRef<HTMLDivElement>(null);
  const fill = useFillHeight(
    () => regionRef.current?.querySelector<HTMLElement>('[data-slot="table-container"]') ?? null,
    // Re-measure when the rows change: a capped table keeps its box size, so nothing else would prompt it.
    { onlyWhenLast: true, minHeight: 280, deps: [rows, showTools] },
  );
  const sortable = !skeleton && (showTools || rows.length > 5);
  const tableRows = React.useMemo<SettingsTableRow[]>(
    () =>
      rows.map((cells, sourceIndex) => ({
        id: String(sourceIndex),
        sourceIndex,
        cells,
        values: cells.map((cell) => sortKey(cell) ?? cellText(cell)),
      })),
    [rows],
  );

  const numericColumns = React.useMemo(
    () =>
      columns.map(
        (_, columnIndex) =>
          tableRows.length > 0 &&
          tableRows.every((row) => alignsEnd(row.cells[columnIndex])),
      ),
    [columns, tableRows],
  );

  const tableColumns = React.useMemo<DataTableColumnDef<SettingsTableRow>[]>(
    () =>
      columns.map((labelText, columnIndex): DataTableColumnDef<SettingsTableRow> => {
        // An empty label marks a trailing actions column: no title, sort or filter.
        if (labelText === "") {
          return {
            id: `column-${columnIndex}`,
            accessorFn: () => "",
            header: () => <span className="sr-only">Actions</span>,
            cell: ({ row }) => (
              <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
                {row.original.cells[columnIndex] ?? null}
              </div>
            ),
            enableSorting: false,
            enableColumnFilter: false,
            enableHiding: false,
            enableResizing: false,
            size: 56,
            minSize: 56,
            maxSize: 56,
            meta: { label: "Actions" },
          };
        }
        const width = columnWidths?.[columnIndex];
        return {
        id: `column-${columnIndex}`,
        accessorFn: (row) => row.values[columnIndex] ?? "",
        ...(width ? { size: width } : {}),
        header: () => (
          <DataTableColumnHeader className={numericColumns[columnIndex] ? "justify-end" : undefined}>
            <DataTableColumnTitle />
            {sortable ? <DataTableColumnSortMenu /> : null}
          </DataTableColumnHeader>
        ),
        cell: ({ row }) =>
          numericColumns[columnIndex] ? (
            <div className="text-right">{row.original.cells[columnIndex] ?? null}</div>
          ) : (
            row.original.cells[columnIndex] ?? null
          ),
        enableColumnFilter: !numericColumns[columnIndex],
        meta: {
          label: labelText,
          placeholder: `Filter ${labelText.toLocaleLowerCase()}…`,
          variant: "text",
          ...(flexColumn === columnIndex ? { flex: true } : {}),
        },
      };
      }),
    [columnWidths, columns, flexColumn, numericColumns, sortable],
  );

  const selectedRows = React.useMemo(
    () =>
      activeRow == null
        ? {}
        : {
            [String(activeRow)]: true,
          },
    [activeRow],
  );

  return (
    <DataTableRoot
      data={tableRows}
      columns={tableColumns}
      getRowId={(row) => row.id}
      config={{
        autoResetPageIndex: true,
        enableRowSelection: Boolean(onRowSelect),
        initialPageSize: visibleRows,
        // No pagination bar: the page size is the batch of rows rendered so far.
        enablePagination: !skeleton,
        // Fixed column widths (and the stretch column) need the fixed layout that resizing turns on.
        ...(flexColumn !== undefined ? { enableColumnResizing: true } : {}),
      }}
      state={{
        pagination: { pageIndex: 0, pageSize: visibleRows },
        ...(onRowSelect ? { rowSelection: selectedRows } : {}),
      }}
    >
      <div
        ref={regionRef}
        {...(fill.active && fill.maxHeight !== undefined ? { "data-fill-scroller": "" } : {})}
        className={cn(
          "min-w-0 overflow-hidden bg-card",
          insideSection === "padded" && "-mx-4 border-t border-border last:-mb-4 not-last:border-b",
          insideSection === "flush" && "not-first:border-t not-last:border-b border-border",
          !insideSection && "rounded-xl border border-border",
        )}
        role="region"
        aria-label={label}
        {...(skeleton ? { "aria-busy": true, "data-skeleton-table": "" } : {})}
      >
        {skeleton && showTools ? <SkeletonToolbar /> : null}
        {!skeleton && showTools ? (
          <DataTableToolbarSection className="flex-wrap justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <DataTableSearchFilter
                className="min-w-[min(100%,14rem)] flex-1 sm:max-w-xs"
                placeholder={`Search ${label.toLocaleLowerCase()}…`}
                debounceMs={150}
              />
              <DataTableFilterMenu
                autoOptions
                dynamicCounts
                showCounts
                mergeStrategy="augment"
              />
            </div>
            <div className="flex items-center gap-2">
              <DataTableSortMenu />
              <DataTableViewMenu />
            </div>
          </DataTableToolbarSection>
        ) : null}

        <NikoDataTable
          maxHeight={fill.active && fill.maxHeight !== undefined ? `${fill.maxHeight}px` : "36rem"}
          className="rounded-none border-0"
        >
          <DataTableHeader />
          <DataTableBody<SettingsTableRow>
            {...(hasMoreRows ? { onScrolledBottom: showMoreRows, scrollThreshold: 480 } : {})}
            {...(onRowSelect
              ? { onRowClick: (row: SettingsTableRow) => onRowSelect(row.sourceIndex) }
              : {})}
          >
            <DataTableSkeleton rows={initialPageSize} />
            <DataTableEmptyBody className="h-28">
              <DataTableEmptyMessage>
                <DataTableEmptyTitle>
                  No {label.toLocaleLowerCase()}
                </DataTableEmptyTitle>
                <DataTableEmptyDescription>
                  Nothing to show here yet.
                </DataTableEmptyDescription>
              </DataTableEmptyMessage>
              <DataTableEmptyFilteredMessage>
                <DataTableEmptyTitle>No matching records</DataTableEmptyTitle>
                <DataTableEmptyDescription>
                  Adjust or clear the active filters.
                </DataTableEmptyDescription>
              </DataTableEmptyFilteredMessage>
            </DataTableEmptyBody>
          </DataTableBody>
        </NikoDataTable>

        {skeleton ? null : <RowCountFooter visible={visibleRows} />}
        {onRowSelect && rowLabel ? (
          <p className="sr-only" aria-live="polite">
            {activeRow == null ? "" : rowLabel(activeRow)}
          </p>
        ) : null}
      </div>
    </DataTableRoot>
  );
}

const skeletonBar = "block shrink-0 rounded-md bg-[var(--berry-selected)] animate-pulse motion-reduce:animate-none";

/** Same box as the toolbar above: a search field and the filter, sort and view buttons. */
function SkeletonToolbar() {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2" aria-hidden>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className={cn(skeletonBar, "h-[34px] min-w-[min(100%,14rem)] flex-1 sm:max-w-xs")} />
        <span className={cn(skeletonBar, "h-8 w-20")} />
      </div>
      <div className="flex items-center gap-2">
        <span className={cn(skeletonBar, "h-8 w-[72px]")} />
        <span className={cn(skeletonBar, "h-8 w-[84px]")} />
      </div>
    </div>
  );
}

/** "Showing 50 of 1,850" while rows are still to come; counts what the current search and filters match. */
function RowCountFooter({ visible }: { visible: number }) {
  const { table } = useDataTable<SettingsTableRow>();
  const total = table.getFilteredRowModel().rows.length;
  if (visible >= total) return null;
  return (
    <p className="border-t border-border px-3 py-1.5 text-center text-xs text-muted-foreground tabular-nums" aria-live="polite">
      Showing {visible.toLocaleString()} of {total.toLocaleString()} · scroll for more
    </p>
  );
}
