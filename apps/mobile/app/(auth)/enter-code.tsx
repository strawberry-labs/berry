import * as React from "react";
import { StyleSheet, View, type TextInput } from "react-native";
import { router } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { formatMobileManualCode } from "@berry/shared";
import { ALLOW_INSECURE_LOCAL_SERVERS } from "../../src/config";
import { readManualCode, readServerAddress } from "../../src/pairing/pairing";
import { setPendingPairing } from "../../src/pairing/pending";
import { Button } from "../../src/ui/button";
import { ArrowLeft } from "../../src/ui/icons";
import { Input } from "../../src/ui/primitives";
import { Screen } from "../../src/ui/screen";
import { Text } from "../../src/ui/text";

export default function EnterCode() {
  const [server, setServer] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const codeRef = React.useRef<TextInput>(null);

  const submit = () => {
    const address = readServerAddress(server, { allowInsecureLocal: ALLOW_INSECURE_LOCAL_SERVERS });
    if ("message" in address) return setError(address.message);
    const normalized = readManualCode(code);
    if (!normalized) return setError("Enter the 8-character code shown on your computer, like AB12-CD34.");
    setError(null);
    setPendingPairing({ kind: "code", origin: address.origin, code: normalized });
    router.replace("/(auth)/pairing");
  };

  return (
    <Screen>
      <View style={styles.topBar}>
        <Button variant="ghost" size="icon-lg" icon={ArrowLeft} accessibilityLabel="Back" onPress={() => router.back()} />
      </View>
      <KeyboardAwareScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <View style={styles.header}>
          <Text variant="pageTitle">Enter a sign-in code</Text>
          <Text variant="body" tone="secondary">On your computer, open Get the mobile app in Berry and choose Enter a code instead.</Text>
        </View>
        <View style={styles.field}>
          <Text variant="secondary" weight="medium">Server</Text>
          <Input
            value={server}
            onChangeText={setServer}
            placeholder="berry.example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            returnKeyType="next"
            onSubmitEditing={() => codeRef.current?.focus()}
            accessibilityLabel="Server address"
          />
        </View>
        <View style={styles.field}>
          <Text variant="secondary" weight="medium">Code</Text>
          <Input
            ref={codeRef}
            value={code}
            onChangeText={(value) => {
              const cleaned = value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
              setCode(cleaned.length > 4 ? formatMobileManualCode(cleaned) : cleaned);
            }}
            placeholder="AB12-CD34"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={9}
            returnKeyType="go"
            onSubmitEditing={submit}
            style={styles.code}
            accessibilityLabel="Sign-in code"
          />
        </View>
        {error ? <Text variant="secondary" tone="danger" accessibilityRole="alert">{error}</Text> : null}
        <Button size="lg" label="Continue" onPress={submit} disabled={!server.trim() || code.replace("-", "").length < 8} />
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: { paddingHorizontal: 8, height: 52, justifyContent: "center" },
  content: { paddingHorizontal: 24, gap: 20, paddingBottom: 32 },
  header: { gap: 8 },
  field: { gap: 6 },
  code: { fontFamily: "JetBrainsMono_400Regular", letterSpacing: 3, fontSize: 20 },
});
