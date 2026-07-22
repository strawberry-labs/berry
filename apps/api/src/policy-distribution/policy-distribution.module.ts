import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  InMemoryEnterpriseIdentityRepository,
  type EnterpriseIdentityRepository,
} from "../identity/identity.repository.ts";
import type { EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import { PolicyDistributionController } from "./policy-distribution.controller.ts";
import {
  InMemoryPolicyDistributionRepository,
  POLICY_DISTRIBUTION_SERVICE,
  PolicyDistributionService,
  type PolicyDistributionRepository,
  type PolicySigner,
} from "./policy-distribution.service.ts";

export type PolicyDistributionServiceProvider =
  | { useValue: PolicyDistributionService }
  | Pick<FactoryProvider<PolicyDistributionService>, "inject" | "useFactory">;

export type PolicyDistributionRepositoryProvider =
  | { useValue: PolicyDistributionRepository }
  | Pick<FactoryProvider<PolicyDistributionRepository>, "inject" | "useFactory">;

export type PolicySignerProvider =
  | { useValue: PolicySigner | null }
  | Pick<FactoryProvider<PolicySigner | null>, "inject" | "useFactory">;

export type PolicyDistributionModuleOptions = {
  service?: PolicyDistributionServiceProvider | undefined;
  repository?: PolicyDistributionRepositoryProvider | undefined;
  signer?: PolicySignerProvider | undefined;
  identity?: EnterpriseIdentityModuleOptions | undefined;
};

@Module({})
export class PolicyDistributionModule {
  static register(options: PolicyDistributionModuleOptions = {}): DynamicModule {
    const repositoryProvider: Provider<PolicyDistributionRepository> | null = options.repository
      ? "useValue" in options.repository
        ? { provide: POLICY_DISTRIBUTION_REPOSITORY, useValue: options.repository.useValue }
        : { provide: POLICY_DISTRIBUTION_REPOSITORY, inject: options.repository.inject ?? [], useFactory: options.repository.useFactory }
      : null;
    const signerProvider: Provider<PolicySigner | null> | null = options.signer
      ? "useValue" in options.signer
        ? { provide: POLICY_SIGNER, useValue: options.signer.useValue }
        : { provide: POLICY_SIGNER, inject: options.signer.inject ?? [], useFactory: options.signer.useFactory }
      : null;
    const serviceProvider: Provider<PolicyDistributionService> = options.service
      ? "useValue" in options.service
        ? { provide: POLICY_DISTRIBUTION_SERVICE, useValue: options.service.useValue }
        : { provide: POLICY_DISTRIBUTION_SERVICE, inject: options.service.inject ?? [], useFactory: options.service.useFactory }
      : {
          provide: POLICY_DISTRIBUTION_SERVICE,
          useFactory: (repository?: PolicyDistributionRepository, signer?: PolicySigner | null) =>
            new PolicyDistributionService(repository ?? new InMemoryPolicyDistributionRepository(), signer ?? null),
          inject: [repositoryProvider ? POLICY_DISTRIBUTION_REPOSITORY : OPTIONAL_REPOSITORY, signerProvider ? POLICY_SIGNER : OPTIONAL_SIGNER],
        };
    const optionalRepositoryProvider: Provider<PolicyDistributionRepository | null> = { provide: OPTIONAL_REPOSITORY, useValue: null };
    const optionalSignerProvider: Provider<PolicySigner | null> = { provide: OPTIONAL_SIGNER, useValue: null };
    const identityProvider: Provider<EnterpriseIdentityRepository> = options.identity?.repository
      ? "useValue" in options.identity.repository
        ? { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: options.identity.repository.useValue }
        : { provide: ENTERPRISE_IDENTITY_REPOSITORY, inject: options.identity.repository.inject ?? [], useFactory: options.identity.repository.useFactory }
      : { provide: ENTERPRISE_IDENTITY_REPOSITORY, useClass: InMemoryEnterpriseIdentityRepository };

    return {
      module: PolicyDistributionModule,
      controllers: [PolicyDistributionController],
      providers: [
        identityProvider,
        optionalRepositoryProvider,
        optionalSignerProvider,
        ...(repositoryProvider ? [repositoryProvider] : []),
        ...(signerProvider ? [signerProvider] : []),
        serviceProvider,
      ],
      exports: [POLICY_DISTRIBUTION_SERVICE],
    };
  }
}

const POLICY_DISTRIBUTION_REPOSITORY = Symbol("POLICY_DISTRIBUTION_REPOSITORY");
const POLICY_SIGNER = Symbol("POLICY_SIGNER");
const OPTIONAL_REPOSITORY = Symbol("OPTIONAL_POLICY_DISTRIBUTION_REPOSITORY");
const OPTIONAL_SIGNER = Symbol("OPTIONAL_POLICY_SIGNER");
