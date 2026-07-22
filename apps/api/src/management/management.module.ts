import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { ENTERPRISE_IDENTITY_REPOSITORY, InMemoryEnterpriseIdentityRepository, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import type { EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import { ManagementController } from "./management.controller.ts";
import { MANAGEMENT_SERVICE, ManagementService, InMemoryManagementRepository, type ManagementRepository } from "./management.service.ts";
import { PlatformController } from "./platform.controller.ts";
import { DenyPlatformAuthorizer, PLATFORM_AUTHORIZER, type PlatformAuthorizer } from "./platform-authorizer.ts";
import { InMemoryPlatformService, PLATFORM_SERVICE, type PlatformService } from "./platform.service.ts";

export type ManagementModuleOptions = { repository?: ManagementRepository; identity?: EnterpriseIdentityModuleOptions; platformAuthorizer?: PlatformAuthorizer; platformService?: PlatformService };

@Module({})
export class ManagementModule {
  static register(options: ManagementModuleOptions = {}): DynamicModule {
    const identityProvider: Provider<EnterpriseIdentityRepository> = options.identity?.repository
      ? "useValue" in options.identity.repository
        ? { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: options.identity.repository.useValue }
        : { provide: ENTERPRISE_IDENTITY_REPOSITORY, inject: options.identity.repository.inject ?? [], useFactory: options.identity.repository.useFactory }
      : { provide: ENTERPRISE_IDENTITY_REPOSITORY, useClass: InMemoryEnterpriseIdentityRepository };
    return {
      module: ManagementModule,
      controllers: [ManagementController, PlatformController],
      providers: [
        { provide: MANAGEMENT_SERVICE, useValue: new ManagementService(options.repository ?? new InMemoryManagementRepository()) },
        identityProvider,
        { provide: PLATFORM_AUTHORIZER, useValue: options.platformAuthorizer ?? new DenyPlatformAuthorizer() },
        { provide: PLATFORM_SERVICE, useValue: options.platformService ?? new InMemoryPlatformService() },
      ],
    };
  }
}
