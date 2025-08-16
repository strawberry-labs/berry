import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { searchGroups, type SearchGroupId } from '@/lib/utils';
import { Zap } from 'lucide-react';

interface SearchModeSelectorProps {
  selectedMode: SearchGroupId;
  onModeChange: (mode: SearchGroupId) => void;
  className?: string;
}

export function SearchModeSelector({
  selectedMode,
  onModeChange,
  className = '',
}: SearchModeSelectorProps) {
  const selectedGroup = searchGroups.find(group => group.id === selectedMode);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Select value={selectedMode} onValueChange={onModeChange}>
        <SelectTrigger className="w-fit h-8 text-xs border border-input bg-background hover:bg-accent hover:text-accent-foreground max-w-[100px] md:max-w-none min-w-[80px]">
          <SelectValue>
            <span className="truncate">{selectedGroup?.name || 'Chat'}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {searchGroups.map((group) => (
            <SelectItem key={group.id} value={group.id}>
              <div className="flex flex-col gap-1">
                <div className="font-medium">{group.name}</div>
                <div className="text-xs text-muted-foreground">{group.description}</div>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
} 