import React from 'react';
import { LoaderIcon, GlobeIcon } from './icons'; // Assuming icons are available

interface SearchingIndicatorProps {
  partType: string;
}

const getSearchDescription = (partType: string) => {
  switch (partType) {
    case 'tool-webSearch':
      return 'Searching the web...';
    case 'tool-academicSearch':
      return 'Searching academic papers...';
    case 'tool-extremeSearch':
      return 'Conducting deep research...';
    default:
      return 'Searching...';
  }
};

export const SearchingIndicator = ({ partType }: SearchingIndicatorProps) => {
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-background px-3 py-2 text-sm text-zinc-600 dark:text-zinc-400">
      <div className="animate-spin text-zinc-500">
        <LoaderIcon />
      </div>
      <div className="flex items-center gap-2">
        <GlobeIcon size={16} />
        <span>{getSearchDescription(partType)}</span>
      </div>
    </div>
  );
};