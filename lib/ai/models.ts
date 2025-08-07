export const DEFAULT_CHAT_MODEL: string = 'chat-model';

export interface ChatModel {
  id: string;
  name: string;
  description: string;
}

export const chatModels: Array<ChatModel> = [
  {
    id: 'chat-model',
    name: 'Grok 2 Vision',
    description: 'Primary model for all-purpose chat with vision capabilities',
  },
  {
    id: 'chat-model-reasoning',
    name: 'Grok 3 Mini',
    description: 'Uses advanced reasoning with chain-of-thought',
  },
  {
    id: 'grok-3-mini',
    name: 'Grok 3 Mini',
    description: 'Fast and efficient reasoning model',
  },
];
