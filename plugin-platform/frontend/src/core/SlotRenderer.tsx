import React from 'react';
import { useSlotContributions, usePluginHost } from './PluginHost';
import type { SlotId } from './types';

interface SlotProps {
  id: SlotId;
  className?: string;
}

/**
 * Renders all plugin contributions for a specific slot.
 * Each contribution is rendered in order specified by the plugin manifest.
 */
export function Slot({ id, className = '' }: SlotProps): React.ReactElement {
  const contributions = useSlotContributions(id);
  const { plugins } = usePluginHost();

  // Get layout class based on slot type
  const layoutClass = getLayoutClass(id);

  return (
    <div className={`slot slot-${id} ${layoutClass} ${className}`}>
      {contributions.map((contrib) => {
        const plugin = plugins.get(contrib.pluginId);
        if (!plugin) return null;

        const Component = contrib.component;
        return (
          <Component
            key={`${contrib.pluginId}-${id}`}
            context={plugin.context}
          />
        );
      })}
    </div>
  );
}

function getLayoutClass(slot: SlotId): string {
  switch (slot) {
    case 'toolbar':
      return 'flex flex-row items-center gap-2 flex-wrap';
    case 'canvas':
      return 'relative flex-1';
    case 'sidebar':
      return 'flex flex-col gap-2';
    case 'statusbar':
      return 'flex flex-row items-center gap-4';
    case 'modal':
      return 'fixed inset-0 flex items-center justify-center';
    default:
      return '';
  }
}
