'use client';

import { createHighlighter, bundledLanguages, bundledThemes } from 'shiki';
import React, { memo, useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useTheme } from 'next-themes';

interface AsyncCodeBlockProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  className?: string;
}

const AsyncCodeBlock = memo(({ code, language, showLineNumbers = false, className }: AsyncCodeBlockProps) => {
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCopied, setIsCopied] = useState(false);
  const { resolvedTheme } = useTheme();
  
  const theme = useMemo(() => 
    resolvedTheme === 'dark' ? 'github-dark' : 'github-light', 
    [resolvedTheme]
  );

  useEffect(() => {
    let isCancelled = false;
    
    const highlightCode = async () => {
      // Don't show loading state for very short code to prevent flashing
      const shouldShowLoading = code.length > 50;
      
      try {
        if (shouldShowLoading) {
          setIsLoading(true);
        }
        
        // Check if language is supported
        const supportedLang = language in bundledLanguages ? language : 'javascript';
        
        const highlighter = await createHighlighter({
          themes: [theme],
          langs: [supportedLang],
        });
        
        if (isCancelled) return;
        
        const html = highlighter.codeToHtml(code, {
          lang: supportedLang,
          theme: theme,
          transformers: showLineNumbers ? [
            {
              pre(node) {
                node.properties['data-line-numbers'] = '';
              }
            }
          ] : undefined
        });
        
        setHighlightedCode(html);
      } catch (error) {
        console.warn('Syntax highlighting failed:', error);
        // Fallback to plain text
        setHighlightedCode(`<pre class="shiki"><code>${code}</code></pre>`);
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    // Add a small delay to prevent rapid re-highlighting during streaming
    const timeoutId = setTimeout(highlightCode, 100);
    
    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
    };
  }, [code, language, theme, showLineNumbers]);

  const copyToClipboard = async () => {
    if (typeof window === 'undefined' || !navigator.clipboard.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(code);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy code to clipboard:', error);
    }
  };

  const IconComponent = isCopied ? CheckIcon : CopyIcon;

  if (isLoading || !highlightedCode) {
    // Render unstyled code immediately to prevent layout shifts
    return (
      <div className={cn(
        'relative w-full max-w-3xl overflow-hidden rounded-md border bg-background text-foreground',
        className
      )}>
        <div className="absolute top-2 right-2 z-10">
          <Button
            className="shrink-0"
            onClick={copyToClipboard}
            size="icon"
            variant="ghost"
          >
            <IconComponent size={14} />
          </Button>
        </div>
        <div className="overflow-x-hidden p-4">
          <pre className="text-sm font-mono whitespace-pre-wrap break-words break-all">
            <code>{code}</code>
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      'relative w-full max-w-3xl overflow-hidden rounded-md border bg-background text-foreground',
      className
    )}>
      <div className="absolute top-2 right-2 z-10">
        <Button
          className="shrink-0"
          onClick={copyToClipboard}
          size="icon"
          variant="ghost"
        >
          <IconComponent size={14} />
        </Button>
      </div>
      <div 
        className="overflow-x-hidden [&>pre]:!bg-transparent [&>pre]:!p-4 [&>pre]:!m-0 [&>pre]:whitespace-pre-wrap [&>pre]:break-words [&>pre]:break-all"
        dangerouslySetInnerHTML={{ __html: highlightedCode || '' }} 
      />
    </div>
  );
});

AsyncCodeBlock.displayName = 'AsyncCodeBlock';

// Custom comparison function to prevent unnecessary re-renders during streaming
const areEqual = (prevProps: AsyncCodeBlockProps, nextProps: AsyncCodeBlockProps) => {
  return (
    prevProps.code === nextProps.code &&
    prevProps.language === nextProps.language &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.className === nextProps.className
  );
};

const StableAsyncCodeBlock = memo(AsyncCodeBlock, areEqual);

export { StableAsyncCodeBlock as AsyncCodeBlock };