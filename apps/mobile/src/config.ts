import * as Application from "expo-application";
import Constants from "expo-constants";
import { Platform } from "react-native";

/** The version users see; also sent during pairing and checked against the server minimum. */
export const APP_VERSION = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "0.0.0";

/** Oldest server release this build supports (see the support window in docs/release-versioning.md). */
export const MINIMUM_SERVER_VERSION = "0.1.0";

/** Store builds require https; development builds may talk to local servers over http. */
export const ALLOW_INSECURE_LOCAL_SERVERS = __DEV__;

export const PLATFORM: "ios" | "android" = Platform.OS === "android" ? "android" : "ios";

export const USER_AGENT_SUFFIX = `BerryMobile/${APP_VERSION} (${PLATFORM})`;
