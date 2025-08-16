'use server';

import { generateText, type UIMessage } from 'ai';
import { cookies } from 'next/headers';
import {
  deleteMessagesByChatIdAfterTimestamp,
  getMessageById,
  updateChatVisiblityById,
} from '@/lib/db/queries';
import type { VisibilityType } from '@/components/visibility-selector';
import { myProvider } from '@/lib/ai/providers';
import { searchGroups, type SearchGroupId } from '@/lib/utils';

export async function saveChatModelAsCookie(model: string) {
  const cookieStore = await cookies();
  cookieStore.set('chat-model', model);
}

export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
  
  const { text: title } = await generateText({
    model: myProvider.languageModel('title-model'),
    system: `\n
    - you will generate a short title based on the first message a user begins a conversation with
    - ensure it is not more than 80 characters long
    - the title should be a summary of the user's message
    - do not use quotes or colons`,
    prompt: JSON.stringify(message),
  });

  return title;
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const [message] = await getMessageById({ id });

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  await updateChatVisiblityById({ chatId, visibility });
}

export async function getGroupConfig(groupId: SearchGroupId) {
  const group = searchGroups.find(g => g.id === groupId);
  const instructions = group?.description || 'You are a helpful AI assistant.';

  let activeTools: string[] = [];
  switch (groupId) {
    case 'web':
      activeTools = ['webSearch'];
      break;
    case 'academic':
      activeTools = ['academicSearch'];
      break;
    case 'analysis':
      activeTools = ['codeInterpreter', 'datetime'];
      break;
    case 'extreme':
      activeTools = ['extremeSearch'];
      break;
    case 'chat':
      activeTools = ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions', 'webSearch', 'datetime', 'extremeSearch', 'academicSearch', 'codeInterpreter'];
      break;
    default:
      activeTools = ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions', 'webSearch', 'datetime', 'extremeSearch', 'academicSearch', 'codeInterpreter']; // Fallback to chat tools with web search
  }

  return {
    tools: activeTools,
    instructions: instructions,
  };
}
