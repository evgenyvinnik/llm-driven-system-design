const db = require('../models/db');

class ReviewService {
  async createReview(reviewData, userId) {
    const { bookingId, rating, title, content } = reviewData;

    // Verify the booking belongs to the user and is completed/confirmed
    const bookingResult = await db.query(
      `SELECT hotel_id FROM bookings
       WHERE id = $1 AND user_id = $2 AND status IN ('confirmed', 'completed')`,
      [bookingId, userId]
    );

    if (bookingResult.rows.length === 0) {
      throw new Error('Booking not found or not eligible for review');
    }

    const hotelId = bookingResult.rows[0].hotel_id;

    // Check if review already exists
    const existingResult = await db.query(
      'SELECT id FROM reviews WHERE booking_id = $1',
      [bookingId]
    );

    if (existingResult.rows.length > 0) {
      throw new Error('Review already submitted for this booking');
    }

    const result = await db.query(
      `INSERT INTO reviews (booking_id, user_id, hotel_id, rating, title, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [bookingId, userId, hotelId, rating, title, content]
    );

    return this.formatReview(result.rows[0]);
  }

  async getReviewsByHotel(hotelId, page = 1, limit = 10) {
    const offset = (page - 1) * limit;

    const result = await db.query(
      `SELECT r.*, u.first_name, u.last_name
       FROM reviews r
       JOIN users u ON r.user_id = u.id
       WHERE r.hotel_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [hotelId, limit, offset]
    );

    const countResult = await db.query(
      'SELECT COUNT(*) as total FROM reviews WHERE hotel_id = $1',
      [hotelId]
    );

    const total = parseInt(countResult.rows[0].total);

    return {
      reviews: result.rows.map((row) => ({
        ...this.formatReview(row),
        authorFirstName: row.first_name,
        authorLastName: row.last_name,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getReviewStats(hotelId) {
    const result = await db.query(
      `SELECT
         COUNT(*) as total_reviews,
         AVG(rating) as avg_rating,
         COUNT(*) FILTER (WHERE rating = 5) as five_star,
         COUNT(*) FILTER (WHERE rating = 4) as four_star,
         COUNT(*) FILTER (WHERE rating = 3) as three_star,
         COUNT(*) FILTER (WHERE rating = 2) as two_star,
         COUNT(*) FILTER (WHERE rating = 1) as one_star
       FROM reviews
       WHERE hotel_id = $1`,
      [hotelId]
    );

    const row = result.rows[0];
    return {
      totalReviews: parseInt(row.total_reviews) || 0,
      avgRating: parseFloat(row.avg_rating) || 0,
      distribution: {
        5: parseInt(row.five_star) || 0,
        4: parseInt(row.four_star) || 0,
        3: parseInt(row.three_star) || 0,
        2: parseInt(row.two_star) || 0,
        1: parseInt(row.one_star) || 0,
      },
    };
  }

  formatReview(row) {
    return {
      id: row.id,
      bookingId: row.booking_id,
      userId: row.user_id,
      hotelId: row.hotel_id,
      rating: row.rating,
      title: row.title,
      content: row.content,
      createdAt: row.created_at,
    };
  }
}

module.exports = new ReviewService();
