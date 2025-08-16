export const DEFAULT_CHAT_MODEL: string = 'chat-model';

export interface ChatModel {
  id: string;
  name: string;
  description: string;
}

export const chatModels: Array<ChatModel> = [
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 nano',
    description: 'Fastest and most efficient GPT-5 model',
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    description: 'Balanced performance and efficiency GPT-5 model',
  },
  {
    id: 'berry-b1',
    name: 'Berry B1',
    description: 'Advanced reasoning model by Strawberry Labs',
  },
  {
    id: 'chat-model-reasoning',
    name: 'Grok 3',
    description: 'Uses advanced reasoning with chain-of-thought',
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    description: 'Most advanced GPT-5 model with superior capabilities',
  },
];
