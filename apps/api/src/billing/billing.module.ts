import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  InMemoryEnterpriseIdentityRepository,
  type EnterpriseIdentityRepository,
} from "../identity/identity.repository.ts";
import type { EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import {
  BILLING_SERVICE,
  BillingService,
  InMemoryBillingRepository,
  NoopBillingProvider,
  type BillingProvider,
  type BillingRepository,
} from "./billing.service.ts";
import { BillingController } from "./billing.controller.ts";

export type BillingServiceProvider =
  | { useValue: BillingService }
  | Pick<FactoryProvider<BillingService>, "inject" | "useFactory">;

export type BillingRepositoryProvider =
  | { useValue: BillingRepository }
  | Pick<FactoryProvider<BillingRepository>, "inject" | "useFactory">;

export type BillingProviderProvider =
  | { useValue: BillingProvider }
  | Pick<FactoryProvider<BillingProvider>, "inject" | "useFactory">;

export type BillingModuleOptions = {
  service?: BillingServiceProvider | undefined;
  repository?: BillingRepositoryProvider | undefined;
  provider?: BillingProviderProvider | undefined;
  dependencyRequired?: boolean | undefined;
  identity?: EnterpriseIdentityModuleOptions | undefined;
};

@Module({})
export class BillingModule {
  static register(options: BillingModuleOptions = {}): DynamicModule {
    const repositoryProvider: Provider<BillingRepository> = options.repository
      ? "useValue" in options.repository
        ? { provide: InMemoryBillingRepository, useValue: options.repository.useValue }
        : { provide: InMemoryBillingRepository, inject: options.repository.inject ?? [], useFactory: options.repository.useFactory }
      : { provide: InMemoryBillingRepository, useClass: InMemoryBillingRepository };
    const providerProvider: Provider<BillingProvider> = options.provider
      ? "useValue" in options.provider
        ? { provide: NoopBillingProvider, useValue: options.provider.useValue }
        : { provide: NoopBillingProvider, inject: options.provider.inject ?? [], useFactory: options.provider.useFactory }
      : { provide: NoopBillingProvider, useClass: NoopBillingProvider };
    const serviceProvider: Provider<BillingService> = options.service
      ? "useValue" in options.service
        ? { provide: BILLING_SERVICE, useValue: options.service.useValue }
        : { provide: BILLING_SERVICE, inject: options.service.inject ?? [], useFactory: options.service.useFactory }
      : {
          provide: BILLING_SERVICE,
          inject: [InMemoryBillingRepository, NoopBillingProvider],
          useFactory: (repository: BillingRepository, provider: BillingProvider) => new BillingService({
            repository,
            provider,
            dependencyRequired: options.dependencyRequired,
          }),
        };
    const identityProvider: Provider<EnterpriseIdentityRepository> = options.identity?.repository
      ? "useValue" in options.identity.repository
        ? { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: options.identity.repository.useValue }
        : { provide: ENTERPRISE_IDENTITY_REPOSITORY, inject: options.identity.repository.inject ?? [], useFactory: options.identity.repository.useFactory }
      : { provide: ENTERPRISE_IDENTITY_REPOSITORY, useClass: InMemoryEnterpriseIdentityRepository };

    return {
      module: BillingModule,
      controllers: [BillingController],
      providers: [repositoryProvider, providerProvider, serviceProvider, identityProvider],
      exports: [BILLING_SERVICE],
    };
  }
}
