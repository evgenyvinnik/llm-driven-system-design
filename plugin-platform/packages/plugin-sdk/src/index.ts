// Plugin SDK Types and Utilities
// This package provides everything needed to build a plugin

export type SlotId = 'toolbar' | 'canvas' | 'sidebar' | 'statusbar' | 'modal';

export interface SlotContribution {
  slot: SlotId;
  component: string;
  order?: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  category?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  contributes: {
    slots?: SlotContribution[];
    commands?: { id: string; handler: string }[];
    settings?: { id: string; type: string; default: unknown; label?: string }[];
  };
  requires?: {
    events?: string[];
    state?: string[];
  };
}

export interface PluginContext {
  pluginId: string;
  events: {
    emit: (event: string, data?: unknown) => void;
    on: (event: string, handler: (data: unknown) => void) => () => void;
  };
  state: {
    get: <T>(key: string) => T | undefined;
    set: (key: string, value: unknown) => void;
    subscribe: (key: string, handler: (value: unknown) => void) => () => void;
  };
  storage: {
    get: <T>(key: string) => T | undefined;
    set: (key: string, value: unknown) => void;
  };
  commands: {
    register: (id: string, handler: () => void) => void;
    execute: (id: string) => void;
  };
}

export interface PluginProps {
  context: PluginContext;
}

// Standard events
export const EVENTS = {
  CONTENT_CHANGED: 'editor:content-changed',
  SELECTION_CHANGED: 'editor:selection-changed',
  FONT_CHANGED: 'format:font-changed',
  SIZE_CHANGED: 'format:size-changed',
  PAPER_CHANGED: 'theme:paper-changed',
  THEME_CHANGED: 'theme:mode-changed',
} as const;

// Standard state keys
export const STATE_KEYS = {
  CONTENT: 'editor.content',
  SELECTION: 'editor.selection',
  FONT_FAMILY: 'format.fontFamily',
  FONT_SIZE: 'format.fontSize',
  PAPER: 'theme.paper',
  THEME_MODE: 'theme.mode',
} as const;

// Hook for subscribing to state values (to be used with React)
import { useState, useEffect } from 'react';

export function useStateValue<T>(context: PluginContext, key: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(() => context.state.get<T>(key));

  useEffect(() => {
    return context.state.subscribe(key, (newValue) => {
      setValue(newValue as T);
    });
  }, [context, key]);

  return value;
}

// Plugin activation function type
export type ActivateFn = (context: PluginContext) => void | Promise<void>;
export type DeactivateFn = () => void | Promise<void>;

// Helper to define a plugin module
export interface PluginModule {
  manifest: PluginManifest;
  activate?: ActivateFn;
  deactivate?: DeactivateFn;
  [componentName: string]: unknown;
}

export function definePlugin(module: PluginModule): PluginModule {
  return module;
}
