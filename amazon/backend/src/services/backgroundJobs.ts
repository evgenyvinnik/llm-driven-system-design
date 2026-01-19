import { query, transaction } from './database.js';
import { setRecommendations } from './redis.js';

// Release expired cart reservations
async function releaseExpiredReservations() {
  try {
    // Find expired cart items
    const result = await query(
      `SELECT id, product_id, quantity FROM cart_items
       WHERE reserved_until IS NOT NULL AND reserved_until < NOW()`
    );

    if (result.rows.length === 0) return;

    console.log(`Releasing ${result.rows.length} expired reservations`);

    for (const item of result.rows) {
      await transaction(async (client) => {
        // Release the reserved inventory
        await client.query(
          `UPDATE inventory SET reserved = GREATEST(0, reserved - $1)
           WHERE product_id = $2`,
          [item.quantity, item.product_id]
        );

        // Remove the cart item
        await client.query('DELETE FROM cart_items WHERE id = $1', [item.id]);
      });
    }

    console.log('Expired reservations released');
  } catch (error) {
    console.error('Error releasing expired reservations:', error);
  }
}

// Update product recommendations based on co-purchase data
async function updateRecommendations() {
  try {
    console.log('Updating product recommendations...');

    // Get all products that have been ordered
    const products = await query(
      `SELECT DISTINCT product_id FROM order_items`
    );

    for (const { product_id } of products.rows) {
      // Find products frequently bought together
      const result = await query(
        `SELECT oi2.product_id, COUNT(*) as frequency
         FROM order_items oi1
         JOIN order_items oi2 ON oi1.order_id = oi2.order_id
         WHERE oi1.product_id = $1
           AND oi2.product_id != $1
         GROUP BY oi2.product_id
         ORDER BY frequency DESC
         LIMIT 10`,
        [product_id]
      );

      if (result.rows.length > 0) {
        // Cache in Redis
        await setRecommendations(product_id, result.rows);

        // Also store in database for persistence
        for (const rec of result.rows) {
          await query(
            `INSERT INTO product_recommendations (product_id, recommended_product_id, score, recommendation_type, updated_at)
             VALUES ($1, $2, $3, 'also_bought', NOW())
             ON CONFLICT (product_id, recommended_product_id, recommendation_type)
             DO UPDATE SET score = $3, updated_at = NOW()`,
            [product_id, rec.product_id, rec.frequency / 100]
          );
        }
      }
    }

    console.log('Recommendations updated');
  } catch (error) {
    console.error('Error updating recommendations:', error);
  }
}

// Update product ratings from reviews
async function updateProductRatings() {
  try {
    await query(
      `UPDATE products p
       SET rating = subq.avg_rating,
           review_count = subq.count,
           updated_at = NOW()
       FROM (
         SELECT product_id,
                ROUND(AVG(rating)::numeric, 1) as avg_rating,
                COUNT(*) as count
         FROM reviews
         GROUP BY product_id
       ) subq
       WHERE p.id = subq.product_id
         AND (p.rating != subq.avg_rating OR p.review_count != subq.count)`
    );
  } catch (error) {
    console.error('Error updating product ratings:', error);
  }
}

export function startBackgroundJobs() {
  // Release expired reservations every minute
  setInterval(releaseExpiredReservations, 60 * 1000);

  // Update recommendations every hour
  setInterval(updateRecommendations, 60 * 60 * 1000);

  // Update product ratings every 5 minutes
  setInterval(updateProductRatings, 5 * 60 * 1000);

  // Run immediately on startup
  releaseExpiredReservations();
  updateProductRatings();

  console.log('Background jobs started');
}
