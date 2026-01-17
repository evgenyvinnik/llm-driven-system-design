type StateSubscriber = (value: unknown) => void;

/**
 * Shared reactive state manager.
 * Plugins can read/write state and subscribe to changes.
 */
export class StateManager {
  private state: Map<string, unknown> = new Map();
  private subscribers: Map<string, Set<StateSubscriber>> = new Map();

  /**
   * Get a state value.
   */
  get<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  /**
   * Set a state value and notify subscribers.
   */
  set(key: string, value: unknown): void {
    const oldValue = this.state.get(key);
    if (oldValue !== value) {
      this.state.set(key, value);
      this.notifySubscribers(key, value);
    }
  }

  /**
   * Subscribe to state changes for a key.
   * Handler is called immediately with current value if it exists.
   * Returns an unsubscribe function.
   */
  subscribe(key: string, handler: StateSubscriber): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(handler);

    // Immediately call with current value
    if (this.state.has(key)) {
      handler(this.state.get(key));
    }

    return () => {
      this.subscribers.get(key)?.delete(handler);
    };
  }

  private notifySubscribers(key: string, value: unknown): void {
    const handlers = this.subscribers.get(key);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(value);
        } catch (error) {
          console.error(`[StateManager] Error in subscriber for "${key}":`, error);
        }
      });
    }
  }

  /**
   * Get all current state (for debugging).
   */
  getAll(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.state.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
}

// Singleton instance
export const stateManager = new StateManager();
