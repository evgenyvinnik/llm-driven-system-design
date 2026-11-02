import type { ReactNode } from 'react';

interface EmptyPaneProps {
  title: string;
  body?: string;
  children?: ReactNode;
}

/** Centered message filling the main pane: empty states, not-found, access lost. */
export function EmptyPane({ title, body, children }: EmptyPaneProps) {
  return (
    <div className="flex-1 flex items-center justify-center bg-teams-bg p-8">
      <div className="max-w-md text-center">
        <p className="text-teams-text font-medium">{title}</p>
        {body && <p className="text-sm text-teams-secondary mt-1">{body}</p>}
        {children && <div className="mt-4">{children}</div>}
      </div>
    </div>
  );
}
