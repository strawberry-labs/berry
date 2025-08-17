'use client';
import { useRouter } from 'next/navigation';
import { useWindowSize } from 'usehooks-ts';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

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
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallButton, setShowInstallButton] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    
    // Only show install button when browser provides the install prompt
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallButton(true);
    };

    window.addEventListener('beforeinstallprompt', handler);

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;

    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      
      if (outcome === 'accepted') {
        setDeferredPrompt(null);
        setShowInstallButton(false);
      }
    } catch (error) {
      console.error('Install prompt failed:', error);
    }
  };

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
        <div className="flex items-center gap-1 order-2 md:order-1 ml-auto md:ml-0">
          {/* PWA Install Button */}
          {showInstallButton && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  className="md:px-2 px-2 md:h-fit cursor-pointer border-none"
                  onClick={handleInstall}
                >
                  <Download size={16} />
                  <span className="sr-only">Install App</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Install App</TooltipContent>
            </Tooltip>
          )}
          
          {/* New Chat Button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className="md:px-2 px-2 md:h-fit cursor-pointer border-none"
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
        </div>
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
