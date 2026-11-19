import * as React from "react";
import { Smartphone } from "lucide-react";
import type { MobileDeviceRegistration } from "@berry/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@berry/desktop-ui/components/ui/alert-dialog";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { actionErrorMessage } from "../../lib/action-error";
import { describePairedDevice } from "../../lib/mobile-pairing";
import { AsyncState, InlineNotice, Section, StatusPill, formatDate, formatDateTime } from "./management-primitives";
import { useResource } from "./management-context";
import { MobileDevicesSkeleton } from "./management-screen-skeletons";
import { SkeletonRegion } from "./management-skeletons";

/** Paired phones with a revoke action; used for your own devices and by admins. */
export function MobileDevicesSection({ resourceKey, title = "Mobile devices", description, emptyText, load, revoke, actions, readOnly = false }: {
  resourceKey: string;
  title?: string;
  description: string;
  emptyText: string;
  load: () => Promise<MobileDeviceRegistration[]>;
  revoke: (deviceId: string) => Promise<void>;
  actions?: React.ReactNode;
  readOnly?: boolean;
}) {
  const devices = useResource(resourceKey, load, [] as MobileDeviceRegistration[]);
  const [pending, setPending] = React.useState<MobileDeviceRegistration | null>(null);
  const [revoking, setRevoking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const confirmRevoke = async () => {
    if (!pending) return;
    setRevoking(true);
    setError(null);
    try {
      await revoke(pending.deviceId);
      devices.setData((current) => current.filter((device) => device.deviceId !== pending.deviceId));
      setPending(null);
    } catch (cause) {
      setError(actionErrorMessage(cause, "Could not sign out this device. Try again."));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Section title={title} description={description} actions={actions} flush>
      {devices.loading ? <SkeletonRegion label="Loading devices"><MobileDevicesSkeleton /></SkeletonRegion> : devices.error ? (
        <div className="p-4"><AsyncState loading={false} error={devices.error} onRetry={devices.retry}>{null}</AsyncState></div>
      ) : devices.data.length === 0 ? (
        <div className="flex items-start gap-3 px-4 py-3.5">
          <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="grid gap-0.5">
            <strong className="text-md font-medium text-foreground">No phones signed in</strong>
            <span className="text-xs leading-5 text-muted-foreground">{emptyText}</span>
          </div>
        </div>
      ) : (
        <ul className="grid divide-y divide-border" aria-label={title}>
          {devices.data.map((device) => (
            <li key={device.deviceId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <Smartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <strong className="truncate text-md font-medium text-foreground">{device.displayName || device.model || "Phone"}</strong>
                  {device.current ? <StatusPill tone="info">This phone</StatusPill> : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {describePairedDevice(device)} · {device.pairedAt ? `Signed in ${formatDate(device.pairedAt)} · ` : ""}Last active {formatDateTime(device.lastSeenAt)}
                </p>
              </div>
              {!readOnly ? (
                <Button variant="secondary" onClick={() => { setError(null); setPending(device); }} aria-label={`Sign out ${device.displayName || device.model || "phone"}`}>
                  Sign out
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open && !revoking) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out {pending?.displayName || pending?.model || "this phone"}?</AlertDialogTitle>
            <AlertDialogDescription>
              The phone is signed out the next time it contacts Berry. Signing in again needs a new code from the web.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoking}
              onClick={(event) => {
                event.preventDefault();
                void confirmRevoke();
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
