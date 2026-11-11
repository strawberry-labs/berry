import * as React from "react";
import { Alert, Share, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { planProgressFromConversation } from "@berry/client-core/plan-progress";
import { useSessionStream } from "@berry/client-core/session-stream-store";
import { durableTurnPhase } from "@berry/client-core/thread-history";
import { isContinuableAssistantTurn } from "@berry/client-core/thread-turns";
import { Composer } from "../../../src/features/composer/composer";
import { useModelSelection } from "../../../src/features/data/models";
import { useTaskActions, useTasks, useWorkspaces } from "../../../src/features/data/shell-data";
import { TopBar } from "../../../src/features/shell/top-bar";
import { taskMenuItems } from "../../../src/features/sidebar/sidebar-rows";
import { rememberSessionModel, useSlashCommands, useTaskSubmit } from "../../../src/features/tasks/task-submit";
import { useSessionController } from "../../../src/features/thread/controllers";
import { PlanProgressPill, QueuedMessages, QuestionCard } from "../../../src/features/thread/thread-parts";
import { ThreadView } from "../../../src/features/thread/thread-view";
import { useSignedInSession } from "../../../src/session/session";
import { Button } from "../../../src/ui/button";
import { Ellipsis } from "../../../src/ui/icons";
import { Menu } from "../../../src/ui/menu";
import { EmptyState, Skeleton } from "../../../src/ui/primitives";
import { PromptSheet } from "../../../src/ui/prompt-sheet";
import { Screen } from "../../../src/ui/screen";

/** The web task route: header, transcript, and the thread composer docked above the keyboard. */
export default function TaskScreen() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const { client, profile } = useSignedInSession();
  const insets = useSafeAreaInsets();
  const tasks = useTasks();
  const workspaces = useWorkspaces();
  const taskActions = useTaskActions();
  const models = useModelSelection();
  const listed = tasks.data?.find((task) => task.id === taskId) ?? null;
  // A task opened from a link may not be in the cached list yet.
  const fetched = useQuery({
    queryKey: ["shell", profile.serverUrl, "task", taskId],
    queryFn: () => client.getTask(taskId),
    enabled: Boolean(taskId) && !listed && !tasks.isLoading,
  });
  const task = listed ?? fetched.data ?? null;
  const workspace = workspaces.data?.find((candidate) => candidate.id === task?.workspaceId) ?? null;
  const sessionId = task?.activeSessionId ?? null;
  const { controller, state } = useSessionController(sessionId);
  const stream = useSessionStream(sessionId);
  const { submit, continueTurn, decideApproval, answerQuestion, sendQueuedNow } = useTaskSubmit(task, workspace, controller);
  const [renaming, setRenaming] = React.useState(false);

  const messages = state?.messages ?? [];
  const working = stream.turnActive || Boolean(state?.turn?.active);
  const activeLabel = durableTurnPhase(state?.turn ?? undefined);
  const plan = React.useMemo(() => planProgressFromConversation(messages, stream), [messages, stream]);
  const latestAssistants = React.useMemo(() => {
    const lastUser = messages.map((message) => message.role).lastIndexOf("user");
    return messages.slice(lastUser + 1).filter((message) => message.role === "assistant");
  }, [messages]);
  const canContinue = !working && isContinuableAssistantTurn(latestAssistants);
  const taskTitles = React.useMemo(() => (tasks.data ?? []).filter((item) => !item.deletedAt && !item.archived && item.id !== taskId).slice(0, 50).map((item) => item.title), [taskId, tasks.data]);

  // Opening a task marks its activity read, as on the web.
  React.useEffect(() => {
    if (task?.unreadAt && task.unreadAt !== task.lastReadAt) taskActions.mutate({ kind: "read", task });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.unreadAt]);

  const { progress } = useReanimatedKeyboardAnimation();
  const composerInset = useAnimatedStyle(() => ({ paddingBottom: interpolate(progress.value, [0, 1], [Math.max(insets.bottom, 8), 8]) }));

  const onImage = React.useCallback(async (prompt: string) => {
    await submit({ input: `Create image\n${prompt}`, intent: "image_generation", attachments: [], delivery: working ? "queue" : "send" });
  }, [submit, working]);
  const onCommand = useSlashCommands(onImage);

  const onMenu = (id: string) => {
    if (!task) return;
    if (id === "pin") taskActions.mutate({ kind: "pin", task });
    else if (id === "rename") setRenaming(true);
    else if (id === "share") void Share.share({ message: task.title, url: `${profile.serverUrl}/tasks/${task.id}` });
    else if (id === "archive") {
      taskActions.mutate({ kind: "archive", task });
      router.navigate("/(app)");
    } else if (id === "delete") {
      Alert.alert("Delete this task?", "You can restore it from Archived tasks in Settings.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => {
          taskActions.mutate({ kind: "delete", task });
          router.navigate("/(app)");
        } },
      ]);
    }
  };

  if (!task) {
    return (
      <Screen edges={["top"]}>
        <TopBar />
        {fetched.isError ? (
          <EmptyState title="This task isn't available" message="It may have been deleted, or you may no longer have access." action={<Button variant="outline" label="Go home" onPress={() => router.navigate("/(app)")} />} />
        ) : <ThreadSkeleton />}
      </Screen>
    );
  }

  return (
    <Screen edges={["top"]}>
      <TopBar
        title={task.title}
        subtitle={workspace?.workspaceKind === "project" ? workspace.name : undefined}
        onTitlePress={() => setRenaming(true)}
        trailing={(
          <Menu items={taskMenuItems(task, { canMutate: true })} onSelect={onMenu} title={task.title}>
            <Button variant="ghost" size="icon-lg" icon={Ellipsis} accessibilityLabel="Task actions" />
          </Menu>
        )}
      />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <View style={styles.flex}>
          {state && !(state.loading && messages.length === 0) && sessionId ? (
            <ThreadView
              sessionId={sessionId}
              messages={messages}
              stream={stream}
              hasOlder={state.hasOlder}
              loadingOlder={state.loadingOlder}
              activeLabel={activeLabel}
              latestTurnError={state.error ?? undefined}
              onLoadOlder={() => void controller?.loadOlder()}
              onApprovalDecide={async (decision) => {
                if (stream.approval) await decideApproval(stream.approval.approvalId, decision);
              }}
              contentInsetBottom={12}
            />
          ) : <ThreadSkeleton />}
        </View>
        <Animated.View style={[styles.composer, composerInset]}>
          <Composer
            variant="thread"
            draftKey={task.id}
            working={working}
            canContinue={canContinue}
            taskId={task.id}
            sessionId={sessionId ?? undefined}
            taskTitles={taskTitles}
            before={(
              <>
                {stream.question ? <QuestionCard question={stream.question} onSubmit={(answers) => answerQuestion(stream.question!.questionId, answers)} /> : null}
                {plan ? <PlanProgressPill plan={plan} /> : null}
                <QueuedMessages
                  items={state?.queued ?? []}
                  active={working}
                  onSendNow={(item) => void sendQueuedNow(item, working).catch((cause: unknown) => Alert.alert("Couldn't send", cause instanceof Error ? cause.message : "Try again."))}
                  onRemove={(item) => void controller?.cancelQueued(item.id)}
                />
              </>
            )}
            onSubmit={async (submission) => {
              if (models.explicit && models.providerId && models.modelId && sessionId) rememberSessionModel(sessionId, models.providerId, models.modelId);
              await submit(submission);
            }}
            onStop={() => void controller?.cancel()}
            onContinue={continueTurn}
            onCommand={onCommand}
          />
        </Animated.View>
      </KeyboardAvoidingView>
      <PromptSheet
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename task"
        initialValue={task.title}
        onSubmit={(title) => taskActions.mutate({ kind: "rename", task, title })}
      />
    </Screen>
  );
}

function ThreadSkeleton() {
  return (
    <View style={styles.skeleton} accessibilityLabel="Loading task">
      <Skeleton width="60%" height={36} radius={18} style={{ alignSelf: "flex-end" }} />
      <Skeleton width="40%" />
      <Skeleton width="92%" />
      <Skeleton width="84%" />
      <Skeleton width="70%" />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  composer: { paddingHorizontal: 12, paddingTop: 4 },
  skeleton: { padding: 16, gap: 12 },
});
