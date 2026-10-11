/**
 * Reference-counted map from Redis pub/sub channels to local WebSocket clients.
 *
 * @module websocket/channelRegistry
 * @description One Redis subscriber connection per API process serves every
 * socket on that process. The first local listener on a channel triggers
 * SUBSCRIBE; the last one leaving triggers UNSUBSCRIBE. (Previously every
 * WebSocket opened its own Redis connection, so 10,000 tracking customers meant
 * 10,000 Redis connections per region.)
 */
export class ChannelRegistry<C> {
  private readonly listeners = new Map<string, Set<C>>();

  /**
   * @param subscribe - Called once when a channel gains its first listener
   * @param unsubscribe - Called once when a channel loses its last listener
   */
  constructor(
    private readonly subscribe: (channel: string) => Promise<unknown>,
    private readonly unsubscribe: (channel: string) => Promise<unknown>
  ) {}

  /**
   * Adds a listener; subscribes to Redis if it is the channel's first.
   */
  async add(channel: string, client: C): Promise<void> {
    const existing = this.listeners.get(channel);
    if (existing) {
      existing.add(client);
      return;
    }
    this.listeners.set(channel, new Set([client]));
    await this.subscribe(channel);
  }

  /**
   * Removes a listener; unsubscribes from Redis if it was the channel's last.
   */
  async remove(channel: string, client: C): Promise<void> {
    const existing = this.listeners.get(channel);
    if (!existing || !existing.delete(client)) return;
    if (existing.size === 0) {
      this.listeners.delete(channel);
      await this.unsubscribe(channel);
    }
  }

  /**
   * Removes a listener from every channel (socket closed).
   */
  async removeClient(client: C): Promise<void> {
    const channels = [...this.listeners.entries()]
      .filter(([, clients]) => clients.has(client))
      .map(([channel]) => channel);
    for (const channel of channels) {
      await this.remove(channel, client);
    }
  }

  /** Local listeners of a channel. */
  clientsOf(channel: string): C[] {
    return [...(this.listeners.get(channel) ?? [])];
  }

  /** Channels this process is subscribed to. */
  channelCount(): number {
    return this.listeners.size;
  }
}
