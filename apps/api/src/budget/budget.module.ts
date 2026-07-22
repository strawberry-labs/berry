import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  InMemoryEnterpriseIdentityRepository,
  type EnterpriseIdentityRepository,
} from "../identity/identity.repository.ts";
import type { EnterpriseIdentityModuleOptions } from "../identity/identity.module.ts";
import {
  BUDGET_SERVICE,
  BudgetService,
  InMemoryBudgetHotCounters,
  InMemoryBudgetRepository,
  type BudgetHotCounters,
  type BudgetRepository,
} from "./budget.service.ts";
import { BudgetController } from "./budget.controller.ts";
import { AllowanceController } from "./allowance.controller.ts";
import { ALLOWANCE_SERVICE, AllowanceService, InMemoryAllowanceRepository, type AllowanceRepository } from "./allowance.service.ts";

export type BudgetServiceProvider =
  | { useValue: BudgetService }
  | Pick<FactoryProvider<BudgetService>, "inject" | "useFactory">;

export type BudgetModuleOptions = {
  service?: BudgetServiceProvider | undefined;
  repository?: BudgetRepository | undefined;
  hotCounters?: BudgetHotCounters | undefined;
  enabled?: boolean | undefined;
  failClosed?: boolean | undefined;
  identity?: EnterpriseIdentityModuleOptions | undefined;
  allowanceRepository?: AllowanceRepository | undefined;
};

@Module({})
export class BudgetModule {
  static register(options: BudgetModuleOptions = {}): DynamicModule {
    const serviceProvider: Provider<BudgetService> = options.service
      ? "useValue" in options.service
        ? { provide: BUDGET_SERVICE, useValue: options.service.useValue }
        : { provide: BUDGET_SERVICE, inject: options.service.inject ?? [], useFactory: options.service.useFactory }
      : {
          provide: BUDGET_SERVICE,
          useFactory: () => new BudgetService({
            repository: options.repository ?? new InMemoryBudgetRepository(),
            hotCounters: options.hotCounters ?? new InMemoryBudgetHotCounters(),
            enabled: options.enabled ?? false,
            failClosed: options.failClosed,
          }),
        };
    const identityProvider: Provider<EnterpriseIdentityRepository> = options.identity?.repository
      ? "useValue" in options.identity.repository
        ? { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: options.identity.repository.useValue }
        : { provide: ENTERPRISE_IDENTITY_REPOSITORY, inject: options.identity.repository.inject ?? [], useFactory: options.identity.repository.useFactory }
      : { provide: ENTERPRISE_IDENTITY_REPOSITORY, useClass: InMemoryEnterpriseIdentityRepository };

    return {
      module: BudgetModule,
      controllers: [BudgetController, AllowanceController],
      providers: [serviceProvider, identityProvider, { provide: ALLOWANCE_SERVICE, inject: [BUDGET_SERVICE], useFactory: (budgets: BudgetService) => new AllowanceService(options.allowanceRepository ?? new InMemoryAllowanceRepository(), budgets) }],
      exports: [BUDGET_SERVICE],
    };
  }
}
