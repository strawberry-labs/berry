'use client';

import { DefaultChatTransport } from 'ai';
import { useChat } from '@ai-sdk/react';
import { useEffect, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { ChatHeader } from '@/components/chat-header';
import type { Vote } from '@/lib/db/schema';
import { fetcher, fetchWithErrorHandlers, generateUUID } from '@/lib/utils';
import { Artifact } from './artifact';
import { MultimodalInput } from './multimodal-input';
import { Messages } from './messages';
import { Greeting } from './greeting';
import type { VisibilityType } from './visibility-selector';
import { useArtifactSelector } from '@/hooks/use-artifact';
import { unstable_serialize } from 'swr/infinite';
import { getChatHistoryPaginationKey } from './sidebar-history';
import { toast } from './toast';
import type { Session } from 'next-auth';
import { useSearchParams } from 'next/navigation';
import { useChatVisibility } from '@/hooks/use-chat-visibility';
import { useAutoResume } from '@/hooks/use-auto-resume';
import { ChatSDKError } from '@/lib/errors';
import type { Attachment, ChatMessage } from '@/lib/types';
import { useDataStream } from './data-stream-provider';
import type { SearchGroupId } from '@/lib/utils';
import { useWindowSize } from 'usehooks-ts';

export function Chat({
  id,
  initialMessages,
  initialChatModel,
  initialVisibilityType,
  isReadonly,
  session,
  autoResume,
}: {
  id: string;
  initialMessages: ChatMessage[];
  initialChatModel: string;
  initialVisibilityType: VisibilityType;
  isReadonly: boolean;
  session: Session;
  autoResume: boolean;
}) {
  const { visibilityType } = useChatVisibility({
    chatId: id,
    initialVisibilityType,
  });

  const { mutate } = useSWRConfig();
  const { setDataStream } = useDataStream();

  const [input, setInput] = useState<string>('');
  const [currentChatModel, setCurrentChatModel] = useState<string>(initialChatModel);
  const [selectedSearchMode, setSelectedSearchMode] = useState<SearchGroupId>('chat');

  const handleSearchModeChange = (mode: SearchGroupId) => {
    setSelectedSearchMode(mode);
  };

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    resumeStream,
  } = useChat<ChatMessage>({
    id,
    messages: initialMessages,
    experimental_throttle: 100,
    generateId: generateUUID,
    transport: new DefaultChatTransport({
      api: '/api/chat',
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest({ messages, id, body }) {
        return {
          body: {
            id,
            message: messages.at(-1),
            selectedChatModel: currentChatModel,
            selectedVisibilityType: visibilityType,
            selectedSearchMode,
            ...body,
          },
        };
      },
    }),
    onData: (dataPart) => {
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
    },
    onFinish: () => {
      mutate(unstable_serialize(getChatHistoryPaginationKey));
    },
    onError: (error) => {
      if (error instanceof ChatSDKError) {
        toast({
          type: 'error',
          description: error.message,
        });
      }
    },
  });

  const searchParams = useSearchParams();
  const query = searchParams.get('query');

  const [hasAppendedQuery, setHasAppendedQuery] = useState(false);

  useEffect(() => {
    if (query && !hasAppendedQuery) {
      // Handle query parameter logic here
      setHasAppendedQuery(true);
    }
  }, [query, hasAppendedQuery]);

  const { data: votes } = useSWR<Array<Vote>>(
    messages.length >= 2 ? `/api/vote?chatId=${id}` : null,
    fetcher,
  );

  const [attachments, setAttachments] = useState<Array<Attachment>>([]);
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);
  
  const [scrollData, setScrollData] = useState<{ isAtBottom: boolean; scrollToBottom: () => void } | null>(null);
  
  // Keyboard positioning state
  const { width } = useWindowSize();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useAutoResume({
    autoResume,
    initialMessages,
    resumeStream,
    setMessages,
  });

  // Keyboard detection for mobile devices
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const initialViewportHeight = window.innerHeight;
    
    const handleViewportChange = () => {
      const isMobile = width < 768;
      if (!isMobile) {
        setKeyboardHeight(0);
        setIsKeyboardVisible(false);
        return;
      }

      let currentViewportHeight = window.innerHeight;
      
      // Use visual viewport if available (better for iOS)
      if (window.visualViewport) {
        currentViewportHeight = window.visualViewport.height;
      }
      
      const heightDifference = initialViewportHeight - currentViewportHeight;
      
      // Keyboard is considered open if viewport height decreases by more than 150px
      if (heightDifference > 150) {
        setKeyboardHeight(heightDifference);
        setIsKeyboardVisible(true);
      } else {
        setKeyboardHeight(0);
        setIsKeyboardVisible(false);
      }
    };

    // Listen for viewport changes
    window.addEventListener('resize', handleViewportChange);
    
    // Also listen for visual viewport changes (better for iOS)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportChange);
    }

    // Initial check
    handleViewportChange();

    // Additional focus-based detection
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      const isMobile = width < 768;
      const isInputElement = target.tagName === 'INPUT' || 
                           target.tagName === 'TEXTAREA' || 
                           target.contentEditable === 'true';
      
      if (isMobile && isInputElement) {
        // Proactively set keyboard as visible
        setTimeout(() => {
          if (!isKeyboardVisible) {
            setKeyboardHeight(300);
            setIsKeyboardVisible(true);
          }
        }, 300); // Allow time for keyboard to appear
      }
    };

    const handleFocusOut = (event: FocusEvent) => {
      const isMobile = width < 768;
      if (isMobile) {
        setTimeout(() => {
          const activeElement = document.activeElement as HTMLElement;
          const isStillFocused = activeElement?.tagName === 'INPUT' || 
                               activeElement?.tagName === 'TEXTAREA' ||
                               activeElement?.contentEditable === 'true';
          
          if (!isStillFocused) {
            setIsKeyboardVisible(false);
            setKeyboardHeight(0);
          }
        }, 200);
      }
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportChange);
      }
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, [width, isKeyboardVisible]);

  return (
    <>
      <div className="flex flex-col min-w-0 h-dvh bg-background overflow-hidden">
        <ChatHeader
          chatId={id}
          selectedVisibilityType={initialVisibilityType}
          isReadonly={isReadonly}
        />

        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          {messages.length === 0 ? (
            // Empty chat state: center everything vertically with keyboard handling
            <div 
              className="flex flex-col items-center justify-center flex-1 gap-8 px-4 transition-transform duration-300 ease-in-out"
              style={{
                transform: isKeyboardVisible ? `translateY(-${keyboardHeight * 0.4}px)` : 'translateY(0)',
              }}
            >
              {/* Berry logo positioned above the centered chat input */}
              <div className="flex-shrink-0">
                <Greeting key="berry-greeting" />
              </div>
              
              {/* Centered input for new chat */}
              <div className="w-full max-w-3xl">
                <form className="flex mx-auto gap-2 w-full">
                  {!isReadonly && (
                    <MultimodalInput
                      chatId={id}
                      input={input}
                      setInput={setInput}
                      status={status}
                      stop={stop}
                      attachments={attachments}
                      setAttachments={setAttachments}
                      messages={messages}
                      setMessages={setMessages}
                      sendMessage={sendMessage}
                      selectedVisibilityType={visibilityType}
                      selectedModelId={currentChatModel}
                      session={session}
                      onModelChange={setCurrentChatModel}
                      scrollData={scrollData}
                      selectedSearchMode={selectedSearchMode}
                      onSearchModeChange={handleSearchModeChange}
                    />
                  )}
                </form>
              </div>
            </div>
          ) : (
            // Chat with messages: scrollable messages area + bottom input
            <>
              <Messages
                chatId={id}
                status={status}
                votes={votes}
                messages={messages}
                setMessages={setMessages}
                regenerate={regenerate}
                isReadonly={isReadonly}
                isArtifactVisible={isArtifactVisible}
                onScrollDataReady={setScrollData}
              />

              {/* Fixed input area at bottom when messages exist */}
              <div 
                className="flex-shrink-0 transition-transform duration-300 ease-in-out"
                style={{
                  transform: isKeyboardVisible ? `translateY(-8px)` : 'translateY(0)',
                  paddingBottom: isKeyboardVisible ? `${keyboardHeight}px` : '0px',
                }}
              >
                <form className="flex mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full md:max-w-3xl">
                  {!isReadonly && (
                    <MultimodalInput
                      chatId={id}
                      input={input}
                      setInput={setInput}
                      status={status}
                      stop={stop}
                      attachments={attachments}
                      setAttachments={setAttachments}
                      messages={messages}
                      setMessages={setMessages}
                      sendMessage={sendMessage}
                      selectedVisibilityType={visibilityType}
                      selectedModelId={currentChatModel}
                      session={session}
                      onModelChange={setCurrentChatModel}
                      scrollData={scrollData}
                      selectedSearchMode={selectedSearchMode}
                      onSearchModeChange={handleSearchModeChange}
                    />
                  )}
                </form>
              </div>
            </>
          )}
        </div>
      </div>

      <Artifact
        chatId={id}
        input={input}
        setInput={setInput}
        status={status}
        stop={stop}
        attachments={attachments}
        setAttachments={setAttachments}
        sendMessage={sendMessage}
        messages={messages}
        setMessages={setMessages}
        regenerate={regenerate}
        votes={votes}
        isReadonly={isReadonly}
        selectedVisibilityType={visibilityType}
        selectedSearchMode={selectedSearchMode}
        onSearchModeChange={handleSearchModeChange}
        session={session}
        selectedModelId={currentChatModel}
        onModelChange={setCurrentChatModel}
      />
    </>
  );
}
