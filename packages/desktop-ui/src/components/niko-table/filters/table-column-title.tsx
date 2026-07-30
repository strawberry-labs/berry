import React from "react"
import type { Column } from "@tanstack/react-table"
import { cn } from "@berry/desktop-ui/lib/utils"
import { useDerivedColumnTitle } from "../hooks/use-derived-column-title"

/**
 * Renders the column title.
 */
export function TableColumnTitle<TData, TValue>({
  column,
  title,
  className,
  children,
}: {
  column: Column<TData, TValue>
  title?: string
  className?: string
  children?: React.ReactNode
}) {
  const derivedTitle = useDerivedColumnTitle(column, column.id, title)

  return (
    <div
      data-slot="column-title"
      className={cn(
        // `min-w-0` so `truncate` can shrink this flex item below its text
        // width (a nowrap flex child otherwise keeps full content width and
        // spills into the neighbouring header cell on narrow columns).
        "min-w-0 truncate py-0.5 text-sm font-semibold transition-colors",
        className,
      )}
    >
      {children ?? derivedTitle}
    </div>
  )
}

TableColumnTitle.displayName = "TableColumnTitle"
