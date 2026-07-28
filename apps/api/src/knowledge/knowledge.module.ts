import { Global, Module } from "@nestjs/common";
import { durableContextConfigFromEnv } from "@berry/shared";
import { createApiEmbeddingProvider } from "./embedding-provider.js";
import { KnowledgeController } from "./knowledge.controller.js";
import { KNOWLEDGE_EMBEDDING_PROVIDER, KnowledgeService } from "./knowledge.service.js";

@Global()
@Module({
  controllers: [KnowledgeController],
  providers: [
    {
      provide: KNOWLEDGE_EMBEDDING_PROVIDER,
      useFactory: () => {
        const config = durableContextConfigFromEnv(process.env);
        return createApiEmbeddingProvider(process.env, {
          provider: config.embeddingProvider,
          model: config.embeddingModel,
          dimensions: config.embeddingDimensions,
          version: config.embeddingProfileVersion,
        });
      },
    },
    KnowledgeService,
  ],
  exports: [KnowledgeService, KNOWLEDGE_EMBEDDING_PROVIDER],
})
export class KnowledgeModule {}
