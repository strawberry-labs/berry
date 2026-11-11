import * as Device from "expo-device";
import type { MobilePairingDevice } from "@berry/shared";
import { APP_VERSION, PLATFORM } from "../config";

/** What the web shows when asking "Sign in on iPhone 17 Pro?". */
export function currentDevice(): MobilePairingDevice {
  return {
    // iOS 16+ only exposes a generic device name; the model is more useful.
    model: (Device.modelName ?? (PLATFORM === "ios" ? "iPhone" : "Android phone")).slice(0, 120),
    platform: PLATFORM,
    osVersion: (Device.osVersion ?? "unknown").slice(0, 40),
    appVersion: APP_VERSION.slice(0, 40),
  };
}
