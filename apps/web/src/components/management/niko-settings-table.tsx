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
import { DataTablePagination } from "@berry/desktop-ui/components/niko-table/components/data-table-pagination";
import { DataTableSearchFilter } from "@berry/desktop-ui/components/niko-table/components/data-table-search-filter";
import { DataTableSortMenu } from "@berry/desktop-ui/components/niko-table/components/data-table-sort-menu";
import { DataTableToolbarSection } from "@berry/desktop-ui/components/niko-table/components/data-table-toolbar-section";
import { DataTableViewMenu } from "@berry/desktop-ui/components/niko-table/components/data-table-view-menu";
import { DataTable as NikoDataTable } from "@berry/desktop-ui/components/niko-table/core/data-table";
import { DataTableRoot } from "@berry/desktop-ui/components/niko-table/core/data-table-root";
import {
  DataTableBody,
  DataTableEmptyBody,
  DataTableHeader,
  DataTableSkeleton,
} from "@berry/desktop-ui/components/niko-table/core/data-table-structure";
import type { DataTableColumnDef } from "@berry/desktop-ui/components/niko-table/types";

type SettingsTableRow = {
  id: string;
  sourceIndex: number;
  cells: ReactNode[];
  values: string[];
};

function cellText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (
    typeof node === "string" ||
    typeof node === "number" ||
    typeof node === "bigint"
  ) {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(cellText).join(" ");
  if (React.isValidElement<{ children?: ReactNode }>(node)) {
    return cellText(node.props.children);
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
}: {
  label: string;
  columns: string[];
  rows: Array<Array<ReactNode>>;
  onRowSelect?: (index: number) => void;
  activeRow?: number | null;
  rowLabel?: (index: number) => string;
  initialPageSize?: number;
  searchable?: boolean;
}) {
  const tableRows = React.useMemo<SettingsTableRow[]>(
    () =>
      rows.map((cells, sourceIndex) => ({
        id: String(sourceIndex),
        sourceIndex,
        cells,
        values: cells.map(cellText),
      })),
    [rows],
  );

  const tableColumns = React.useMemo<DataTableColumnDef<SettingsTableRow>[]>(
    () =>
      columns.map((labelText, columnIndex) => ({
        id: `column-${columnIndex}`,
        accessorFn: (row) => row.values[columnIndex] ?? "",
        header: () => (
          <DataTableColumnHeader>
            <DataTableColumnTitle />
            <DataTableColumnSortMenu />
          </DataTableColumnHeader>
        ),
        cell: ({ row }) => row.original.cells[columnIndex] ?? null,
        enableColumnFilter: true,
        meta: {
          label: labelText,
          placeholder: `Filter ${labelText.toLocaleLowerCase()}…`,
          variant: "text",
        },
      })),
    [columns],
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
        initialPageSize,
      }}
      {...(onRowSelect ? { state: { rowSelection: selectedRows } } : {})}
    >
      <div
        className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_1px_oklch(0_0_0/0.02)]"
        role="region"
        aria-label={label}
      >
        <DataTableToolbarSection className="flex-wrap justify-between border-b border-border bg-muted/20 p-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {searchable ? (
              <DataTableSearchFilter
                className="min-w-[min(100%,16rem)] flex-1 sm:max-w-sm"
                placeholder={`Search ${label.toLocaleLowerCase()}…`}
                debounceMs={150}
              />
            ) : null}
            <DataTableFilterMenu
              autoOptions
              dynamicCounts
              showCounts
              mergeStrategy="augment"
            />
          </div>
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <DataTableSortMenu />
            <DataTableViewMenu />
          </div>
        </DataTableToolbarSection>

        <NikoDataTable
          maxHeight="32rem"
          className="rounded-none border-0"
        >
          <DataTableHeader />
          <DataTableBody<SettingsTableRow>
            {...(onRowSelect
              ? { onRowClick: (row: SettingsTableRow) => onRowSelect(row.sourceIndex) }
              : {})}
          >
            <DataTableSkeleton rows={initialPageSize} />
            <DataTableEmptyBody className="h-32">
              <DataTableEmptyMessage>
                <DataTableEmptyTitle>
                  No {label.toLocaleLowerCase()}
                </DataTableEmptyTitle>
                <DataTableEmptyDescription>
                  Add the first record to get started.
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

        <div className="border-t border-border bg-muted/20">
          <DataTablePagination
            defaultPageSize={initialPageSize}
            pageSizeOptions={[10, 25, 50, 100]}
          />
        </div>
      </div>
      {onRowSelect && rowLabel ? (
        <p className="sr-only" aria-live="polite">
          {activeRow == null ? "" : rowLabel(activeRow)}
        </p>
      ) : null}
    </DataTableRoot>
  );
}
