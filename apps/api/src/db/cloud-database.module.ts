import { Global, Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import { CLOUD_DATABASE_EXECUTOR, CloudDatabaseService, type SqlExecutor } from "./cloud-database.service.js";

export type CloudDatabaseModuleOptions =
  | { useValue: SqlExecutor }
  | Pick<FactoryProvider<SqlExecutor>, "inject" | "useFactory">;

@Global()
@Module({})
export class CloudDatabaseModule {
  static register(options: CloudDatabaseModuleOptions): DynamicModule {
    const executorProvider: Provider<SqlExecutor> =
      "useValue" in options
        ? { provide: CLOUD_DATABASE_EXECUTOR, useValue: options.useValue }
        : { provide: CLOUD_DATABASE_EXECUTOR, inject: options.inject ?? [], useFactory: options.useFactory };
    return {
      module: CloudDatabaseModule,
      providers: [executorProvider, CloudDatabaseService],
      exports: [CloudDatabaseService],
    };
  }
}
