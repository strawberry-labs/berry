import { Module, type DynamicModule } from "@nestjs/common";
import { SetupController } from "./setup.controller.ts";
import { SetupService } from "./setup.service.ts";
import { SETUP_SERVICE } from "./setup.tokens.ts";

@Module({})
export class SetupModule {
  static register(service: SetupService): DynamicModule {
    return {
      module: SetupModule,
      controllers: [SetupController],
      providers: [{ provide: SETUP_SERVICE, useValue: service }],
    };
  }
}
