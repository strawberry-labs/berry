import { Global, Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  InMemoryEnterpriseIdentityRepository,
  type EnterpriseIdentityRepository,
} from "../identity/identity.repository.ts";
import type { EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import { AuditController } from "./audit.controller.ts";
import {
  AUDIT_EXPORT_DISPATCHER,
  AUDIT_SERVICE,
  AuditService,
  InMemoryAuditRepository,
  NoopAuditExportDispatcher,
  type AuditExportDispatcher,
  type AuditRepository,
} from "./audit.service.ts";

export type AuditRepositoryProvider =
  | { useValue: AuditRepository }
  | Pick<FactoryProvider<AuditRepository>, "inject" | "useFactory">;

export type AuditServiceProvider =
  | { useValue: AuditService }
  | Pick<FactoryProvider<AuditService>, "inject" | "useFactory">;

export type AuditExportDispatcherProvider =
  | { useValue: AuditExportDispatcher }
  | Pick<FactoryProvider<AuditExportDispatcher>, "inject" | "useFactory">;

export type AuditModuleOptions = {
  service?: AuditServiceProvider | undefined;
  repository?: AuditRepositoryProvider | undefined;
  dispatcher?: AuditExportDispatcherProvider | undefined;
  identity?: EnterpriseIdentityModuleOptions | undefined;
};

@Global()
@Module({})
export class AuditModule {
  static register(options: AuditModuleOptions = {}): DynamicModule {
    const repositoryProvider: Provider<AuditRepository> = options.repository
      ? "useValue" in options.repository
        ? { provide: AUDIT_REPOSITORY, useValue: options.repository.useValue }
        : { provide: AUDIT_REPOSITORY, inject: options.repository.inject ?? [], useFactory: options.repository.useFactory }
      : { provide: AUDIT_REPOSITORY, useClass: InMemoryAuditRepository };
    const dispatcherProvider: Provider<AuditExportDispatcher> = options.dispatcher
      ? "useValue" in options.dispatcher
        ? { provide: AUDIT_EXPORT_DISPATCHER, useValue: options.dispatcher.useValue }
        : { provide: AUDIT_EXPORT_DISPATCHER, inject: options.dispatcher.inject ?? [], useFactory: options.dispatcher.useFactory }
      : { provide: AUDIT_EXPORT_DISPATCHER, useClass: NoopAuditExportDispatcher };
    const serviceProvider: Provider<AuditService> = options.service
      ? "useValue" in options.service
        ? { provide: AUDIT_SERVICE, useValue: options.service.useValue }
        : { provide: AUDIT_SERVICE, inject: options.service.inject ?? [], useFactory: options.service.useFactory }
      : {
          provide: AUDIT_SERVICE,
          useFactory: (repository: AuditRepository, dispatcher: AuditExportDispatcher) => new AuditService(repository, dispatcher),
          inject: [AUDIT_REPOSITORY, AUDIT_EXPORT_DISPATCHER],
        };
    const identityProvider: Provider<EnterpriseIdentityRepository> = options.identity?.repository
      ? "useValue" in options.identity.repository
        ? { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: options.identity.repository.useValue }
        : { provide: ENTERPRISE_IDENTITY_REPOSITORY, inject: options.identity.repository.inject ?? [], useFactory: options.identity.repository.useFactory }
      : { provide: ENTERPRISE_IDENTITY_REPOSITORY, useClass: InMemoryEnterpriseIdentityRepository };

    return {
      module: AuditModule,
      controllers: [AuditController],
      providers: [repositoryProvider, dispatcherProvider, serviceProvider, identityProvider],
      exports: [AUDIT_SERVICE, AUDIT_REPOSITORY, AUDIT_EXPORT_DISPATCHER],
    };
  }
}

const AUDIT_REPOSITORY = Symbol("AUDIT_REPOSITORY");
