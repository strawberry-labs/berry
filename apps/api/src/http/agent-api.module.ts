import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import type { SessionHost } from "@berry/local-agent";
import { AuditModule, type AuditModuleOptions } from "../audit/audit.module.ts";
import { BerryAuthModule, type BerryAuthProvider } from "../auth/auth.module.ts";
import { BillingModule, type BillingModuleOptions } from "../billing/billing.module.ts";
import { BudgetModule, type BudgetModuleOptions } from "../budget/budget.module.ts";
import { EnterpriseIdentityModule, type EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import { ModelGovernanceModule, type ModelGovernanceModuleOptions } from "../model-governance/model-governance.module.ts";
import {
  ORGANIZATION_PROVIDER_RUNTIME,
  type OrganizationProviderRuntime,
} from "../model-governance/organization-provider-runtime.service.ts";
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
import { FilePlatformModule } from "../files/file-platform.module.ts";
import { MemoryModule } from "../memory/memory.module.ts";
import { ContextAssemblyService } from "../memory/context-assembly.service.ts";
import { MemoryService } from "../memory/memory.service.ts";
import { KnowledgeService } from "../knowledge/knowledge.service.ts";
import { DURABLE_TURN_RUNNER_ENABLED, DurableTurnService } from "../runtime/durable-turn.service.ts";
import { TurnCancellationPublisher } from "../runtime/turn-cancellation-publisher.ts";
import { CONNECTORS, ConnectorsService } from "../connectors/connectors.service.ts";
import { ConnectorsController, OrganizationConnectorsController } from "../connectors/connectors.controller.ts";
import { SetupModule } from "../setup/setup.module.ts";
import type { SetupService } from "../setup/setup.service.ts";
import { QueuedFollowUpService } from "../runtime/queued-follow-up.service.js";
import { SupportViewController } from "./support-view.controller.ts";

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
  durableRunnerEnabled?: boolean;
  durableContextEnabled?: boolean;
  connectors?: { useValue: ConnectorsService };
  setup?: { useValue: SetupService };
};

@Module({})
export class AgentApiModule {
  static register(options: AgentApiModuleOptions): DynamicModule {
    const durableContextEnabled = options.durableContextEnabled ?? options.durableRunnerEnabled ?? false;
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
        FilePlatformModule,
        ...(options.setup ? [SetupModule.register(options.setup.useValue)] : []),
        ...(durableContextEnabled ? [MemoryModule] : []),
        SessionHostModule.register(options.sessionHost),
      ],
      controllers: [AgentApiController, SupportViewController, PersonalCapabilitiesController, OrganizationCapabilitiesController, ConnectorsController, OrganizationConnectorsController],
      providers: [
        // SupportViewController delegates member-scoped operations through the
        // existing API surface. Register the controller as a provider as well
        // so that delegation is available in the production module.
        AgentApiController,
        storeProvider,
        mobileDeviceProvider,
        sandboxWorkspaceProvider,
        {
          provide: CONNECTORS,
          useValue: options.connectors?.useValue ?? {
            list: async () => [],
            runtime: async () => [],
          } as unknown as ConnectorsService,
        },
        options.personalCapabilities ? { provide: PERSONAL_CAPABILITIES, useValue: options.personalCapabilities.useValue } : { provide: PERSONAL_CAPABILITIES, useClass: PersonalCapabilitiesService },
        options.organizationCapabilities ? { provide: ORGANIZATION_CAPABILITIES, useValue: options.organizationCapabilities.useValue } : { provide: ORGANIZATION_CAPABILITIES, inject: [PERSONAL_CAPABILITIES], useFactory: (personal: PersonalCapabilitiesService) => new OrganizationCapabilitiesService(personal) },
        { provide: DURABLE_TURN_RUNNER_ENABLED, useValue: options.durableRunnerEnabled ?? false },
        TurnCancellationPublisher,
        QueuedFollowUpService,
        ...(durableContextEnabled
          ? [DurableTurnService]
          : [
              { provide: DurableTurnService, useValue: { enabled: false } },
              {
                provide: ContextAssemblyService,
                useValue: {
                  assemble: async () => ({
                    personalMemory: [],
                    projectFacts: [],
                    citations: [],
                    retrieval: {
                      snapshotId: null,
                      queryHash: "disabled",
                      tokenBudget: 0,
                      tokensSelected: 0,
                      degradedReason: "memory_disabled",
                    },
                  }),
                  portableCheckpoint: async () => null,
                },
              },
              {
                provide: MemoryService,
                useValue: {
                  remember: async () => ({ operation: "NOOP", reason: "disabled", item: null }),
                  forget: async () => null,
                  forgetMatching: async () => null,
                  enqueueExtraction: async () => undefined,
                },
              },
              {
                provide: KnowledgeService,
                useValue: { enqueueTaskOutcome: async () => undefined },
              },
            ]),
        ApiEventStreamService,
        CompanionPushService,
        {
          provide: CloudRuntimeConfigService,
          inject: [ORGANIZATION_PROVIDER_RUNTIME],
          useFactory: (organizationProviders: OrganizationProviderRuntime) =>
            new CloudRuntimeConfigService(process.env, organizationProviders),
        },
      ],
      exports: [CLOUD_TASK_STORE, MOBILE_DEVICE_REGISTRY, CONNECTORS, DurableTurnService, ApiEventStreamService, CompanionPushService, QueuedFollowUpService],
    };
  }
}
