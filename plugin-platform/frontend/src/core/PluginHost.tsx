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

function registerSlotContribution(
  slot: SlotId,
  entry: SlotContributionEntry
): void {
  if (!slotContributions.has(slot)) {
    slotContributions.set(slot, []);
  }
  slotContributions.get(slot)!.push(entry);
  // Sort by order
  slotContributions.get(slot)!.sort((a, b) => a.order - b.order);
}

// Plugin Host Context
interface PluginHostContextValue {
  plugins: Map<string, LoadedPlugin>;
  getSlotContributions: (slot: SlotId) => SlotContributionEntry[];
  isLoading: boolean;
}

const PluginHostContext = createContext<PluginHostContextValue | null>(null);

export function usePluginHost(): PluginHostContextValue {
  const context = useContext(PluginHostContext);
  if (!context) {
    throw new Error('usePluginHost must be used within PluginHostProvider');
  }
  return context;
}

// Hook to get contributions for a specific slot
export function useSlotContributions(slot: SlotId): SlotContributionEntry[] {
  const { getSlotContributions } = usePluginHost();
  const [contributions, setContributions] = useState<SlotContributionEntry[]>([]);

  useEffect(() => {
    setContributions(getSlotContributions(slot));
  }, [slot, getSlotContributions]);

  return contributions;
}

// Hook to subscribe to state in plugins
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
