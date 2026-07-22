import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  InMemoryEnterpriseIdentityRepository,
  type EnterpriseIdentityRepository,
} from "./identity.repository.ts";
import { IdentityController } from "./identity.controller.ts";
import { ScimController } from "./scim.controller.ts";
import { SCIM_BEARER_TOKEN, ScimBearerGuard } from "./scim.guard.ts";

export type EnterpriseIdentityProvider =
  | { useValue: EnterpriseIdentityRepository }
  | Pick<FactoryProvider<EnterpriseIdentityRepository>, "inject" | "useFactory">;

export type EnterpriseIdentityModuleOptions = {
  repository?: EnterpriseIdentityProvider | undefined;
  scimBearerToken?: string | null | undefined;
};

@Module({})
export class EnterpriseIdentityModule {
  static register(options: EnterpriseIdentityModuleOptions = {}): DynamicModule {
    const repositoryProvider: Provider<EnterpriseIdentityRepository> = options.repository
      ? "useValue" in options.repository
        ? { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: options.repository.useValue }
        : { provide: ENTERPRISE_IDENTITY_REPOSITORY, inject: options.repository.inject ?? [], useFactory: options.repository.useFactory }
      : { provide: ENTERPRISE_IDENTITY_REPOSITORY, useClass: InMemoryEnterpriseIdentityRepository };
    return {
      module: EnterpriseIdentityModule,
      controllers: [IdentityController, ScimController],
      providers: [
        repositoryProvider,
        { provide: SCIM_BEARER_TOKEN, useValue: options.scimBearerToken ?? null },
        ScimBearerGuard,
      ],
      exports: [ENTERPRISE_IDENTITY_REPOSITORY],
    };
  }
}
