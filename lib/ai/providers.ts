import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from 'ai';
import { xai } from '@ai-sdk/xai';
import { groq } from '@ai-sdk/groq';
import { openai } from '@ai-sdk/openai';
import {
  artifactModel,
  chatModel,
  reasoningModel,
  titleModel,
} from './models.test';
import { isTestEnvironment } from '../constants';

export const myProvider = isTestEnvironment
  ? customProvider({
      languageModels: {
        'chat-model': chatModel,
        'chat-model-reasoning': reasoningModel,
        'title-model': titleModel,
        'artifact-model': artifactModel,
      },
    })
  : customProvider({
      languageModels: {
        'chat-model': xai('grok-2-vision-1212'),
        'chat-model-reasoning': wrapLanguageModel({
          model: xai('grok-3-mini-beta'),
          middleware: extractReasoningMiddleware({ tagName: 'think' }),
        }),
        'berry-b1': groq('openai/gpt-oss-120b'),
        'gpt-5-nano': wrapLanguageModel({
          model: openai('gpt-5-nano-2025-08-07'),
          middleware: extractReasoningMiddleware({ tagName: 'think' }),
        }),
        'gpt-5-mini': wrapLanguageModel({
          model: openai('gpt-5-mini-2025-08-07'),
          middleware: extractReasoningMiddleware({ tagName: 'think' }),
        }),
        'gpt-5': wrapLanguageModel({
          model: openai('gpt-5-2025-08-07'),
          middleware: extractReasoningMiddleware({ tagName: 'think' }),
        }),
        'gpt-4o-mini-2024-07-18': openai('gpt-4o-mini-2024-07-18'),
        'title-model': groq('llama-3.1-8b-instant'),
        
      },
      imageModels: {
        'small-model': xai.imageModel('grok-2-image'),
      },
    });
