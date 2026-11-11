import * as React from "react";
import { Smartphone } from "lucide-react";
import { encode } from "uqr";
import { BerryApiError } from "@berry/api-client";
import type { MobilePairingCreateResponse, MobilePairingStatus } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { useIsMobile } from "@berry/desktop-ui/hooks/use-mobile";
import { Check, Copy, RefreshCw } from "@berry/desktop-ui/lib/icons";
import { actionErrorMessage } from "../../lib/action-error";
import { describePairedDevice, formatCountdown, secondsUntil, type MobilePairingApi } from "../../lib/mobile-pairing";
import { useDeploymentBrand } from "./deployment-brand";

const POLL_INTERVAL_MS = 1_500;

type Phase =
  | { kind: "loading" }
  | { kind: "showing"; pairing: MobilePairingCreateResponse; status: MobilePairingStatus | null }
  | { kind: "deciding"; pairing: MobilePairingCreateResponse; status: MobilePairingStatus }
  | { kind: "finishing"; pairing: MobilePairingCreateResponse; status: MobilePairingStatus }
  | { kind: "paired"; status: MobilePairingStatus }
  | { kind: "ended"; reason: "denied" | "expired" }
  | { kind: "error"; message: string; disabled: boolean };

export function MobileAppDialog({ open, onOpenChange, api, storeLinks, onManageDevices }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: MobilePairingApi;
  storeLinks: { appStoreUrl: string | null; playStoreUrl: string | null };
  onManageDevices: () => void;
}) {
  const brand = useDeploymentBrand();
  const phoneWidth = useIsMobile();
  const [phase, setPhase] = React.useState<Phase>({ kind: "loading" });
  const [showCode, setShowCode] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const pairingRef = React.useRef<MobilePairingCreateResponse | null>(null);
  const generationRef = React.useRef(0);
  const createQueueRef = React.useRef<Promise<unknown>>(Promise.resolve());

  const start = React.useCallback(async () => {
    const generation = ++generationRef.current;
    setPhase({ kind: "loading" });
    // The server keeps only the newest code per browser session, so codes are
    // created one at a time and any code nobody will see is cancelled.
    const request = createQueueRef.current.then(() => api.createPairing());
    createQueueRef.current = request.catch(() => undefined);
    try {
      const pairing = await request;
      if (generation !== generationRef.current) {
        void api.cancel(pairing.id).catch(() => undefined);
        return;
      }
      pairingRef.current = pairing;
      setPhase({ kind: "showing", pairing, status: null });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setPhase({ kind: "error", message: actionErrorMessage(error, "Could not create a sign-in code. Try again."), disabled: isMobileAppDisabled(error) });
    }
  }, [api]);

  // Create a code when the dialog opens; cancel any open request when it closes.
  React.useEffect(() => {
    if (!open) return;
    setShowCode(false);
    void start();
    return () => {
      generationRef.current += 1;
      const pairing = pairingRef.current;
      pairingRef.current = null;
      if (pairing) void api.cancel(pairing.id).catch(() => undefined);
    };
  }, [api, open, start]);

  const pairing = phase.kind === "showing" || phase.kind === "deciding" || phase.kind === "finishing" ? phase.pairing : null;

  // Poll the server for the phone's progress while a code is live.
  React.useEffect(() => {
    if (!open || !pairing || phase.kind === "deciding") return;
    const controller = new AbortController();
    const generation = generationRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const status = await api.getPairing(pairing.id, controller.signal);
        if (controller.signal.aborted || generation !== generationRef.current) return;
        if (status.status === "claimed") {
          setPhase({ kind: "deciding", pairing, status });
          return;
        }
        if (status.status === "completed") {
          pairingRef.current = null;
          setPhase({ kind: "paired", status });
          return;
        }
        if (status.status === "denied" || status.status === "cancelled") {
          pairingRef.current = null;
          setPhase({ kind: "ended", reason: "denied" });
          return;
        }
        if (status.status === "expired") {
          pairingRef.current = null;
          // An unscanned code quietly refreshes; an abandoned approval does not.
          if (phase.kind === "showing") void start();
          else setPhase({ kind: "ended", reason: "expired" });
          return;
        }
        if (phase.kind === "showing") setPhase({ kind: "showing", pairing, status });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof BerryApiError && error.status === 404) {
          pairingRef.current = null;
          setPhase({ kind: "ended", reason: "expired" });
          return;
        }
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, open, pairing, phase.kind, start]);

  const decide = async (decision: "approve" | "deny") => {
    if (phase.kind !== "deciding") return;
    setBusy(true);
    try {
      const status = decision === "approve" ? await api.approve(phase.pairing.id) : await api.deny(phase.pairing.id);
      if (decision === "deny" || status.status === "denied") {
        pairingRef.current = null;
        setPhase({ kind: "ended", reason: "denied" });
      } else {
        // Once approved, closing the dialog must not cancel the phone's sign-in.
        pairingRef.current = null;
        setPhase({ kind: "finishing", pairing: phase.pairing, status });
      }
    } catch (error) {
      pairingRef.current = null;
      if (error instanceof BerryApiError && (error.status === 404 || error.status === 410)) setPhase({ kind: "ended", reason: "expired" });
      else setPhase({ kind: "error", message: actionErrorMessage(error, "Could not record your decision. Try again."), disabled: isMobileAppDisabled(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="berry-mobile-app-dialog gap-5 p-5 sm:max-w-[440px]" aria-describedby="berry-mobile-app-description">
        <DialogHeader className="gap-1.5">
          <DialogTitle className="text-title font-semibold">Get the {brand.applicationName} app</DialogTitle>
          <DialogDescription id="berry-mobile-app-description" className="text-xs">
            {phoneWidth
              ? "Install the app, then sign in by entering the code below in the app."
              : "Scan this code with the Berry app to sign in on your phone. You'll approve the sign-in here."}
            {api.demo ? " Demo mode simulates a phone scanning the code." : ""}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "loading" ? <PairingPlaceholder label="Creating a sign-in code…" /> : null}

        {phase.kind === "showing" ? (
          <ShowingCode
            pairing={phase.pairing}
            phoneWidth={phoneWidth}
            showCode={showCode || phoneWidth}
            onToggleCode={() => setShowCode((value) => !value)}
            onRefresh={() => void start()}
            storeLinks={storeLinks}
          />
        ) : null}

        {phase.kind === "deciding" ? (
          <div className="grid gap-4" role="alert" aria-live="assertive">
            <div className="flex items-start gap-3 rounded-xl border border-[var(--berry-border)] bg-[var(--berry-control-bg)] p-3.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--berry-accent-soft)] text-[var(--berry-text-primary)]"><Smartphone className="size-4" aria-hidden /></span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--berry-text-primary)]">Sign in on {phase.status.device?.model ?? "a new phone"}?</p>
                <p className="mt-0.5 text-xs text-[var(--berry-text-secondary)]">
                  {phase.status.device ? describePairedDevice(phase.status.device) : "Unknown device"}
                  {phase.status.claimedIp ? ` · from ${phase.status.claimedIp}` : ""}
                </p>
              </div>
            </div>
            <p className="text-xs text-[var(--berry-text-secondary)]">Only approve if you just scanned this code yourself. The phone will have the same access as your account.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void decide("deny")}>Deny</Button>
              <Button disabled={busy} onClick={() => void decide("approve")}>Approve</Button>
            </div>
          </div>
        ) : null}

        {phase.kind === "finishing" ? <PairingPlaceholder label={`Finishing sign-in on ${phase.status.device?.model ?? "your phone"}…`} /> : null}

        {phase.kind === "paired" ? (
          <div className="grid gap-4" role="status">
            <div className="flex items-center gap-3 rounded-xl border border-[var(--berry-border)] bg-[var(--berry-control-bg)] p-3.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--berry-accent-soft)] text-[var(--berry-text-primary)]"><Check className="size-4" aria-hidden /></span>
              <p className="text-sm font-medium text-[var(--berry-text-primary)]">{brand.applicationName} is signed in on {phase.status.device?.model ?? "your phone"}.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { onOpenChange(false); onManageDevices(); }}>Manage devices</Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </div>
          </div>
        ) : null}

        {phase.kind === "ended" ? (
          <div className="grid gap-4" role="status">
            <p className="text-sm text-[var(--berry-text-secondary)]">
              {phase.reason === "denied" ? "That sign-in request was denied." : "That sign-in code expired."}
            </p>
            <div className="flex justify-end"><Button onClick={() => void start()}><RefreshCw />Show a new code</Button></div>
          </div>
        ) : null}

        {phase.kind === "error" ? (
          <div className="grid gap-4" role="alert">
            <p className="text-sm text-[var(--berry-text-secondary)]">{phase.disabled ? "Your organization has turned off the mobile app. Ask an administrator if you need it." : phase.message}</p>
            {!phase.disabled ? <div className="flex justify-end"><Button variant="outline" onClick={() => void start()}><RefreshCw />Try again</Button></div> : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ShowingCode({ pairing, phoneWidth, showCode, onToggleCode, onRefresh, storeLinks }: {
  pairing: MobilePairingCreateResponse;
  phoneWidth: boolean;
  showCode: boolean;
  onToggleCode: () => void;
  onRefresh: () => void;
  storeLinks: { appStoreUrl: string | null; playStoreUrl: string | null };
}) {
  const seconds = useCountdown(pairing.expiresAt);
  const hasStoreLinks = Boolean(storeLinks.appStoreUrl || storeLinks.playStoreUrl);
  return (
    <div className="grid gap-4">
      <div className={phoneWidth ? "grid gap-4" : "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-5"}>
        {!phoneWidth ? <PairingQrCode value={pairing.qrPayload} /> : null}
        <ol className="grid gap-2.5 text-sm text-[var(--berry-text-primary)]">
          <li className="flex gap-2.5"><StepNumber value={1} /><span>Install the Berry app{hasStoreLinks ? " from " : "."}{storeLinks.appStoreUrl ? <a className="underline underline-offset-2" href={storeLinks.appStoreUrl} target="_blank" rel="noreferrer">App Store</a> : null}{storeLinks.appStoreUrl && storeLinks.playStoreUrl ? " or " : null}{storeLinks.playStoreUrl ? <a className="underline underline-offset-2" href={storeLinks.playStoreUrl} target="_blank" rel="noreferrer">Google Play</a> : null}{hasStoreLinks ? "." : null}</span></li>
          <li className="flex gap-2.5"><StepNumber value={2} /><span>{phoneWidth ? "Open it and choose Enter a code." : "Open it and tap Scan QR code."}</span></li>
          <li className="flex gap-2.5"><StepNumber value={3} /><span>Approve the sign-in here.</span></li>
        </ol>
      </div>

      {showCode ? (
        <div className="grid gap-2 rounded-xl border border-[var(--berry-border)] bg-[var(--berry-control-bg)] p-3">
          <CopyRow label="Server" value={pairing.apiUrl ?? pairing.serverUrl} />
          <CopyRow label="Code" value={pairing.manualCode} mono />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--berry-text-secondary)]">
        <span aria-live="off" className="tabular-nums">{seconds > 0 ? `Code refreshes in ${formatCountdown(seconds)}` : "Refreshing code…"}</span>
        <div className="flex items-center gap-1">
          {!phoneWidth ? <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onToggleCode} aria-expanded={showCode}>{showCode ? "Hide code" : "Enter a code instead"}</Button> : null}
          <Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="Show a new code" title="Show a new code"><RefreshCw /></Button>
        </div>
      </div>
      <p className="text-xs leading-4 text-[var(--berry-text-tertiary)]">Don't share this code. Anyone who scans it can ask to sign in as you, and you'll still need to approve it here.</p>
    </div>
  );
}

/** Dark modules on a light quiet zone in both themes; scanners need the contrast. */
export function PairingQrCode({ value }: { value: string }) {
  const { size, data } = React.useMemo(() => encode(value, { ecc: "M", border: 0 }), [value]);
  const path = React.useMemo(() => {
    let d = "";
    data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
    return d;
  }, [data]);
  return (
    <div className="berry-mobile-qr rounded-xl bg-[var(--berry-preview-paper)] p-3 text-[var(--berry-preview-ink)] shadow-[0_0_0_1px_var(--berry-border)]">
      <svg role="img" aria-label="Sign-in QR code" viewBox={`0 0 ${size} ${size}`} width={168} height={168} shapeRendering="crispEdges">
        <path d={path} fill="currentColor" />
      </svg>
    </div>
  );
}

function CopyRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="w-12 shrink-0 text-xs text-[var(--berry-text-tertiary)]">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-sm text-[var(--berry-text-primary)] ${mono ? "font-mono tracking-[0.12em]" : ""}`}>{value}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => undefined)}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function StepNumber({ value }: { value: number }) {
  return <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--berry-accent-soft)] text-xs font-semibold tabular-nums text-[var(--berry-text-primary)]" aria-hidden>{value}</span>;
}

function PairingPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex min-h-[168px] items-center justify-center rounded-xl border border-dashed border-[var(--berry-border)] text-xs text-[var(--berry-text-secondary)]" role="status">
      {label}
    </div>
  );
}

function useCountdown(expiresAt: string): number {
  const [seconds, setSeconds] = React.useState(() => secondsUntil(expiresAt));
  React.useEffect(() => {
    setSeconds(secondsUntil(expiresAt));
    const timer = setInterval(() => setSeconds(secondsUntil(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return seconds;
}

function isMobileAppDisabled(error: unknown): boolean {
  return error instanceof BerryApiError
    && error.status === 403
    && typeof error.body === "object"
    && error.body !== null
    && (error.body as { code?: unknown }).code === "mobile_app_disabled";
}
