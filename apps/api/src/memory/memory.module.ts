import { Global, Module } from "@nestjs/common";
import { KnowledgeModule } from "../knowledge/knowledge.module.js";
import { ContextAssemblyService } from "./context-assembly.service.js";
import { MemoryController } from "./memory.controller.js";
import { SqlMemoryRepository } from "./memory.repository.js";
import {
  MEMORY_REPOSITORY,
  PERSONAL_MEMORY_PROVIDER,
  MemoryService,
  createConfiguredPersonalMemoryProvider,
} from "./memory.service.js";

@Global()
@Module({
  imports: [KnowledgeModule],
  controllers: [MemoryController],
  providers: [
    SqlMemoryRepository,
    { provide: MEMORY_REPOSITORY, useExisting: SqlMemoryRepository },
    { provide: PERSONAL_MEMORY_PROVIDER, useFactory: () => createConfiguredPersonalMemoryProvider(process.env) },
    MemoryService,
    ContextAssemblyService,
  ],
  exports: [MemoryService, ContextAssemblyService, MEMORY_REPOSITORY, PERSONAL_MEMORY_PROVIDER],
})
export class MemoryModule {}
