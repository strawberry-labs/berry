import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { BerryAuthController } from "./auth.controller.ts";
import { BerryAuthGuard } from "./auth.guard.ts";
import {
  BERRY_AUTH_RUNTIME,
  BerryAuthService,
  createBerryAuthRuntime,
  type BerryAuthRuntime,
} from "./auth-runtime.ts";

export type BerryAuthProvider = { useValue: BerryAuthRuntime } | Pick<FactoryProvider<BerryAuthRuntime>, "inject" | "useFactory">;

export type BerryAuthModuleOptions = {
  runtime?: BerryAuthProvider;
};

@Module({})
export class BerryAuthModule {
  static register(options: BerryAuthModuleOptions = {}): DynamicModule {
    const runtimeProvider: Provider<BerryAuthRuntime> = options.runtime
      ? "useValue" in options.runtime
        ? { provide: BERRY_AUTH_RUNTIME, useValue: options.runtime.useValue }
        : { provide: BERRY_AUTH_RUNTIME, inject: options.runtime.inject ?? [], useFactory: options.runtime.useFactory }
      : { provide: BERRY_AUTH_RUNTIME, useFactory: () => createBerryAuthRuntime() };

    return {
      module: BerryAuthModule,
      controllers: [BerryAuthController],
      providers: [
        Reflector,
        runtimeProvider,
        BerryAuthService,
        {
          provide: APP_GUARD,
          useClass: BerryAuthGuard,
        },
      ],
      exports: [BERRY_AUTH_RUNTIME, BerryAuthService],
    };
  }
}
