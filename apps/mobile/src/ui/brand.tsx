import * as React from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { Text } from "./text";

const BERRY_LOGO = require("../../assets/berry-logo.png");

/** The deployment's logo with the Berry mark as fallback, like DeploymentBrandLogo on the web. */
export function BrandLogo({ uri, size = 20 }: { uri?: string | null; size?: number }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [uri]);
  return (
    <Image
      source={uri && !failed ? { uri } : BERRY_LOGO}
      style={{ width: size, height: size }}
      contentFit="contain"
      accessibilityIgnoresInvertColors
      onError={() => setFailed(true)}
    />
  );
}

export function BrandLockup({ name, logoUrl, size = 20 }: { name: string; logoUrl?: string | null; size?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1 }}>
      <BrandLogo uri={logoUrl ?? null} size={size} />
      <Text variant="brand" numberOfLines={1} style={{ flexShrink: 1 }}>{name}</Text>
    </View>
  );
}
