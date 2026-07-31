import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { eventBus } from './EventBus';
import { stateManager } from './StateManager';
import type {
  PluginManifest,
  PluginContext,
  PluginModule,
  LoadedPlugin,
  SlotContributionEntry,
  SlotId,
  PluginProps,
} from './types';

// Storage helper using localStorage
function createStorage(pluginId: string) {
  const prefix = `plugin:${pluginId}:`;
  return {
    get: <T,>(key: string): T | undefined => {
      const item = localStorage.getItem(prefix + key);
      if (item === null) return undefined;
      try {
        return JSON.parse(item) as T;
      } catch {
        return item as unknown as T;
      }
    },
    set: (key: string, value: unknown): void => {
      localStorage.setItem(prefix + key, JSON.stringify(value));
    },
  };
}

// Command registry
const commandRegistry = new Map<string, () => void>();

// Create a context for a specific plugin
function createPluginContext(pluginId: string): PluginContext {
  return {
    pluginId,
    events: {
      emit: (event, data) => eventBus.emit(event, data),
      on: (event, handler) => eventBus.on(event, handler),
    },
    state: {
      get: <T,>(key: string) => stateManager.get<T>(key),
      set: (key, value) => stateManager.set(key, value),
      subscribe: (key, handler) => stateManager.subscribe(key, handler),
    },
    storage: createStorage(pluginId),
    commands: {
      register: (id, handler) => commandRegistry.set(`${pluginId}.${id}`, handler),
      execute: (id) => {
        const handler = commandRegistry.get(id) || commandRegistry.get(`${pluginId}.${id}`);
        if (handler) handler();
        else console.warn(`[PluginHost] Command not found: ${id}`);
      },
    },
  };
}

// Slot contributions store
const slotContributions = new Map<SlotId, SlotContributionEntry[]>();

/**
 * Registers a plugin's contribution into a slot.
 *
 * Registration must be **idempotent**. `slotContributions` is module-level
 * state, while the loader that fills it runs inside a `useEffect` with no
 * cleanup — so React StrictMode's deliberate double-invoke in development ran
 * the whole load pass twice and pushed every contribution a second time. The
 * visible result was a duplicated UI: two font pickers, two size pickers, two
 * theme toggles, and a status bar reading "0 words | 0 characters | 1 lines"
 * twice over. `loadedPlugins` is a Map keyed by plugin id so it deduped itself;
 * this array did not.
 *
 * A plugin contributing the same component to the same slot twice is always a
 * re-registration, never two legitimate entries, so replacing on match is both
 * safe and what the caller means.
 */
function registerSlotContribution(
  slot: SlotId,
  entry: SlotContributionEntry
): void {
  if (!slotContributions.has(slot)) {
    slotContributions.set(slot, []);
  }
  const entries = slotContributions.get(slot)!;
  const existing = entries.findIndex(
    (e) => e.pluginId === entry.pluginId && e.component === entry.component
  );
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  // Sort by order
  entries.sort((a, b) => a.order - b.order);
}

// Plugin Host Context
interface PluginHostContextValue {
  plugins: Map<string, LoadedPlugin>;
  getSlotContributions: (slot: SlotId) => SlotContributionEntry[];
  isLoading: boolean;
}

const PluginHostContext = createContext<PluginHostContextValue | null>(null);

/** Returns the plugin host context containing loaded plugins and slot contributions. */
export function usePluginHost(): PluginHostContextValue {
  const context = useContext(PluginHostContext);
  if (!context) {
    throw new Error('usePluginHost must be used within PluginHostProvider');
  }
  return context;
}

/** Returns the list of plugin contributions registered for a specific slot. */
export function useSlotContributions(slot: SlotId): SlotContributionEntry[] {
  const { getSlotContributions } = usePluginHost();
  const [contributions, setContributions] = useState<SlotContributionEntry[]>([]);

  useEffect(() => {
    setContributions(getSlotContributions(slot));
  }, [slot, getSlotContributions]);

  return contributions;
}

/** Subscribes to shared state changes and returns the current value for a key. */
export function useStateValue<T>(context: PluginContext, key: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(() => context.state.get<T>(key));

  useEffect(() => {
    return context.state.subscribe(key, (newValue) => {
      setValue(newValue as T);
    });
  }, [context, key]);

  return value;
}

interface PluginHostProviderProps {
  plugins: Array<{ manifest: PluginManifest; module: PluginModule }>;
  children: ReactNode;
}

/** Provides the plugin host context, loading and activating all registered plugins. */
export function PluginHostProvider({ plugins, children }: PluginHostProviderProps): React.ReactElement {
  const [loadedPlugins] = useState<Map<string, LoadedPlugin>>(() => new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [, forceUpdate] = useState({});

  useEffect(() => {
    async function loadPlugins() {
      for (const { manifest, module } of plugins) {
        try {
          // Create context for this plugin
          const context = createPluginContext(manifest.id);

          // Call activate if it exists
          if (module.activate) {
            await module.activate(context);
          }

          // Register slot contributions
          for (const slot of manifest.contributes.slots || []) {
            const component = module[slot.component] as React.ComponentType<PluginProps>;
            if (component) {
              registerSlotContribution(slot.slot, {
                pluginId: manifest.id,
                component,
                order: slot.order ?? 100,
              });
            }
          }

          // Store loaded plugin
          loadedPlugins.set(manifest.id, { manifest, module, context });
        } catch (error) {
          console.error(`[PluginHost] Failed to load plugin "${manifest.id}":`, error);
        }
      }

      setIsLoading(false);
      forceUpdate({});
    }

    loadPlugins();
  }, [plugins, loadedPlugins]);

  const getSlotContributions = useCallback((slot: SlotId): SlotContributionEntry[] => {
    return slotContributions.get(slot) || [];
  }, []);

  const contextValue: PluginHostContextValue = {
    plugins: loadedPlugins,
    getSlotContributions,
    isLoading,
  };

  return (
    <PluginHostContext.Provider value={contextValue}>
      {children}
    </PluginHostContext.Provider>
  );
}
