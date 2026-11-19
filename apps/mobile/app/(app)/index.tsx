import * as React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { greetingForDate } from "@berry/client-core/thread-history";
import { Composer } from "../../src/features/composer/composer";
import { ProjectSwitcher } from "../../src/features/composer/project-switcher";
import { useActiveWorkspace, useTasks, useWorkspaces } from "../../src/features/data/shell-data";
import { TopBar } from "../../src/features/shell/top-bar";
import { useSlashCommands, useStartNewTask } from "../../src/features/tasks/task-submit";
import { useSignedInSession } from "../../src/session/session";
import { BrandLogo } from "../../src/ui/brand";
import { Button } from "../../src/ui/button";
import { Search } from "../../src/ui/icons";
import { Screen } from "../../src/ui/screen";
import { Text } from "../../src/ui/text";

/** The web home: greeting with the deployment mark over the composer and its project strip. */
export default function Home() {
  const { profile, serverInfo } = useSignedInSession();
  const brand = serverInfo?.brand ?? profile.brand;
  const workspaces = useWorkspaces();
  const tasks = useTasks();
  const [active, setActive] = useActiveWorkspace(workspaces.data);
  const startNewTask = useStartNewTask();
  const [greeting, setGreeting] = React.useState(() => greetingForDate(new Date()));
  React.useEffect(() => {
    const timer = setInterval(() => setGreeting(greetingForDate(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  const taskTitles = React.useMemo(
    () => (tasks.data ?? []).filter((task) => !task.deletedAt && !task.archived).slice(0, 50).map((task) => task.title),
    [tasks.data],
  );
  const onImage = React.useCallback(async (prompt: string) => {
    if (!active) throw new Error("Choose a project first.");
    await startNewTask({ input: `Create image\n${prompt}`, intent: "image_generation", attachments: [], delivery: "send" }, active);
  }, [active, startNewTask]);
  const onCommand = useSlashCommands(onImage);

  return (
    <Screen edges={["top"]}>
      <TopBar trailing={<Button variant="ghost" size="icon-lg" icon={Search} accessibilityLabel="Search" onPress={() => router.navigate("/(app)/search")} />} />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.greeting} accessibilityRole="header">
            <BrandLogo uri={brand.logoUrl} size={30} />
            <Text style={styles.greetingText}>{greeting}</Text>
          </View>
          <Composer
            variant="home"
            draftKey="home"
            working={false}
            taskTitles={taskTitles}
            header={workspaces.data ? <ProjectSwitcher workspaces={workspaces.data} active={active} onSelect={setActive} /> : null}
            onSubmit={async (submission) => {
              if (!active) throw new Error("Choose a project first.");
              await startNewTask(submission, active);
            }}
            onCommand={onCommand}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 16, paddingBottom: 24, gap: 28 },
  greeting: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  greetingText: { fontSize: 28, lineHeight: 34, fontWeight: "600", letterSpacing: -0.4 },
});
