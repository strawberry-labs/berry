import { Global, Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import { CLOUD_DATABASE_EXECUTOR, CLOUD_PLATFORM_DATABASE_EXECUTOR, CloudDatabaseService, type SqlExecutor } from "./cloud-database.service.js";

export type CloudDatabaseModuleOptions =
  | { useValue: SqlExecutor; privilegedUseValue?: SqlExecutor }
  | (Pick<FactoryProvider<SqlExecutor>, "inject" | "useFactory"> & { privilegedUseValue?: SqlExecutor });

@Global()
@Module({})
export class CloudDatabaseModule {
  static register(options: CloudDatabaseModuleOptions): DynamicModule {
    const executorProvider: Provider<SqlExecutor> =
      "useValue" in options
        ? { provide: CLOUD_DATABASE_EXECUTOR, useValue: options.useValue }
        : { provide: CLOUD_DATABASE_EXECUTOR, inject: options.inject ?? [], useFactory: options.useFactory };
    const providers: Provider[] = [executorProvider];
    if (options.privilegedUseValue) {
      providers.push({ provide: CLOUD_PLATFORM_DATABASE_EXECUTOR, useValue: options.privilegedUseValue });
    }
    return {
      module: CloudDatabaseModule,
      providers: [...providers, CloudDatabaseService],
      exports: [CloudDatabaseService],
    };
  }
}
