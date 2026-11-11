const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

// Expo configures workspace watch folders and pnpm symlinks for monorepos.
const config = getDefaultConfig(__dirname);

// Workspace packages (client-core, api-client) carry their own dev copy of
// React for tests. React Native needs exactly one React, matching its
// renderer, so every `react` import resolves from this app.
const appOrigin = path.join(__dirname, "package.json");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react" || moduleName.startsWith("react/")) {
    return context.resolveRequest({ ...context, originModulePath: appOrigin }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
