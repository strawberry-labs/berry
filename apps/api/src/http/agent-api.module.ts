import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import type { SessionHost } from "@berry/local-agent";
import { AuditModule, type AuditModuleOptions } from "../audit/audit.module.ts";
import { BerryAuthModule, type BerryAuthProvider } from "../auth/auth.module.ts";
import { BillingModule, type BillingModuleOptions } from "../billing/billing.module.ts";
import { BudgetModule, type BudgetModuleOptions } from "../budget/budget.module.ts";
import { EnterpriseIdentityModule, type EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import { ModelGovernanceModule, type ModelGovernanceModuleOptions } from "../model-governance/model-governance.module.ts";
import { PolicyDistributionModule, type PolicyDistributionModuleOptions } from "../policy-distribution/policy-distribution.module.ts";
import { SessionHostModule } from "../runtime/session-host.module.ts";
import { CloudRuntimeConfigService } from "../runtime/cloud-runtime-config.ts";
import { UsageModule, type UsageModuleOptions } from "../usage/usage.module.ts";
import { AgentApiController } from "./agent-api.controller.ts";
import { CLOUD_TASK_STORE, InMemoryCloudTaskStore, type CloudTaskStore } from "./cloud-task-store.ts";
import { ApiEventStreamService } from "./event-stream.service.ts";
import { CompanionPushService, InMemoryMobileDeviceRegistry, MOBILE_DEVICE_REGISTRY, type MobileDeviceRegistry } from "./mobile-devices.ts";
import { FixtureSandboxProvider } from "@berry/sandbox-contract";
import { SANDBOX_WORKSPACE_SERVICE, SandboxWorkspaceService } from "./sandbox-workspace.service.ts";
import { PersonalCapabilitiesController } from "./personal-capabilities.controller.ts";
import { PERSONAL_CAPABILITIES, PersonalCapabilitiesService } from "./personal-capabilities.service.ts";
import { OrganizationCapabilitiesController } from "./organization-capabilities.controller.ts";
import { ORGANIZATION_CAPABILITIES, OrganizationCapabilitiesService } from "./organization-capabilities.service.ts";
import { ManagementModule, type ManagementModuleOptions } from "../management/management.module.ts";

export type AgentApiModuleOptions = {
  sessionHost: { useValue: SessionHost } | Pick<FactoryProvider<SessionHost>, "inject" | "useFactory">;
  taskStore?: { useValue: CloudTaskStore } | Pick<FactoryProvider<CloudTaskStore>, "inject" | "useFactory">;
  mobileDevices?: { useValue: MobileDeviceRegistry } | Pick<FactoryProvider<MobileDeviceRegistry>, "inject" | "useFactory">;
  auth?: BerryAuthProvider;
  identity?: EnterpriseIdentityModuleOptions;
  budget?: BudgetModuleOptions;
  usage?: UsageModuleOptions;
  billing?: BillingModuleOptions;
  modelGovernance?: ModelGovernanceModuleOptions;
  policyDistribution?: PolicyDistributionModuleOptions;
  audit?: AuditModuleOptions;
  sandboxWorkspace?: { useValue: SandboxWorkspaceService };
  personalCapabilities?: { useValue: PersonalCapabilitiesService };
  organizationCapabilities?: { useValue: OrganizationCapabilitiesService };
  management?: ManagementModuleOptions;
};

@Module({})
export class AgentApiModule {
  static register(options: AgentApiModuleOptions): DynamicModule {
    const storeProvider: Provider<CloudTaskStore> = options.taskStore
      ? "useValue" in options.taskStore
        ? { provide: CLOUD_TASK_STORE, useValue: options.taskStore.useValue }
        : { provide: CLOUD_TASK_STORE, inject: options.taskStore.inject ?? [], useFactory: options.taskStore.useFactory }
      : { provide: CLOUD_TASK_STORE, useClass: InMemoryCloudTaskStore };
    const authModuleOptions = options.auth ? { runtime: options.auth } : {};
    const mobileDeviceProvider: Provider<MobileDeviceRegistry> = options.mobileDevices
      ? "useValue" in options.mobileDevices
        ? { provide: MOBILE_DEVICE_REGISTRY, useValue: options.mobileDevices.useValue }
        : { provide: MOBILE_DEVICE_REGISTRY, inject: options.mobileDevices.inject ?? [], useFactory: options.mobileDevices.useFactory }
      : { provide: MOBILE_DEVICE_REGISTRY, useClass: InMemoryMobileDeviceRegistry };
    const sandboxWorkspaceProvider: Provider<SandboxWorkspaceService> = options.sandboxWorkspace
      ? { provide: SANDBOX_WORKSPACE_SERVICE, useValue: options.sandboxWorkspace.useValue }
      : { provide: SANDBOX_WORKSPACE_SERVICE, useFactory: () => new SandboxWorkspaceService({ provider: new FixtureSandboxProvider() }) };
    return {
      module: AgentApiModule,
      imports: [
        BerryAuthModule.register(authModuleOptions),
        AuditModule.register({ ...(options.audit ?? {}), identity: options.audit?.identity ?? options.identity }),
        EnterpriseIdentityModule.register(options.identity ?? {}),
        BudgetModule.register({ ...(options.budget ?? {}), identity: options.budget?.identity ?? options.identity }),
        UsageModule.register({ ...(options.usage ?? {}), identity: options.usage?.identity ?? options.identity }),
        BillingModule.register({ ...(options.billing ?? {}), identity: options.billing?.identity ?? options.identity }),
        ModelGovernanceModule.register({ ...(options.modelGovernance ?? {}), identity: options.modelGovernance?.identity ?? options.identity }),
        PolicyDistributionModule.register({ ...(options.policyDistribution ?? {}), identity: options.policyDistribution?.identity ?? options.identity }),
        ManagementModule.register({ ...(options.management ?? {}), ...((options.management?.identity ?? options.identity) ? { identity: options.management?.identity ?? options.identity } : {}) }),
        SessionHostModule.register(options.sessionHost),
      ],
      controllers: [AgentApiController, PersonalCapabilitiesController, OrganizationCapabilitiesController],
      providers: [storeProvider, mobileDeviceProvider, sandboxWorkspaceProvider, options.personalCapabilities ? { provide: PERSONAL_CAPABILITIES, useValue: options.personalCapabilities.useValue } : { provide: PERSONAL_CAPABILITIES, useClass: PersonalCapabilitiesService }, options.organizationCapabilities ? { provide: ORGANIZATION_CAPABILITIES, useValue: options.organizationCapabilities.useValue } : { provide: ORGANIZATION_CAPABILITIES, inject: [PERSONAL_CAPABILITIES], useFactory: (personal: PersonalCapabilitiesService) => new OrganizationCapabilitiesService(personal) }, ApiEventStreamService, CompanionPushService, CloudRuntimeConfigService],
      exports: [CLOUD_TASK_STORE, MOBILE_DEVICE_REGISTRY, ApiEventStreamService, CompanionPushService],
    };
  }
}
