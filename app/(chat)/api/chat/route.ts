import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage, getGroupConfig } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';
import type { VisibilityType } from '@/components/visibility-selector';

// Import new tools
import {
  webSearchTool,
  academicSearchTool,
  codeInterpreterTool,
  extremeSearchTool,
  datetimeTool,
} from '@/lib/tools';

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

export async function POST(request: Request) {
  const requestStartTime = Date.now();
  console.log('🚀 [CHAT API] Request started at:', new Date().toISOString());
  
  let requestBody: PostRequestBody;

  try {
    const parseStartTime = Date.now();
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
    console.log('⚡ [CHAT API] Request parsing took:', Date.now() - parseStartTime, 'ms');
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const {
      id,
      message,
      selectedChatModel,
      selectedVisibilityType,
      selectedSearchMode = 'chat',
    } = requestBody;

    const authStartTime = Date.now();
    const session = await auth();
    console.log('🔐 [CHAT API] Auth took:', Date.now() - authStartTime, 'ms');

    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCountStartTime = Date.now();
    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });
    console.log('📊 [CHAT API] Message count query took:', Date.now() - messageCountStartTime, 'ms');

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    const chatQueryStartTime = Date.now();
    const chat = await getChatById({ id });
    console.log('💬 [CHAT API] Chat query took:', Date.now() - chatQueryStartTime, 'ms');

    if (!chat) {
      const titleStartTime = Date.now();
      const title = await generateTitleFromUserMessage({
        message,
      });
      console.log('📝 [CHAT API] Title generation took:', Date.now() - titleStartTime, 'ms');

      const saveChatStartTime = Date.now();
      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
      console.log('💾 [CHAT API] Save chat took:', Date.now() - saveChatStartTime, 'ms');
    } else {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    const messagesQueryStartTime = Date.now();
    const messagesFromDb = await getMessagesByChatId({ id });
    const uiMessages = [...convertToUIMessages(messagesFromDb), message];
    console.log('📚 [CHAT API] Messages query took:', Date.now() - messagesQueryStartTime, 'ms');

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    const saveMessageStartTime = Date.now();
    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });
    console.log('💬 [CHAT API] Save message took:', Date.now() - saveMessageStartTime, 'ms');

    const streamSetupStartTime = Date.now();
    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });
    console.log('🌊 [CHAT API] Stream setup took:', Date.now() - streamSetupStartTime, 'ms');

    const groupConfigStartTime = Date.now();
    const groupConfig = await getGroupConfig(selectedSearchMode);
    console.log('⚙️ [CHAT API] Group config took:', Date.now() - groupConfigStartTime, 'ms');

    const streamCreateStartTime = Date.now();
    const stream = createUIMessageStream({
      execute: ({ writer: dataStream }) => {
        console.log('🎯 [CHAT API] Stream creation took:', Date.now() - streamCreateStartTime, 'ms');
        
        const toolsSetupStartTime = Date.now();
        // Define the complete tool set with proper typing
        const allTools = {
          getWeather,
          createDocument: createDocument({ session, dataStream }),
          updateDocument: updateDocument({ session, dataStream }),
          requestSuggestions: requestSuggestions({
            session,
            dataStream,
          }),
          webSearch: webSearchTool(dataStream),
          academicSearch: academicSearchTool,
          codeInterpreter: codeInterpreterTool,
          extremeSearch: extremeSearchTool(dataStream),
          datetime: datetimeTool,
        };
        console.log('🔧 [CHAT API] Tools setup took:', Date.now() - toolsSetupStartTime, 'ms');

        const streamTextStartTime = Date.now();
        console.log('🤖 [CHAT API] Starting AI model execution with:', selectedChatModel);
        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: systemPrompt({ selectedChatModel, requestHints }),
          messages: convertToModelMessages(uiMessages),
          stopWhen: stepCountIs(5),
          activeTools: groupConfig.tools as (keyof typeof allTools)[],
          experimental_transform: smoothStream({ chunking: 'word' }),
          tools: allTools,
          ...(selectedChatModel === 'berry-b1' && {
            providerOptions: {
              groq: {
                structuredOutputs: false,
                parallelToolCalls: true,
              },
            },
          }),
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-text',
          },
        });

        result.consumeStream();
        console.log('⚡ [CHAT API] StreamText setup took:', Date.now() - streamTextStartTime, 'ms');

        // Log Groq API response data when stream finishes
        if (selectedChatModel === 'berry-b1') {
          // Add logging for stream completion
          dataStream.merge(
            result.toUIMessageStream({
              sendReasoning: true,
            }).pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  // Log completion events
                  if (chunk.type === 'finish') {
                    console.log('✅ [CHAT API] Groq API Stream Complete:', {
                      model: selectedChatModel,
                      timestamp: new Date().toISOString(),
                      totalTime: Date.now() - requestStartTime,
                    });
                  }
                  controller.enqueue(chunk);
                },
              })
            )
          );
        } else {
          dataStream.merge(
            result.toUIMessageStream({
              sendReasoning: true,
            }).pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  // Log completion events for all models
                  if (chunk.type === 'finish') {
                    console.log('✅ [CHAT API] Stream Complete:', {
                      model: selectedChatModel,
                      timestamp: new Date().toISOString(),
                      totalTime: Date.now() - requestStartTime,
                    });
                  }
                  controller.enqueue(chunk);
                },
              })
            )
          );
        }
      },
      generateId: generateUUID,
      onFinish: async ({ messages }) => {
        const saveResponseStartTime = Date.now();
        await saveMessages({
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            parts: message.parts,
            createdAt: new Date(),
            attachments: [],
            chatId: id,
          })),
        });
        console.log('💾 [CHAT API] Save response messages took:', Date.now() - saveResponseStartTime, 'ms');
        console.log('🏁 [CHAT API] Total request time:', Date.now() - requestStartTime, 'ms');
      },
      onError: () => {
        console.log('❌ [CHAT API] Error occurred, total time:', Date.now() - requestStartTime, 'ms');
        return 'Oops, an error occurred!';
      },
    });

    const streamContextStartTime = Date.now();
    const streamContext = getStreamContext();
    console.log('🔗 [CHAT API] Stream context setup took:', Date.now() - streamContextStartTime, 'ms');

    const responseStartTime = Date.now();
    if (streamContext) {
      console.log('📡 [CHAT API] Using resumable stream context');
      const response = new Response(
        await streamContext.resumableStream(streamId, () =>
          stream.pipeThrough(new JsonToSseTransformStream()),
        ),
      );
      console.log('📤 [CHAT API] Response creation took:', Date.now() - responseStartTime, 'ms');
      return response;
    } else {
      console.log('📡 [CHAT API] Using regular stream');
      const response = new Response(stream.pipeThrough(new JsonToSseTransformStream()));
      console.log('📤 [CHAT API] Response creation took:', Date.now() - responseStartTime, 'ms');
      return response;
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    console.error('Unexpected error in chat route:', error);
    return new ChatSDKError('bad_request:api', 'Unexpected error in chat route').toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
