import * as React from "react";
import { USER_AGENT_SUFFIX } from "../../config";
import { useSignedInSession } from "../../session/session";

type Headers = Record<string, string>;

/**
 * The bearer headers the API client sends, for the native loaders that can't
 * go through it (expo-image thumbnails, expo-file-system downloads).
 */
export function useAuthHeaders(): Headers {
  const { authHeaders } = useSignedInSession();
  return React.useMemo(() => ({ ...authHeaders, "X-Berry-Client": USER_AGENT_SUFFIX }), [authHeaders]);
}
