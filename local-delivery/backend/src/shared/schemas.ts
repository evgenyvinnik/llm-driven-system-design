/**
 * Request schemas shared by HTTP routes and the WebSocket handler.
 *
 * @module shared/schemas
 */
import { z } from 'zod';

/**
 * A courier location ping. Coordinates must be real numbers in range; the old
 * `if (!lat || !lng)` check rejected the equator and the prime meridian and let
 * strings and out-of-range values through.
 */
export const locationUpdateSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  speed: z.number().finite().min(0).max(100).nullish(),
  heading: z.number().finite().min(0).max(360).nullish(),
});

export type LocationUpdate = z.infer<typeof locationUpdateSchema>;

/** Body of POST /api/v1/orders/:id/tip. */
export const tipSchema = z.object({
  tip: z.number().finite().min(0).max(500),
});
