import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import type { SessionHost } from "@berry/local-agent";

import { SESSION_HOST_DRIVER, SessionHostService } from "./session-host.service.ts";

export type SessionHostModuleOptions =
  | { useValue: SessionHost }
  | Pick<FactoryProvider<SessionHost>, "inject" | "useFactory">;

@Module({})
export class SessionHostModule {
  static register(options: SessionHostModuleOptions): DynamicModule {
    const driver: Provider = "useValue" in options
      ? { provide: SESSION_HOST_DRIVER, useValue: options.useValue }
      : { provide: SESSION_HOST_DRIVER, useFactory: options.useFactory, inject: options.inject ?? [] };
    return {
      module: SessionHostModule,
      providers: [driver, SessionHostService],
      exports: [SessionHostService],
    };
  }
}
