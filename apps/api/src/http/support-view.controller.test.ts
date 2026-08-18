import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { describe, expect, it, vi } from "vitest";
import { AUDIT_SERVICE } from "../audit/audit.service.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY } from "../identity/identity.repository.ts";
import { AgentApiController } from "./agent-api.controller.ts";
import { CLOUD_TASK_STORE } from "./cloud-task-store.ts";
import { SupportViewController } from "./support-view.controller.ts";

const actorId = "00000000-0000-4000-8000-000000000001";
const subjectId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const fileId = "00000000-0000-4000-8000-000000000004";
const sessionId = "00000000-0000-4000-8000-000000000005";
const messageId = "00000000-0000-4000-8000-000000000006";
const now = "2026-08-17T00:00:00.000Z";

function requestFor(userId: string) {
  return { auth: { user: { id: userId } }, headers: {} } as any;
}

async function controllerFor(role: "owner" | "admin" | "member", agentApi?: unknown) {
  const generatedImageMessage = {
    id: messageId,
    sessionId,
    role: "assistant",
    status: "complete",
    parts: [{
      id: "part_1",
      messageId,
      kind: "image",
      content: {
        src: `/v1/files/${fileId}/content`,
        downloadUrl: `/v1/files/${fileId}/content`,
        fileId,
        title: "Generated image",
        aspectRatio: "1:1",
        mimeType: "image/png",
        transparentBackground: false,
      },
      position: 0,
      createdAt: now,
    }],
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt: now,
    updatedAt: now,
  };
  const store = {
    listTaskPage: vi.fn(async () => ({ items: [], nextCursor: null })),
    getSession: vi.fn(async () => ({ id: sessionId, taskId })),
    getTask: vi.fn(async () => ({ id: taskId, ownerUserId: subjectId })),
    listMessages: vi.fn(async () => [generatedImageMessage]),
    listMessagePage: vi.fn(async () => ({
      messages: [generatedImageMessage],
      hasOlder: false,
      hasNewer: false,
      oldestSequence: "1",
      newestSequence: "1",
      cursorPresent: null,
      historyRevision: "1",
      historyDeletionRevision: "0",
    })),
    getMessage: vi.fn(async () => generatedImageMessage),
  };
  const identity = {
    getMembership: vi.fn(async (_tenantId: string, userId: string) => ({
      userId,
      status: "active",
      role: userId === actorId ? role : "member",
    })),
  };
  const files = {
    describe: vi.fn(async () => ({ id: fileId })),
    streamContent: vi.fn(async () => undefined),
  };
  const audit = { append: vi.fn(async () => ({ id: "audit_1" })) };
  const module = await Test.createTestingModule({
    controllers: [SupportViewController],
    providers: [
      { provide: CLOUD_TASK_STORE, useValue: store },
      { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: identity },
      { provide: FilePlatformService, useValue: files },
      { provide: AUDIT_SERVICE, useValue: audit },
      ...(agentApi ? [{ provide: AgentApiController, useValue: agentApi }] : []),
    ],
  }).compile();
  return {
    audit,
    files,
    store,
    controller: module.get(SupportViewController),
  };
}

