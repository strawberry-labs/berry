import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribeToMobileQuery(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined
  }

  const query = window.matchMedia(MOBILE_QUERY)
  query.addEventListener("change", onStoreChange)
  return () => query.removeEventListener("change", onStoreChange)
}

function getMobileSnapshot() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(MOBILE_QUERY).matches
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribeToMobileQuery,
    getMobileSnapshot,
    () => false,
  )
}
