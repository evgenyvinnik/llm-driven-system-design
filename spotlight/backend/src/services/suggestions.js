import { pool } from '../index.js';

// Get Siri-style suggestions based on usage patterns
export async function getSuggestions(context = {}) {
  const { hour = new Date().getHours(), dayOfWeek = new Date().getDay() } = context;
  const suggestions = [];

  // Time-based app suggestions
  const timeBasedApps = await getTimeBasedApps(hour, dayOfWeek);
  suggestions.push(...timeBasedApps);

  // Recent activity
  const recentItems = await getRecentActivity();
  suggestions.push(...recentItems);

  // Frequently used contacts
  const frequentContacts = await getFrequentContacts();
  suggestions.push(...frequentContacts);

  // Sort by score and return top suggestions
  suggestions.sort((a, b) => b.score - a.score);
  return suggestions.slice(0, 8);
}

// Get apps typically used at this time
async function getTimeBasedApps(hour, dayOfWeek) {
  try {
    const result = await pool.query(`
      SELECT
        a.bundle_id,
        a.name,
        a.path,
        a.category,
        p.count,
        p.last_used
      FROM applications a
      JOIN app_usage_patterns p ON a.bundle_id = p.bundle_id
      WHERE p.hour = $1 AND p.day_of_week = $2
      ORDER BY p.count DESC
      LIMIT 4
    `, [hour, dayOfWeek]);

    return result.rows.map(row => ({
      type: 'app_suggestion',
      name: row.name,
      bundleId: row.bundle_id,
      path: row.path,
      reason: 'Based on your routine',
      icon: 'clock',
      score: Math.min(100, row.count * 10)
    }));
  } catch {
    return [];
  }
}

// Get recent activity items
async function getRecentActivity() {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (item_id)
        type,
        item_id,
        item_name,
        metadata,
        created_at
      FROM recent_activity
      ORDER BY item_id, created_at DESC
      LIMIT 5
    `);

    return result.rows.map((row, index) => ({
      type: `${row.type}_suggestion`,
      name: row.item_name,
      itemId: row.item_id,
      metadata: row.metadata,
      reason: 'Recently accessed',
      icon: getIconForType(row.type),
      score: 50 - index * 5
    }));
  } catch {
    return [];
  }
}

// Get frequently contacted people
async function getFrequentContacts() {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.email,
        c.phone,
        COUNT(ra.id) as contact_count
      FROM contacts c
      LEFT JOIN recent_activity ra ON ra.item_id = c.id::text AND ra.type = 'contact'
      GROUP BY c.id
      ORDER BY contact_count DESC
      LIMIT 4
    `);

    return result.rows.map(row => ({
      type: 'contact_suggestion',
      name: row.name,
      email: row.email,
      phone: row.phone,
      reason: 'Frequently contacted',
      icon: 'user',
      score: Math.min(80, row.contact_count * 5 + 20)
    }));
  } catch {
    return [];
  }
}

function getIconForType(type) {
  const icons = {
    file: 'document',
    app: 'squares-2x2',
    contact: 'user',
    url: 'globe'
  };
  return icons[type] || 'document';
}

// Record app launch for pattern learning
export async function recordAppLaunch(bundleId) {
  const hour = new Date().getHours();
  const dayOfWeek = new Date().getDay();

  try {
    await pool.query(`
      INSERT INTO app_usage_patterns (bundle_id, hour, day_of_week, count, last_used)
      VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (bundle_id, hour, day_of_week)
      DO UPDATE SET count = app_usage_patterns.count + 1, last_used = NOW()
    `, [bundleId, hour, dayOfWeek]);

    // Also record in recent activity
    const app = await pool.query('SELECT name FROM applications WHERE bundle_id = $1', [bundleId]);
    if (app.rows.length > 0) {
      await recordActivity('app', bundleId, app.rows[0].name);
    }
  } catch (error) {
    console.error('Failed to record app launch:', error);
  }
}

// Record activity for recent items
export async function recordActivity(type, itemId, itemName, metadata = {}) {
  try {
    await pool.query(`
      INSERT INTO recent_activity (type, item_id, item_name, metadata)
      VALUES ($1, $2, $3, $4)
    `, [type, itemId, itemName, JSON.stringify(metadata)]);

    // Clean up old activity (keep last 100 items)
    await pool.query(`
      DELETE FROM recent_activity
      WHERE id NOT IN (
        SELECT id FROM recent_activity
        ORDER BY created_at DESC
        LIMIT 100
      )
    `);
  } catch (error) {
    console.error('Failed to record activity:', error);
  }
}
