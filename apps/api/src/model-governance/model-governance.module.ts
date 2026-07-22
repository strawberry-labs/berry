import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  InMemoryEnterpriseIdentityRepository,
  type EnterpriseIdentityRepository,
} from "../identity/identity.repository.ts";
import type { EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import { ModelGovernanceController } from "./model-governance.controller.ts";
import {
  InMemoryModelGovernanceRepository,
  MODEL_GOVERNANCE_SERVICE,
  ModelGovernanceService,
  type ModelGovernanceRepository,
} from "./model-governance.service.ts";

export type ModelGovernanceServiceProvider =
  | { useValue: ModelGovernanceService }
  | Pick<FactoryProvider<ModelGovernanceService>, "inject" | "useFactory">;

export type ModelGovernanceRepositoryProvider =
  | { useValue: ModelGovernanceRepository }
  | Pick<FactoryProvider<ModelGovernanceRepository>, "inject" | "useFactory">;

export type ModelGovernanceModuleOptions = {
  service?: ModelGovernanceServiceProvider | undefined;
  repository?: ModelGovernanceRepositoryProvider | undefined;
  identity?: EnterpriseIdentityModuleOptions | undefined;
};

@Module({})
export class ModelGovernanceModule {
  static register(options: ModelGovernanceModuleOptions = {}): DynamicModule {
    const serviceProvider: Provider<ModelGovernanceService> = options.service
      ? "useValue" in options.service
        ? { provide: MODEL_GOVERNANCE_SERVICE, useValue: options.service.useValue }
        : { provide: MODEL_GOVERNANCE_SERVICE, inject: options.service.inject ?? [], useFactory: options.service.useFactory }
      : {
          provide: MODEL_GOVERNANCE_SERVICE,
          useFactory: (repository?: ModelGovernanceRepository) => new ModelGovernanceService(repository ?? new InMemoryModelGovernanceRepository()),
          inject: options.repository ? [MODEL_GOVERNANCE_REPOSITORY] : [],
        };
    const repositoryProvider: Provider<ModelGovernanceRepository> | null = options.repository
      ? "useValue" in options.repository
        ? { provide: MODEL_GOVERNANCE_REPOSITORY, useValue: options.repository.useValue }
        : { provide: MODEL_GOVERNANCE_REPOSITORY, inject: options.repository.inject ?? [], useFactory: options.repository.useFactory }
      : null;
    const identityProvider: Provider<EnterpriseIdentityRepository> = options.identity?.repository
      ? "useValue" in options.identity.repository
        ? { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: options.identity.repository.useValue }
        : { provide: ENTERPRISE_IDENTITY_REPOSITORY, inject: options.identity.repository.inject ?? [], useFactory: options.identity.repository.useFactory }
      : { provide: ENTERPRISE_IDENTITY_REPOSITORY, useClass: InMemoryEnterpriseIdentityRepository };

    return {
      module: ModelGovernanceModule,
      controllers: [ModelGovernanceController],
      providers: [identityProvider, ...(repositoryProvider ? [repositoryProvider] : []), serviceProvider],
      exports: [MODEL_GOVERNANCE_SERVICE],
    };
  }
}

const MODEL_GOVERNANCE_REPOSITORY = Symbol("MODEL_GOVERNANCE_REPOSITORY");
