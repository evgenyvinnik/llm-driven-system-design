/**
 * In-process registry of live WebSocket connections on this server instance.
 *
 * WHY: delivery is addressed to devices, and one device can hold several
 * sockets at once (two browser tabs share a device ID). The previous
 * `userId -> Map<deviceId, ws>` shape kept only the newest socket per device,
 * and closing an older tab deleted the entry for the tab that was still open.
 * Keeping a set per device, and removing by socket identity, fixes both.
 *
 * The registry knows nothing about Redis or the database; cross-instance
 * routing happens through pub/sub, and every instance consults its own
 * registry to find the sockets it holds.
 */
export class ConnectionRegistry<S> {
  private byUser = new Map<string, Map<string, Set<S>>>();

  /** Registers a socket for a user's device. */
  add(userId: string, deviceId: string, socket: S): void {
    let devices = this.byUser.get(userId);
    if (!devices) {
      devices = new Map();
      this.byUser.set(userId, devices);
    }
    let sockets = devices.get(deviceId);
    if (!sockets) {
      sockets = new Set();
      devices.set(deviceId, sockets);
    }
    sockets.add(socket);
  }

  /**
   * Removes one socket. Other sockets of the same device stay registered.
   * Reports whether the device and the user have no sockets left here.
   */
  remove(userId: string, deviceId: string, socket: S): { deviceEmpty: boolean; userEmpty: boolean } {
    const devices = this.byUser.get(userId);
    const sockets = devices?.get(deviceId);
    if (!devices || !sockets) {
      return { deviceEmpty: true, userEmpty: !devices };
    }
    sockets.delete(socket);
    const deviceEmpty = sockets.size === 0;
    if (deviceEmpty) devices.delete(deviceId);
    const userEmpty = devices.size === 0;
    if (userEmpty) this.byUser.delete(userId);
    return { deviceEmpty, userEmpty };
  }

  /** All sockets held here for the given users, across all of their devices. */
  socketsForUsers(userIds: Iterable<string>): S[] {
    const result: S[] = [];
    for (const userId of new Set(userIds)) {
      const devices = this.byUser.get(userId);
      if (!devices) continue;
      for (const sockets of devices.values()) {
        result.push(...sockets);
      }
    }
    return result;
  }

  /** All sockets held here for one device. */
  socketsForDevice(userId: string, deviceId: string): S[] {
    return [...(this.byUser.get(userId)?.get(deviceId) ?? [])];
  }

  /** Total number of sockets held by this instance. */
  size(): number {
    let total = 0;
    for (const devices of this.byUser.values()) {
      for (const sockets of devices.values()) total += sockets.size;
    }
    return total;
  }
}
