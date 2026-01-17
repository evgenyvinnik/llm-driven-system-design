// Plugin system types

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
  contributes: {
    slots?: SlotContribution[];
    commands?: { id: string; handler: string }[];
    settings?: { id: string; type: string; default: unknown }[];
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

export interface SlotContributionEntry {
  pluginId: string;
  component: React.ComponentType<PluginProps>;
  order: number;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  context: PluginContext;
}

export interface PluginModule {
  activate?: (context: PluginContext) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
  [key: string]: unknown;
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
