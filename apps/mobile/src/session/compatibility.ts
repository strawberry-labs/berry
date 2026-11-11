import { MOBILE_PROTOCOL_VERSION, compareMobileVersions, type MobileServerInfo } from "@berry/shared";

export type Compatibility =
  | { ok: true }
  | { ok: false; reason: "app-too-old" | "server-too-old" | "protocol" | "disabled"; message: string };

/** Decides whether this build can talk to a server before the user signs in. */
export function checkCompatibility(info: MobileServerInfo, appVersion: string, minimumServerVersion: string): Compatibility {
  if (!info.mobileEnabled) {
    return { ok: false, reason: "disabled", message: `${info.brand.applicationName} has turned off the mobile app. Ask your administrator if you need it.` };
  }
  if (info.protocolVersion > MOBILE_PROTOCOL_VERSION || compareMobileVersions(appVersion, info.minimumAppVersion) < 0) {
    return { ok: false, reason: "app-too-old", message: "This server needs a newer version of the Berry app. Update the app and try again." };
  }
  if (info.protocolVersion < MOBILE_PROTOCOL_VERSION || compareMobileVersions(info.serverVersion, minimumServerVersion) < 0) {
    return { ok: false, reason: "server-too-old", message: `${info.brand.applicationName} is running an older version of Berry. Ask your administrator to update it.` };
  }
  return { ok: true };
}

/** Features an older server doesn't advertise are hidden instead of failing. */
export function hasCapability(info: Pick<MobileServerInfo, "capabilities"> | null, capability: string): boolean {
  return Boolean(info?.capabilities.includes(capability));
}
