import * as React from "react";
import { Redirect, useLocalSearchParams } from "expo-router";
import { buildMobilePairingUri, parseMobilePairingUri } from "@berry/shared";
import { ALLOW_INSECURE_LOCAL_SERVERS } from "../src/config";
import { readScannedCode } from "../src/pairing/pairing";
import { setPendingPairing } from "../src/pairing/pending";
import { useSession } from "../src/session/session";

/**
 * `berry://pair?…` opened from the system camera. The same checks as the
 * in-app scanner apply; signed-in phones keep their current server.
 */
export default function PairLink() {
  const params = useLocalSearchParams<{ v?: string; s?: string; a?: string; i?: string; k?: string }>();
  const { state } = useSession();
  const target = React.useMemo(() => {
    if (state.status === "signed-in") return "/(app)" as const;
    const parsed = params.s && params.i && params.k
      ? parseMobilePairingUri(buildMobilePairingUri({ serverUrl: params.s, apiUrl: params.a ?? null, pairingId: params.i, secret: params.k }))
      : null;
    const scanned = parsed ? readScannedCode(buildMobilePairingUri(parsed), { allowInsecureLocal: ALLOW_INSECURE_LOCAL_SERVERS }) : null;
    if (scanned?.kind !== "pairing") return "/(auth)/welcome" as const;
    setPendingPairing({ kind: "qr", pairing: scanned.pairing });
    return "/(auth)/pairing" as const;
  }, [params.a, params.i, params.k, params.s, state.status]);
  return <Redirect href={target} />;
}
