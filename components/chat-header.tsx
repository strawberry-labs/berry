'use client';
import { useRouter } from 'next/navigation';
import { useWindowSize } from 'usehooks-ts';
import { useEffect, useState } from 'react';


import { SidebarToggle } from '@/components/sidebar-toggle';
import { Button } from '@/components/ui/button';
import { PlusIcon, } from './icons';
import { useSidebar } from './ui/sidebar';
import { memo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { type VisibilityType, VisibilitySelector } from './visibility-selector';


function PureChatHeader({
  chatId,
  selectedVisibilityType,
  isReadonly,
}: {
  chatId: string;
  selectedVisibilityType: VisibilityType;
  isReadonly: boolean;
}) {
  const router = useRouter();
  const { open } = useSidebar();

  const { width: windowWidth } = useWindowSize();
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  return (
    <header className="flex sticky top-0 bg-background py-2 items-center px-2 md:px-2 gap-2 border-b border-border/25 border-t-0">
      <div className="flex items-center gap-2">
        <SidebarToggle />
        {/* Show Berry text on mobile when sidebar is closed */}
        {isMounted && windowWidth < 768 && !open && (
          <span className="text-lg font-medium text-white">Berry</span>
        )}
      </div>

      {isMounted && (!open || windowWidth < 768) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              className="order-2 md:order-1 md:px-2 px-2 md:h-fit ml-auto md:ml-0 cursor-pointer border-none"
              onClick={() => {
                router.push('/');
                router.refresh();
              }}
            >
              <PlusIcon />
              <span className="sr-only">New Chat</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>New Chat</TooltipContent>
        </Tooltip>
      )}



      {isMounted && !isReadonly && (
        <VisibilitySelector
          chatId={chatId}
          selectedVisibilityType={selectedVisibilityType}
          className="order-1 md:order-3"
        />
      )}
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader, (prevProps, nextProps) => {
  return prevProps.selectedVisibilityType === nextProps.selectedVisibilityType;
});
