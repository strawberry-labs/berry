import type { ScrollRowIntoView } from "../core/data-table-context"
import { useDataTable } from "../core/data-table-context"

/**
 * Scroll a row into view by its index in the current row model. Works on
 * virtualized bodies (the virtualizer registers itself) and plain bodies (DOM
 * `scrollIntoView` fallback), so consumers never branch on body type.
 *
 * Throws outside a `DataTableRoot` (inherited from `useDataTable`).
 */
export function useDataTableScroll(): {
  scrollRowIntoView: ScrollRowIntoView
} {
  const { scrollRowIntoView } = useDataTable()
  return { scrollRowIntoView }
}
