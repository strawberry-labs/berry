import type { UserRole, UserRoleWithGuest, UserType } from '@/app/(auth)/auth';
import type { ChatModel } from './models';

interface Entitlements {
  maxMessagesPerDay: number;
  availableChatModelIds: Array<ChatModel['id']>;
}


export const entitlementsByUserType: Record<UserRoleWithGuest, Entitlements> = {
  /*
   * For users without an account
   */
  guest: {
    maxMessagesPerDay: 1000, // Increased for development
    availableChatModelIds: ['chat-model', 'chat-model-reasoning', 'berry-b1'],
  },

  /*
   * For users with an account
   */
  user: {
    maxMessagesPerDay: 2000, // Increased for development
    availableChatModelIds: ['chat-model', 'chat-model-reasoning', 'berry-b1'],
  },

  admin: {
    maxMessagesPerDay: 2000, // Increased for development
    availableChatModelIds: ['chat-model', 'chat-model-reasoning', 'berry-b1'],
  },

  /*
   * TODO: For users with an account and a paid membership
   */
};
