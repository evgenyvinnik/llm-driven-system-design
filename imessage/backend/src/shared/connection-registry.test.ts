import { describe, it, expect } from 'vitest';
import { ConnectionRegistry } from './connection-registry.js';

describe('ConnectionRegistry', () => {
  it('keeps every socket of a device and removes them one at a time', () => {
    const registry = new ConnectionRegistry<string>();
    registry.add('alice', 'laptop', 'tab-1');
    registry.add('alice', 'laptop', 'tab-2');

    // Closing the older tab must not drop the newer one
    expect(registry.remove('alice', 'laptop', 'tab-1')).toEqual({ deviceEmpty: false, userEmpty: false });
    expect(registry.socketsForDevice('alice', 'laptop')).toEqual(['tab-2']);

    expect(registry.remove('alice', 'laptop', 'tab-2')).toEqual({ deviceEmpty: true, userEmpty: true });
    expect(registry.size()).toBe(0);
  });

  it('reports a user as present while any of their devices is connected', () => {
    const registry = new ConnectionRegistry<string>();
    registry.add('alice', 'phone', 'p');
    registry.add('alice', 'laptop', 'l');

    expect(registry.remove('alice', 'phone', 'p')).toEqual({ deviceEmpty: true, userEmpty: false });
    expect(registry.socketsForUsers(['alice'])).toEqual(['l']);
  });

  it('collects sockets across users without duplicates', () => {
    const registry = new ConnectionRegistry<string>();
    registry.add('alice', 'phone', 'a1');
    registry.add('bob', 'phone', 'b1');
    registry.add('bob', 'ipad', 'b2');

    expect(registry.socketsForUsers(['bob', 'alice', 'bob', 'carol']).sort()).toEqual(['a1', 'b1', 'b2']);
    expect(registry.size()).toBe(3);
  });

  it('treats removing an unknown socket as a no-op', () => {
    const registry = new ConnectionRegistry<string>();
    expect(registry.remove('nobody', 'none', 'x')).toEqual({ deviceEmpty: true, userEmpty: true });
  });
});
