import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { ScimGroupSchema, ScimUserSchema } from "@berry/shared";
import { z } from "zod";
import { PublicAuth } from "../auth/auth.decorators.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "./identity.repository.ts";
import { ScimBearerGuard } from "./scim.guard.ts";

const ScimEmailSchema = z.object({
  value: z.string().email(),
  primary: z.boolean().optional(),
}).passthrough();

const ScimUserInputSchema = z.object({
  id: z.string().optional(),
  externalId: z.string().nullable().optional(),
  userName: z.string().email(),
  active: z.boolean().default(true),
  name: z.object({
    formatted: z.string().optional(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
  }).default({}),
  emails: z.array(ScimEmailSchema).default([]),
  groups: z.array(z.object({
    value: z.string(),
    display: z.string().optional(),
  }).passthrough()).default([]),
}).passthrough();

const ScimGroupInputSchema = z.object({
  id: z.string().optional(),
  externalId: z.string().nullable().optional(),
  displayName: z.string().min(1),
  members: z.array(z.object({
    value: z.string(),
    display: z.string().optional(),
  }).passthrough()).default([]),
}).passthrough();

const ScimPatchSchema = z.object({
  Operations: z.array(z.object({
    op: z.string(),
    path: z.string().optional(),
    value: z.unknown().optional(),
  }).passthrough()).default([]),
}).passthrough();

@Controller("/v1/scim/:tenantId")
@PublicAuth()
@UseGuards(ScimBearerGuard)
export class ScimController {
  constructor(@Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly repository: EnterpriseIdentityRepository) {}

  @Get("/ServiceProviderConfig")
  serviceProviderConfig() {
    return {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 100 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer", primary: true }],
    };
  }

  @Get("/ResourceTypes")
  resourceTypes() {
    return {
      Resources: [
        { id: "User", name: "User", endpoint: "/Users", schema: "urn:ietf:params:scim:schemas:core:2.0:User" },
        { id: "Group", name: "Group", endpoint: "/Groups", schema: "urn:ietf:params:scim:schemas:core:2.0:Group" },
      ],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
    };
  }

  @Post("/Users")
  async createUser(@Param("tenantId") tenantId: string, @Body() body: unknown) {
    const input = normalizeUser(body);
    return scimUserResponse(await this.repository.upsertScimUser(tenantId, input));
  }

  @Put("/Users/:id")
  async replaceUser(@Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const input = normalizeUser({ ...(body as object), id });
    return scimUserResponse(await this.repository.upsertScimUser(tenantId, input));
  }

  @Patch("/Users/:id")
  async patchUser(@Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const patch = parseBody(ScimPatchSchema, body);
    const activeOperation = patch.Operations.find((operation) => operation.path?.toLowerCase() === "active" || typeof operation.value === "object");
    if (activeOperation?.path?.toLowerCase() === "active" && activeOperation.value === false) {
      await this.repository.deprovisionScimUser(tenantId, id);
      return { id, active: false };
    }
    throw new BadRequestException("Only active=false SCIM user patches are supported in v1");
  }

  @Delete("/Users/:id")
  async deleteUser(@Param("tenantId") tenantId: string, @Param("id") id: string) {
    return { ...await this.repository.deprovisionScimUser(tenantId, id), active: false };
  }

  @Post("/Groups")
  async createGroup(@Param("tenantId") tenantId: string, @Body() body: unknown) {
    const input = normalizeGroup(body);
    return scimGroupResponse(await this.repository.upsertScimGroup(tenantId, input));
  }

  @Put("/Groups/:id")
  async replaceGroup(@Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const input = normalizeGroup({ ...(body as object), id });
    return scimGroupResponse(await this.repository.upsertScimGroup(tenantId, input));
  }

  @Delete("/Groups/:id")
  async deleteGroup(@Param("tenantId") tenantId: string, @Param("id") id: string) {
    return { ...await this.repository.deprovisionScimGroup(tenantId, id), active: false };
  }
}

function normalizeUser(body: unknown) {
  const input = parseBody(ScimUserInputSchema, body);
  const id = input.id ?? input.externalId ?? input.userName;
  return ScimUserSchema.parse({
    ...input,
    id,
    externalId: input.externalId ?? input.userName,
    emails: input.emails.length > 0 ? input.emails : [{ value: input.userName, primary: true }],
  });
}

function normalizeGroup(body: unknown) {
  const input = parseBody(ScimGroupInputSchema, body);
  return ScimGroupSchema.parse({
    ...input,
    id: input.id ?? input.externalId ?? input.displayName,
    externalId: input.externalId ?? input.displayName,
  });
}

function scimUserResponse(user: z.infer<typeof ScimUserSchema>) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    ...user,
  };
}

function scimGroupResponse(group: z.infer<typeof ScimGroupSchema>) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    ...group,
  };
}

function parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
