import type { UserType } from '@/app/(auth)/auth';
import type { ChatModel } from './models';

interface Entitlements {
  maxMessagesPerDay: number;
  availableChatModelIds: Array<ChatModel['id']>;
}

export const entitlementsByUserType: Record<UserType, Entitlements> = {
  /*
   * For users without an account
   */
  guest: {
    maxMessagesPerDay: 20, // Increased for development
    availableChatModelIds: ['gpt-5-nano', 'gpt-5-mini', 'gpt-4o-mini-2024-07-18'],
  },

  /*
   * For users with an account
   */
  regular: {
    maxMessagesPerDay: 200, // Increased for development
    availableChatModelIds: ['gpt-5-nano', 'gpt-5-mini', 'berry-b1', 'chat-model-reasoning', 'gpt-5', 'gpt-4o-mini-2024-07-18'],
  },

  /*
   * TODO: For users with an account and a paid membership
   */
};
