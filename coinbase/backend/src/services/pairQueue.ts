/**
 * Serializes commands per trading pair.
 *
 * Matching itself is synchronous, but placing an order is not: reservation,
 * insertion and settlement each await Postgres. Without a queue, a cancel or a
 * second order for the same pair can run between "the book consumed this
 * resting order" and "the fill committed", so the book and the database
 * disagree. Every command that touches a pair's book (place, cancel, stop
 * trigger, rebuild) runs through runExclusive(symbol), one at a time, in
 * arrival order. Different pairs still run concurrently.
 *
 * This is a per-process guarantee only. Several API instances would each own
 * an unrelated book, so production needs a single owner per pair (a
 * partitioned command log), not a bigger lock.
 */
const tails = new Map<string, Promise<void>>();

export function runExclusive<T>(key: string, command: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(() => command());
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

/** Number of pairs with a command queued or running. Exposed for tests. */
export function activeQueueCount(): number {
  return tails.size;
}
