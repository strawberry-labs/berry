import { BrowserHandoffController } from "../browser/browser-handoff.controller.js";
import { Body, Controller, Delete, Get, Header, Inject, Optional, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { AllowanceController } from "../budget/allowance.controller.ts";
import { ScheduledTasksController } from "../schedules/scheduled-tasks.controller.ts";
import { UsageController } from "../usage/usage.controller.ts";
import { MemberSkillsController } from "./member-skills.controller.ts";
import { OrganizationCapabilitiesController } from "./organization-capabilities.controller.ts";
import { PersonalCapabilitiesController } from "./personal-capabilities.controller.ts";
import { SupportViewController } from "./support-view.controller.ts";

/** Only workspace features are delegated; support authorization and audits keep the original actor. */
@Controller("/v1/orgs/:tenantId/support/users/:userId")
export class SupportWorkspaceController {
  constructor(
    @Inject(SupportViewController) private readonly support: SupportViewController,
    @Inject(ScheduledTasksController) private readonly schedules: ScheduledTasksController,
    @Inject(PersonalCapabilitiesController) private readonly personal: PersonalCapabilitiesController,
    @Inject(OrganizationCapabilitiesController) private readonly capabilities: OrganizationCapabilitiesController,
    @Inject(MemberSkillsController) private readonly memberSkills: MemberSkillsController,
    @Inject(AllowanceController) private readonly allowances: AllowanceController,
    @Inject(UsageController) private readonly usage: UsageController,
    @Optional() @Inject(BrowserHandoffController) private readonly browsers?: BrowserHandoffController,
  ) {}

  @Get("/sessions/:sessionId/browser")
  @Header("Cache-Control", "no-store")
  browserState(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Param("sessionId") sessionId: string) {
    return this.support.subjectRead(request, tenantId, userId, { targetType: "browser_handoff", targetId: sessionId, sessionId, metadata: { operation: "browserState" } }, (scoped) => this.browsers!.state(scoped, sessionId));
  }

  @Post("/sessions/:sessionId/browser/take-control")
  @Header("Cache-Control", "no-store")
  browserTakeControl(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    return this.support.subjectWrite(request, tenantId, userId, { targetType: "browser_handoff", targetId: sessionId, sessionId, metadata: { operation: "browserTakeControl" } }, (scoped) => this.browsers!.takeControl(scoped, sessionId, body));
  }

  @Post("/sessions/:sessionId/browser/connection")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  browserConnection(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    return this.support.subjectWrite(request, tenantId, userId, { targetType: "browser_handoff", targetId: sessionId, sessionId, metadata: { operation: "browserConnection" } }, (scoped) => this.browsers!.connection(scoped, sessionId, body));
  }

  @Post("/sessions/:sessionId/browser/resume")
  @Header("Cache-Control", "no-store")
  browserResume(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    return this.support.subjectWrite(request, tenantId, userId, { targetType: "browser_handoff", targetId: sessionId, sessionId, metadata: { operation: "browserResume" } }, (scoped) => this.browsers!.resume(scoped, sessionId, body));
  }

  @Get("/scheduled-tasks")
  listAutomations(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "automation", targetId: userId, metadata: { operation: "listAutomations" },
    }, (scoped) => this.schedules.list(scoped));
  }

  @Post("/scheduled-tasks")
  createAutomation(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.support.subjectWrite(request, tenantId, userId, {
      targetType: "automation", targetId: userId, metadata: { operation: "createAutomation" },
    }, (scoped) => this.schedules.create(scoped, body));
  }

  @Patch("/scheduled-tasks/:id")
  updateAutomation(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.support.subjectWrite(request, tenantId, userId, {
      targetType: "automation", targetId: id, metadata: { operation: "updateAutomation" },
    }, (scoped) => this.schedules.update(scoped, id, body));
  }

  @Delete("/scheduled-tasks/:id")
  deleteAutomation(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
  ) {
    return this.support.subjectWrite(request, tenantId, userId, {
      targetType: "automation", targetId: id, metadata: { operation: "deleteAutomation" },
    }, (scoped) => this.schedules.remove(scoped, id));
  }

  @Get("/scheduled-tasks/:id/runs")
  automationRuns(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "automation_runs", targetId: id, metadata: { operation: "automationRuns" },
    }, (scoped) => this.schedules.history(scoped, id, limit));
  }

  @Post("/scheduled-tasks/:id/run")
  runAutomation(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.support.subjectWrite(request, tenantId, userId, {
      targetType: "automation", targetId: id, metadata: { operation: "runAutomation" },
    }, (scoped) => this.schedules.run(scoped, id, body));
  }

  @Get("/allowances/me")
  allowance(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "allowance", targetId: userId, metadata: { operation: "allowance" },
    }, (scoped) => this.allowances.myBalance(scoped, tenantId));
  }

  @Get("/usage/me")
  myUsage(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "usage", targetId: userId, metadata: { operation: "myUsage" },
    }, (scoped) => this.usage.myUsage(scoped, tenantId, query));
  }

  @Get("/usage/me/requests")
  usageRequests(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "usage_requests", targetId: userId, metadata: { operation: "usageRequests" },
    }, (scoped) => this.usage.myRequests(scoped, tenantId, query));
  }

  @Get("/usage/me/export.csv")
  @Header("content-type", "text/csv; charset=utf-8")
  exportUsage(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "usage_export", targetId: userId, metadata: { operation: "exportUsage" },
    }, (scoped) => this.usage.exportMyUsageCsv(scoped, tenantId, query));
  }

  @Get("/me/skills")
  skills(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "personal_skills", targetId: userId, metadata: { operation: "skills" },
    }, (scoped) => this.personal.listSkills(scoped));
  }

  @Get("/me/skills/:id/package")
  skillPackage(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "personal_skill", targetId: id, metadata: { operation: "skillPackage" },
    }, (scoped) => this.personal.skillPackage(scoped, id));
  }

  @Post("/me/skills/review")
  reviewSkill(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "personal_skills", targetId: userId, metadata: { operation: "reviewSkill" },
    }, async (scoped) => this.personal.reviewSkill(body));
  }

  @Post("/me/skills/packages")
  installSkill(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.support.subjectWrite(request, tenantId, userId, {
      targetType: "personal_skills", targetId: userId, metadata: { operation: "installSkill" },
    }, (scoped) => this.personal.installPackage(scoped, body));
  }

  @Post("/me/skills")
  saveSkill(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.support.subjectWrite(request, tenantId, userId, {
      targetType: "personal_skills", targetId: userId, metadata: { operation: "saveSkill" },
    }, (scoped) => this.memberSkills.save(request, tenantId, userId, body));
  }

  @Patch("/me/skills/:id")
  updateSkill(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.support.subjectWrite(request, tenantId, userId, {
      targetType: "personal_skill", targetId: id, metadata: { operation: "updateSkill" },
    }, (scoped) => this.memberSkills.toggle(request, tenantId, userId, id, body));
  }

  @Delete("/me/skills/:id")
  deleteSkill(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
  ) {
    return this.support.subjectWrite(request, tenantId, userId, {
      targetType: "personal_skill", targetId: id, metadata: { operation: "deleteSkill" },
    }, (scoped) => this.memberSkills.remove(request, tenantId, userId, id));
  }

  @Get("/capabilities/effective/me")
  effectiveCapabilities(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "capabilities", targetId: userId, metadata: { operation: "effectiveCapabilities" },
    }, (scoped) => this.memberSkills.list(request, tenantId, userId).then((value) => value.effective));
  }

  @Get("/capabilities/skills/:id/package")
  organizationSkillPackage(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "organization_skill", targetId: id, metadata: { operation: "organizationSkillPackage" },
    }, (scoped) => this.capabilities.skillPackage(scoped, tenantId, id));
  }

  @Get("/capabilities/skills/:id/package/file")
  organizationSkillFile(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("id") id: string,
    @Query("path") path: unknown,
  ) {
    return this.support.subjectRead(request, tenantId, userId, {
      targetType: "organization_skill", targetId: id, metadata: { operation: "organizationSkillFile" },
    }, (scoped) => this.capabilities.skillPackageFile(scoped, tenantId, id, path));
  }
}
