import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  InMemoryEnterpriseIdentityRepository,
  type EnterpriseIdentityRepository,
} from "../identity/identity.repository.ts";
import type { EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import { InMemoryUsageRepository, USAGE_REPOSITORY, type UsageRepository } from "./usage.repository.ts";
import { UsageController } from "./usage.controller.ts";
import {
  HmacUsageEventVerifier,
  USAGE_EVENT_VERIFIER,
  type UsageEventVerifier,
} from "./usage.signing.ts";

export type UsageRepositoryProvider =
  | { useValue: UsageRepository }
  | Pick<FactoryProvider<UsageRepository>, "inject" | "useFactory">;

export type UsageEventVerifierProvider =
  | { useValue: UsageEventVerifier }
  | Pick<FactoryProvider<UsageEventVerifier>, "inject" | "useFactory">;

export type UsageModuleOptions = {
  repository?: UsageRepositoryProvider | undefined;
  verifier?: UsageEventVerifierProvider | undefined;
  identity?: EnterpriseIdentityModuleOptions | undefined;
};

@Module({})
export class UsageModule {
  static register(options: UsageModuleOptions = {}): DynamicModule {
    const repositoryProvider: Provider<UsageRepository> = options.repository
      ? "useValue" in options.repository
        ? { provide: USAGE_REPOSITORY, useValue: options.repository.useValue }
        : { provide: USAGE_REPOSITORY, inject: options.repository.inject ?? [], useFactory: options.repository.useFactory }
      : { provide: USAGE_REPOSITORY, useClass: InMemoryUsageRepository };
    const verifierProvider: Provider<UsageEventVerifier> = options.verifier
      ? "useValue" in options.verifier
        ? { provide: USAGE_EVENT_VERIFIER, useValue: options.verifier.useValue }
        : { provide: USAGE_EVENT_VERIFIER, inject: options.verifier.inject ?? [], useFactory: options.verifier.useFactory }
      : { provide: USAGE_EVENT_VERIFIER, useValue: new HmacUsageEventVerifier({ secrets: new Map() }) };
    const identityProvider: Provider<EnterpriseIdentityRepository> = options.identity?.repository
      ? "useValue" in options.identity.repository
        ? { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: options.identity.repository.useValue }
        : { provide: ENTERPRISE_IDENTITY_REPOSITORY, inject: options.identity.repository.inject ?? [], useFactory: options.identity.repository.useFactory }
      : { provide: ENTERPRISE_IDENTITY_REPOSITORY, useClass: InMemoryEnterpriseIdentityRepository };

    return {
      module: UsageModule,
      controllers: [UsageController],
      providers: [repositoryProvider, verifierProvider, identityProvider],
      exports: [USAGE_REPOSITORY, USAGE_EVENT_VERIFIER],
    };
  }
}
