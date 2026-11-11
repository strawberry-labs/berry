import * as React from "react";

/**
 * How the nearest `Section` card lays out its body, so nested blocks such as
 * tables can sit flush instead of drawing a second frame inside the card.
 */
export type SectionLayout = false | "padded" | "flush";

export const SectionContext = React.createContext<SectionLayout>(false);

export function useInsideSection(): SectionLayout {
  return React.useContext(SectionContext);
}
