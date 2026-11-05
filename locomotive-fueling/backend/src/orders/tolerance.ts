/**
 * Ticket vs telemetry tolerance: 5% of the ticket or 150 gal, whichever is
 * larger. Tank sensors are coarse; smaller differences are noise.
 * @module orders/tolerance
 */
export function withinTolerance(ticketGal: number, observedGal: number): boolean {
  return Math.abs(ticketGal - observedGal) <= Math.max(150, 0.05 * ticketGal)
}
