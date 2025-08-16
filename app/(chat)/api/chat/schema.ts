import { z } from 'zod';

const textPartSchema = z.object({
  type: z.enum(['text']),
  text: z.string().min(1).max(2000),
});

const filePartSchema = z.object({
  type: z.enum(['file']),
  mediaType: z.enum(['image/jpeg', 'image/png']),
  name: z.string().min(1).max(100),
  url: z.string().url(),
});

const partSchema = z.union([textPartSchema, filePartSchema]);

export const postRequestBodySchema = z.object({
  id: z.string().uuid(),
  message: z.object({
    id: z.string().uuid(),
    role: z.enum(['user']),
    parts: z.array(partSchema),
  }),
  selectedChatModel: z.enum(['gpt-5-nano', 'gpt-5-mini', 'berry-b1', 'chat-model-reasoning', 'gpt-5', 'gpt-4o-mini-2024-07-18']),
  selectedVisibilityType: z.enum(['public', 'private']),
  selectedSearchMode: z.enum(['web', 'analysis', 'academic', 'extreme', 'chat']).optional(),
});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