describe("SupportViewController", () => {
  it("scopes task reads to the selected organization member", async () => {
    const { audit, controller, store } = await controllerFor("admin");

    await controller.tasks(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, {});

    expect(store.listTaskPage).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: subjectId }));
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: actorId,
      category: "support",
      action: "support-view-read",
      targetType: "user_tasks",
      targetId: subjectId,
      metadata: { subjectUserId: subjectId },
    }));
  });

  it("rejects support view for non-administrators", async () => {
    const { controller } = await controllerFor("member");

    await expect(controller.tasks(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, {}))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it("delegates turns with the selected member as the effective owner", async () => {
    const agentApi = {
      startTurn: vi.fn(async (_request: unknown, _sessionId: string, _body: unknown) => ({ turnId: "turn_1", sessionId })),
    };
    const { audit, controller } = await controllerFor("admin", agentApi);

    await expect(controller.startTurn(
      requestFor(actorId),
      SELF_HOST_TENANT_ID,
      subjectId,
      sessionId,
      { input: "Run this prompt", workspacePath: "/workspace" },
    )).resolves.toEqual({ turnId: "turn_1", sessionId });

    const delegatedRequest = agentApi.startTurn.mock.calls[0]?.[0] as any;
    expect(delegatedRequest.auth.user.id).toBe(subjectId);
    expect(delegatedRequest.auth.session.userId).toBe(subjectId);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: actorId,
      action: "support-view-write",
      targetType: "turn",
      targetId: sessionId,
      sessionId,
      metadata: { subjectUserId: subjectId },
    }));
  });

  it("verifies session ownership before returning messages", async () => {
    const { controller, store } = await controllerFor("owner");

    await controller.messages(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, sessionId, {});

    expect(store.getTask).toHaveBeenCalledWith(taskId, subjectId);
    expect(store.listMessages).toHaveBeenCalledWith(sessionId);
  });

  it("returns a bad request for invalid collection queries", async () => {
    const { controller } = await controllerFor("admin");

    await expect(controller.tasks(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, { limit: "not-a-number" }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("applies the bounded message-history cursor contract", async () => {
    const { controller, store } = await controllerFor("admin");

    await expect(controller.messages(
      requestFor(actorId),
      SELF_HOST_TENANT_ID,
      subjectId,
      sessionId,
      { before: "1", after: "2" },
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.messages(
      requestFor(actorId),
      SELF_HOST_TENANT_ID,
      subjectId,
      sessionId,
      { before: "9223372036854775808" },
    )).rejects.toBeInstanceOf(BadRequestException);

    expect(store.listMessagePage).not.toHaveBeenCalled();
  });

  it("audits file download attempts and successful delivery separately", async () => {
    const { audit, controller, files } = await controllerFor("admin");
    const response = { setHeader: vi.fn(), statusCode: 200 };

    await controller.fileContent(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, fileId, "1", response as any);

    expect(files.describe).toHaveBeenCalledWith(SELF_HOST_TENANT_ID, subjectId, fileId);
    expect(audit.append).toHaveBeenNthCalledWith(1, expect.objectContaining({
      actorUserId: actorId,
      action: "support-view-file-download-requested",
      targetType: "file",
      targetId: fileId,
      metadata: { subjectUserId: subjectId },
    }));
    expect(audit.append).toHaveBeenNthCalledWith(2, expect.objectContaining({
      actorUserId: actorId,
      action: "support-view-file-downloaded",
      targetType: "file",
      targetId: fileId,
      metadata: { subjectUserId: subjectId, statusCode: 200, partial: false },
    }));
    expect(files.streamContent).toHaveBeenCalledWith(
      SELF_HOST_TENANT_ID,
      subjectId,
      fileId,
      undefined,
      response,
      true,
      undefined,
    );
  });

  it("does not record completed delivery when file streaming fails", async () => {
    const { audit, controller, files } = await controllerFor("admin");
    files.streamContent.mockRejectedValueOnce(new Error("object storage unavailable"));
    const response = { setHeader: vi.fn(), statusCode: 200 };

    await expect(controller.fileContent(
      requestFor(actorId),
      SELF_HOST_TENANT_ID,
      subjectId,
      fileId,
      undefined,
      response as any,
    )).rejects.toThrow("object storage unavailable");

    expect(audit.append).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: "support-view-file-preview-requested" }));
  });

  it("returns scoped generated-image URLs from list and single-message reads", async () => {
    const { controller } = await controllerFor("admin");
    const contentPath = `/v1/orgs/${SELF_HOST_TENANT_ID}/support/users/${subjectId}/files/${fileId}/content`;

    const messages = await controller.messages(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, sessionId, {});
    const message = await controller.message(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, sessionId, messageId);

    expect((messages as any[])[0].parts[0].content).toMatchObject({
      src: contentPath,
      downloadUrl: `${contentPath}?download=1`,
    });
    expect((message as any).parts[0].content).toMatchObject({
      src: contentPath,
      downloadUrl: `${contentPath}?download=1`,
    });
  });

  it("rejects malformed task, session, and message identifiers before their store reads", async () => {
    const { controller, store } = await controllerFor("admin");

    await expect(controller.task(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, "not-a-task"))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.session(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, "not-a-session"))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.message(requestFor(actorId), SELF_HOST_TENANT_ID, subjectId, sessionId, "not-a-message"))
      .rejects.toBeInstanceOf(BadRequestException);

    expect(store.getMessage).not.toHaveBeenCalled();
  });
});
