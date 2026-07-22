import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const extensionManifest = readJson("apps/extension/src/manifest.json");
const extensionListing = readJson("distribution/extension-store/listing.json");
const extensionNotes = readText("distribution/extension-store/review-notes.md");
const mobileApp = readJson("apps/mobile/app.json");
const eas = readJson("apps/mobile/eas.json");
const privacyManifest = readText("apps/mobile/PrivacyInfo.xcprivacy");
const appStorePrivacy = readText("distribution/mobile/app-store-privacy.md");
const playSafety = readJson("distribution/mobile/google-play-data-safety.json");
const mobileNotes = readText("distribution/mobile/review-notes.md");
const extensionWorkflow = readText(".github/workflows/extension-store-package.yml");
const mobileWorkflow = readText(".github/workflows/mobile-internal-tracks.yml");

assert(!("host_permissions" in extensionManifest), "extension manifest must not request broad host_permissions");
assert(Array.isArray(extensionManifest.optional_host_permissions), "extension manifest must use optional host permissions");
assert(extensionListing.permissionsJustification.nativeMessaging.includes("Berry Desktop"), "extension listing must justify native messaging");
assert(extensionListing.hostPermissionsJustification.includes("per site"), "extension listing must document per-site host permission");
assert(JSON.stringify(extensionListing.privacy).includes("configured by the user"), "extension privacy must name configured endpoints");
assert(extensionNotes.includes("No broad `host_permissions`"), "extension review notes must call out scoped host permissions");

assert(mobileApp.expo.ios.privacyManifests.NSPrivacyTracking === false, "mobile app config must disable tracking");
assert(mobileApp.expo.ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking === true, "mobile app must scope ATS local networking");
assert(eas.build["internal-ios"].distribution === "internal", "EAS must define iOS internal build");
assert(eas.build["internal-android"].android.buildType === "apk", "EAS must define Android internal APK build");
assert(eas.submit["internal-android"].android.track === "internal", "EAS must target Play internal track");
assert(privacyManifest.includes("<key>NSPrivacyTracking</key>") && privacyManifest.includes("<false/>"), "Apple privacy manifest must disable tracking");
assert(appStorePrivacy.includes("Nothing leaves the device except data sent to endpoints the user configures"), "App Store privacy notes must state endpoint-scoped data flow");
assert(playSafety.dataCollected === false && playSafety.dataShared === false, "Play data safety must declare no collection/sharing by Berry");
assert(mobileNotes.includes("No terminal is available on mobile"), "mobile review notes must cover read-only code mode");

assert(extensionWorkflow.includes("pnpm --filter @berry/extension build"), "extension workflow must build extension");
assert(extensionWorkflow.includes("mkdir -p artifacts"), "extension workflow must create artifact directory");
assert(extensionWorkflow.includes("berry-companion-extension.zip"), "extension workflow must upload extension zip");
assert(mobileWorkflow.includes("EXPO_TOKEN"), "mobile workflow must use human-owned Expo token");
assert(mobileWorkflow.includes("internal-ios") && mobileWorkflow.includes("internal-android"), "mobile workflow must target internal tracks");
assert(mobileWorkflow.includes("submit --platform ios") && mobileWorkflow.includes("submit --platform android"), "mobile workflow must submit both internal tracks");

console.log("[store] extension listing and review package OK");
console.log("[store] mobile privacy manifests and internal-track config OK");

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
