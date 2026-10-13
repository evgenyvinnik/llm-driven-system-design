import { describe, it, expect, vi } from 'vitest';
import { ChannelRegistry } from './channelRegistry.js';

function setup() {
  const subscribe = vi.fn().mockResolvedValue(1);
  const unsubscribe = vi.fn().mockResolvedValue(1);
  return { registry: new ChannelRegistry<string>(subscribe, unsubscribe), subscribe, unsubscribe };
}

describe('ChannelRegistry', () => {
  it('subscribes to Redis once per channel, however many sockets listen', async () => {
    const { registry, subscribe } = setup();
    await registry.add('order:1:status', 'socket-a');
    await registry.add('order:1:status', 'socket-b');

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(registry.clientsOf('order:1:status')).toEqual(['socket-a', 'socket-b']);
  });

  it('unsubscribes only when the last listener leaves', async () => {
    const { registry, unsubscribe } = setup();
    await registry.add('order:1:status', 'socket-a');
    await registry.add('order:1:status', 'socket-b');

    await registry.remove('order:1:status', 'socket-a');
    expect(unsubscribe).not.toHaveBeenCalled();

    await registry.remove('order:1:status', 'socket-b');
    expect(unsubscribe).toHaveBeenCalledWith('order:1:status');
    expect(registry.channelCount()).toBe(0);
  });

  it('removes a closed socket from every channel', async () => {
    const { registry, unsubscribe } = setup();
    await registry.add('order:1:status', 'socket-a');
    await registry.add('driver:9:location', 'socket-a');
    await registry.add('driver:9:location', 'socket-b');

    await registry.removeClient('socket-a');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(registry.clientsOf('driver:9:location')).toEqual(['socket-b']);
  });

  it('ignores removing a listener that was never added', async () => {
    const { registry, unsubscribe } = setup();
    await registry.remove('order:1:status', 'nobody');
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
