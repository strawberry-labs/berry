import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  CodePreviewPreferencesContext,
  Markdown,
  type CodePreviewPreferences,
} from "@berry/desktop-ui/components/berry-markdown";
import { host } from "@/lib/berry";

export { Markdown };

function useSetting<T extends string | number | boolean>(key: string): T | undefined {
  const query = useQuery({
    queryKey: ["settings.get", key],
    queryFn: () => host.call<T | null>("settings.get", { key }),
  });
  return query.data ?? undefined;
}

/**
 * Bridges the host settings store into the shared Markdown renderer's code
 * preview preferences (theme, line numbers, wrap, font size). Mounted once at
 * the app root so every Markdown instance resolves the same values it did
 * when the lookup lived inside the component.
 */
export function CodePreviewSettingsBridge({ children }: { children: React.ReactNode }) {
  const lightTheme = useSetting<string>("codePreview.lightTheme");
  const darkTheme = useSetting<string>("codePreview.darkTheme");
  const lineNumbers = useSetting<boolean>("codePreview.lineNumbers");
  const wordWrap = useSetting<boolean>("codePreview.wordWrap");
  const fontSize = useSetting<number>("codePreview.fontSize");
  const value = React.useMemo<CodePreviewPreferences>(
    () => ({
      ...(lightTheme !== undefined ? { lightTheme } : {}),
      ...(darkTheme !== undefined ? { darkTheme } : {}),
      ...(lineNumbers !== undefined ? { lineNumbers } : {}),
      ...(wordWrap !== undefined ? { wordWrap } : {}),
      ...(fontSize !== undefined ? { fontSize } : {}),
    }),
    [lightTheme, darkTheme, lineNumbers, wordWrap, fontSize],
  );
  return (
    <CodePreviewPreferencesContext.Provider value={value}>{children}</CodePreviewPreferencesContext.Provider>
  );
}
