import { useMemo } from 'react';
import { create } from 'zustand';
import type { DataSource, QueryResult } from '../types';
import { dataSourcesApi, queriesApi } from '../services/api';

interface DataState {
  // Data sources
  dataSources: DataSource[];
  dataSourcesLoading: boolean;

  // Query results: queryName -> QueryResult
  queryResults: Record<string, QueryResult>;
  queryLoading: Record<string, boolean>;

  // Component values: componentId -> value
  componentValues: Record<string, unknown>;

  // Actions
  loadDataSources: () => Promise<void>;
  addDataSource: (name: string, type: string, config: Record<string, unknown>) => Promise<DataSource>;
  removeDataSource: (id: string) => Promise<void>;
  testDataSource: (id: string) => Promise<{ success: boolean; error?: string }>;

  executeQuery: (queryName: string, dataSourceId: string, queryText: string, context?: Record<string, unknown>) => Promise<QueryResult>;
  setQueryResult: (queryName: string, result: QueryResult) => void;
  clearQueryResults: () => void;

  setComponentValue: (componentId: string, value: unknown) => void;

  // Build context for binding resolution
  getBindingContext: () => Record<string, unknown>;
}

/** Data state managing query results and data source connections for the app editor. */
export const useDataStore = create<DataState>((set, get) => ({
  dataSources: [],
  dataSourcesLoading: false,
  queryResults: {},
  queryLoading: {},
  componentValues: {},

  loadDataSources: async () => {
    set({ dataSourcesLoading: true });
    try {
      const { dataSources } = await dataSourcesApi.list();
      set({ dataSources, dataSourcesLoading: false });
    } catch (err) {
      console.error('Failed to load data sources:', err);
      set({ dataSourcesLoading: false });
    }
  },

  addDataSource: async (name, type, config) => {
    const { dataSource } = await dataSourcesApi.create(name, type, config);
    set((state) => ({ dataSources: [...state.dataSources, dataSource] }));
    return dataSource;
  },

  removeDataSource: async (id) => {
    await dataSourcesApi.delete(id);
    set((state) => ({
      dataSources: state.dataSources.filter((ds) => ds.id !== id),
    }));
  },

  testDataSource: async (id) => {
    return dataSourcesApi.test(id);
  },

  executeQuery: async (queryName, dataSourceId, queryText, context) => {
    set((state) => ({
      queryLoading: { ...state.queryLoading, [queryName]: true },
    }));

    try {
      const bindingContext = context || get().getBindingContext();
      const result = await queriesApi.execute(dataSourceId, queryText, bindingContext);

      set((state) => ({
        queryResults: { ...state.queryResults, [queryName]: result },
        queryLoading: { ...state.queryLoading, [queryName]: false },
      }));

      return result;
    } catch (err) {
      const errorResult: QueryResult = {
        rows: [],
        fields: [],
        rowCount: 0,
        error: err instanceof Error ? err.message : 'Query failed',
      };

      set((state) => ({
        queryResults: { ...state.queryResults, [queryName]: errorResult },
        queryLoading: { ...state.queryLoading, [queryName]: false },
      }));

      return errorResult;
    }
  },

  setQueryResult: (queryName, result) => {
    set((state) => ({
      queryResults: { ...state.queryResults, [queryName]: result },
    }));
  },

  clearQueryResults: () => {
    set({ queryResults: {}, queryLoading: {} });
  },

  setComponentValue: (componentId, value) => {
    set((state) => ({
      componentValues: { ...state.componentValues, [componentId]: value },
    }));
  },

  getBindingContext: () => {
    const { queryResults, componentValues } = get();

    const context: Record<string, unknown> = {};

    // Add query results: { query1: { data: [...], ... } }
    for (const [name, result] of Object.entries(queryResults)) {
      context[name] = {
        data: result.rows,
        fields: result.fields,
        rowCount: result.rowCount,
        error: result.error,
      };
    }

    // Add component values: { textInput1: { value: "..." } }
    for (const [id, value] of Object.entries(componentValues)) {
      context[id] = { value };
    }

    return context;
  },
}));

/**
 * Subscribes to the binding context and recomputes it when the underlying data changes.
 *
 * Widgets used to do `const getBindingContext = useDataStore(s => s.getBindingContext)`
 * and then call it during render. That looks equivalent and is not: Zustand
 * re-renders only when the *selected value* changes, and the selected value there
 * is a function whose reference is stable for the life of the store. So a widget
 * subscribed to nothing that ever changes — it computed the context once, on first
 * render, while `queryResults` was still empty, and never recomputed. The visible
 * symptom was a table that showed "No data" forever even though the query had
 * returned rows and the store held them.
 *
 * Selecting the state slices instead means the widget re-renders when they are
 * replaced, and the `useMemo` keeps the context object identity stable between
 * those updates — returning a freshly built object straight from a selector would
 * make the snapshot never compare equal and loop forever.
 */
export function useBindingContext(): Record<string, unknown> {
  const queryResults = useDataStore((s) => s.queryResults);
  const componentValues = useDataStore((s) => s.componentValues);
  const getBindingContext = useDataStore((s) => s.getBindingContext);
  return useMemo(
    () => getBindingContext(),
    [queryResults, componentValues, getBindingContext],
  );
}
