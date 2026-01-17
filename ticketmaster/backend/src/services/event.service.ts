import { query } from '../db/pool.js';
import redis from '../db/redis.js';
import type { Event, EventWithVenue, Venue, VenueSection } from '../types/index.js';

const CACHE_TTL = 300; // 5 minutes

export class EventService {
  async getEvents(options: {
    category?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ events: EventWithVenue[]; total: number }> {
    const { category, status, search, page = 1, limit = 10 } = options;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE 1=1';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (category) {
      whereClause += ` AND e.category = $${paramIndex++}`;
      params.push(category);
    }

    if (status) {
      whereClause += ` AND e.status = $${paramIndex++}`;
      params.push(status);
    }

    if (search) {
      whereClause += ` AND (e.name ILIKE $${paramIndex} OR e.artist ILIKE $${paramIndex} OR v.name ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Count query
    const countResult = await query(
      `SELECT COUNT(*) FROM events e JOIN venues v ON e.venue_id = v.id ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Data query
    params.push(limit, offset);
    const result = await query(
      `SELECT e.*,
              v.id as venue_id, v.name as venue_name, v.address as venue_address,
              v.city as venue_city, v.state as venue_state, v.country as venue_country,
              v.capacity as venue_capacity, v.image_url as venue_image_url
       FROM events e
       JOIN venues v ON e.venue_id = v.id
       ${whereClause}
       ORDER BY e.event_date ASC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      params
    );

    const events = result.rows.map((row) => this.mapEventWithVenue(row));
    return { events, total };
  }

  async getEventById(eventId: string): Promise<EventWithVenue | null> {
    // Try cache first
    const cacheKey = `event:${eventId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await query(
      `SELECT e.*,
              v.id as venue_id, v.name as venue_name, v.address as venue_address,
              v.city as venue_city, v.state as venue_state, v.country as venue_country,
              v.capacity as venue_capacity, v.image_url as venue_image_url
       FROM events e
       JOIN venues v ON e.venue_id = v.id
       WHERE e.id = $1`,
      [eventId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const event = this.mapEventWithVenue(result.rows[0]);

    // Cache the result
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(event));

    return event;
  }

  async getVenues(): Promise<Venue[]> {
    const result = await query('SELECT * FROM venues ORDER BY name');
    return result.rows;
  }

  async getVenueById(venueId: string): Promise<Venue | null> {
    const result = await query('SELECT * FROM venues WHERE id = $1', [venueId]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async getVenueSections(venueId: string): Promise<VenueSection[]> {
    const result = await query(
      'SELECT * FROM venue_sections WHERE venue_id = $1 ORDER BY position_y, position_x, name',
      [venueId]
    );
    return result.rows;
  }

  async generateEventSeats(eventId: string): Promise<number> {
    const result = await query('SELECT generate_event_seats($1)', [eventId]);

    // Update seat counts
    await query(`
      UPDATE events SET
        total_capacity = (SELECT COUNT(*) FROM event_seats WHERE event_id = events.id),
        available_seats = (SELECT COUNT(*) FROM event_seats WHERE event_id = events.id AND status = 'available')
      WHERE id = $1
    `, [eventId]);

    const countResult = await query(
      'SELECT COUNT(*) FROM event_seats WHERE event_id = $1',
      [eventId]
    );

    return parseInt(countResult.rows[0].count);
  }

  async updateEventStatus(eventId: string, status: Event['status']): Promise<void> {
    await query('UPDATE events SET status = $1, updated_at = NOW() WHERE id = $2', [
      status,
      eventId,
    ]);

    // Invalidate cache
    await redis.del(`event:${eventId}`);
  }

  async getUpcomingOnSales(): Promise<Event[]> {
    const result = await query(
      `SELECT * FROM events
       WHERE status = 'upcoming'
       AND on_sale_date <= NOW()
       ORDER BY on_sale_date`
    );
    return result.rows;
  }

  private mapEventWithVenue(row: Record<string, unknown>): EventWithVenue {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      venue_id: row.venue_id as string,
      artist: row.artist as string | null,
      category: row.category as Event['category'],
      event_date: new Date(row.event_date as string),
      on_sale_date: new Date(row.on_sale_date as string),
      status: row.status as Event['status'],
      total_capacity: row.total_capacity as number,
      available_seats: row.available_seats as number,
      image_url: row.image_url as string | null,
      waiting_room_enabled: row.waiting_room_enabled as boolean,
      max_concurrent_shoppers: row.max_concurrent_shoppers as number,
      max_tickets_per_user: row.max_tickets_per_user as number,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
      venue: {
        id: row.venue_id as string,
        name: row.venue_name as string,
        address: row.venue_address as string,
        city: row.venue_city as string,
        state: row.venue_state as string | null,
        country: row.venue_country as string,
        capacity: row.venue_capacity as number,
        image_url: row.venue_image_url as string | null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    };
  }
}

export const eventService = new EventService();
