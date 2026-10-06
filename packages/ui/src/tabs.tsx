import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from './utils.js';

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

/** Underlined tab strip. Arrow keys move between tabs. */
export function TabsList({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <TabsPrimitive.List className={cn('flex items-end gap-1 border-b border-line px-3', className)}>{children}</TabsPrimitive.List>;
}

export function TabsTrigger({
  value,
  children,
  badge
}: {
  value: string;
  children: React.ReactNode;
  badge?: React.ReactNode;
}): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="group relative -mb-px flex h-9 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-[12.5px] text-ink-muted transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink"
    >
      {children}
      {badge === undefined || badge === null ? null : (
        <span className="rounded bg-sunken px-1 font-mono text-[10px] text-ink-muted group-data-[state=active]:text-ink">{badge}</span>
      )}
    </TabsPrimitive.Trigger>
  );
}
