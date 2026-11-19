import * as React from "react";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersonalizationProfile, Task, Workspace } from "@berry/shared";
import { useSignedInSession } from "../../session/session";
import type { ComposerSubmission } from "../composer/composer";
import { useModelSelection } from "../data/models";
import { mergeTasks } from "../data/shell-data";
import { sessionControllers, useSessionControllerFactory } from "../thread/controllers";
import type { SessionController } from "../thread/session-controller";
import { questionAnswerTranscript, questionToolAnswer, stableQuestionAnswerMessageId, type ApprovalDecision, type QuestionAnswer } from "../thread/thread-parts";

/** Models the person explicitly picked inside a task, sent with that task's later turns (web parity). */
const explicitSessionModels = new Map<string, { providerId: string; model: string }>();

export function rememberSessionModel(sessionId: string, providerId: string, model: string): void {
  explicitSessionModels.set(sessionId, { providerId, model });
}

export function usePersonalizationContext(): string {
  const { client, profile } = useSignedInSession();
  const query = useQuery({
    queryKey: ["shell", profile.serverUrl, "personalization"],
    queryFn: () => client.personalizationProfile(),
    staleTime: 5 * 60_000,
  });
  return query.data ? personalizationRuntimeContext(query.data) : "";
}

/** The profile context the web appends to a new task's first prompt. */
export function personalizationRuntimeContext(profile: PersonalizationProfile): string {
  return [
    profile.nickname.trim() ? `Nickname: ${profile.nickname.trim()}` : "",
    profile.occupation.trim() ? `Occupation: ${profile.occupation.trim()}` : "",
    profile.about.trim() ? `About: ${profile.about.trim()}` : "",
    profile.customInstructions.trim() ? `Custom instructions: ${profile.customInstructions.trim()}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * The home composer's send: create the task (with the person's model if
 * they chose one), show the prompt immediately, open the task, then start
 * the turn on the controller the task screen will render.
 */
export function useStartNewTask() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const models = useModelSelection();
  const factory = useSessionControllerFactory();
  const profileContext = usePersonalizationContext();
  return React.useCallback(async (submission: ComposerSubmission, workspace: Workspace): Promise<Task> => {
    const created = await client.createTask({
      workspaceId: workspace.id,
      title: submission.input.slice(0, 42).trim() || "New cloud task",
      permissionMode: "full-access",
      ...(models.explicit && models.providerId && models.modelId ? { modelProviderId: models.providerId, model: models.modelId } : {}),
    });
    mergeTasks(queryClient, profile.serverUrl, [created.task]);
    const sessionId = created.task.activeSessionId ?? created.session.id;
    const { key, create } = factory(sessionId);
    const controller = sessionControllers.peekOrCreate(key, create);
    const requestMessageId = globalThis.crypto.randomUUID();
    const runtimeInput = profileContext ? `${submission.input}\n\nExplicit user profile context:\n${profileContext}` : submission.input;
    controller.addOptimisticUserMessage(requestMessageId, submission.input, submission.attachments);
    router.push({ pathname: "/(app)/tasks/[taskId]", params: { taskId: created.task.id } });
    void controller.runTurn({
      input: runtimeInput,
      ...(runtimeInput !== submission.input ? { messageInput: submission.input } : {}),
      ...(submission.intent ? { intent: submission.intent } : {}),
      ...(submission.attachments.length > 0 ? { attachments: submission.attachments } : {}),
      requestMessageId,
      taskId: created.task.id,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      reasoning: models.reasoning,
    }).catch(() => undefined);
    return created.task;
  }, [client, factory, models.explicit, models.modelId, models.providerId, models.reasoning, profile.serverUrl, profileContext, queryClient]);
}

/** Everything a task screen sends: prompts (send/queue/steer), answers, approvals and commands. */
export function useTaskSubmit(task: Task | null, workspace: Workspace | null, controller: SessionController | null) {
  const { client } = useSignedInSession();
  const models = useModelSelection();
  const sessionId = task?.activeSessionId ?? null;

  const base = React.useCallback(() => {
    if (!task || !controller || !sessionId) throw new Error("This task is no longer available.");
    const model = explicitSessionModels.get(sessionId);
    return {
      taskId: task.id,
      workspaceId: task.workspaceId,
      workspacePath: workspace?.path,
      reasoning: models.reasoning,
      ...(model ? { model: { providerId: model.providerId, model: model.model } } : {}),
    };
  }, [controller, models.reasoning, sessionId, task, workspace?.path]);

  const submit = React.useCallback(async (submission: ComposerSubmission) => {
    const shared = base();
    const requestMessageId = globalThis.crypto.randomUUID();
    const input = {
      ...shared,
      input: submission.input,
      requestMessageId,
      ...(submission.intent ? { intent: submission.intent } : {}),
      ...(submission.attachments.length > 0 ? { attachments: submission.attachments } : {}),
    };
    if (submission.delivery === "queue") {
      await controller!.queueFollowUp({
        taskId: shared.taskId,
        workspaceId: shared.workspaceId,
        text: submission.input,
        attachments: submission.attachments,
        ...(submission.intent ? { intent: submission.intent } : {}),
        id: `queued_follow_up_${requestMessageId}`,
      });
      return;
    }
    if (submission.delivery === "steer") {
      await controller!.steer(input);
      return;
    }
    controller!.addOptimisticUserMessage(requestMessageId, submission.input, submission.attachments);
    await controller!.runTurn(input);
  }, [base, controller]);

  const continueTurn = React.useCallback(async () => {
    await controller!.continueTurn(base());
  }, [base, controller]);

  const decideApproval = React.useCallback(async (approvalId: string, decision: ApprovalDecision) => {
    if (decision === "abort") {
      await controller?.cancel();
      return;
    }
    await client.decideApproval(approvalId, { decision });
  }, [client, controller]);

  const answerQuestion = React.useCallback(async (questionId: string, answers: QuestionAnswer[]) => {
    if (!controller) throw new Error("This question is no longer available. Refresh and try again.");
    const answerMessageId = await stableQuestionAnswerMessageId(questionId);
    const result = await client.answerQuestion(questionId, {
      answer: questionToolAnswer(answers),
      answerMessageId,
      selectedOptions: answers.flatMap((item) => item.selectedOptions),
      answers,
    });
    if (!result.ok) throw new Error("This question was already answered or is no longer active.");
    controller.addOptimisticUserMessage(answerMessageId, questionAnswerTranscript(answers));
    void controller.refreshMessages().catch(() => undefined);
  }, [client, controller]);

  const sendQueuedNow = React.useCallback(async (item: { id: string; input: string; intent?: ComposerSubmission["intent"]; attachments: ComposerSubmission["attachments"] }, working: boolean) => {
    await controller!.cancelQueued(item.id);
    await submit({ input: item.input, intent: item.intent, attachments: item.attachments, delivery: working ? "steer" : "send" });
  }, [controller, submit]);

  return { submit, continueTurn, decideApproval, answerQuestion, sendQueuedNow };
}

/** The web's slash commands, routed to their phone equivalents. */
export function useSlashCommands(onImage: (prompt: string) => Promise<void>) {
  return React.useCallback(async (name: string, args: string[]) => {
    if (name === "clear") return;
    if (name === "new") {
      router.navigate("/(app)");
      return;
    }
    if (name === "help") throw new Error("Commands: /new, /image <prompt>, /skill, /mcp, /clear.");
    if (name === "mcp") {
      router.navigate({ pathname: "/(app)/settings/[tab]", params: { tab: "mcp" } });
      return;
    }
    if (name === "skill") {
      router.navigate("/(app)/skills");
      return;
    }
    if (name === "image") {
      const prompt = args.join(" ").trim();
      if (!prompt) throw new Error("Usage: /image <prompt>");
      await onImage(prompt);
      return;
    }
    if (["compact", "fork", "rewind", "goal", "pr"].includes(name)) {
      throw new Error(`/${name}${args.length ? ` ${args.join(" ")}` : ""} is not available from this cloud deployment yet.`);
    }
    throw new Error(`Unknown command: /${name}`);
  }, [onImage]);
}
