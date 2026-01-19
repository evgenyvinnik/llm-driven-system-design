import { query } from '../utils/db.js';

export interface Activity {
  id: string;
  user_id: string;
  type: string;
  name: string;
  distance: number;
  elevation_gain: number;
  [key: string]: unknown;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  criteria_type: string;
  criteria_value: number;
}

export interface AchievementWithProgress extends Achievement {
  earned: boolean;
  earned_at: Date | null;
}

/**
 * Check and award achievements for a user after an activity
 */
export async function checkAchievements(userId: string, activity: Activity): Promise<Achievement[]> {
  const newAchievements: Achievement[] = [];

  // Get all achievements user doesn't have yet
  const unearned = await query<Achievement>(
    `SELECT a.* FROM achievements a
     WHERE a.id NOT IN (SELECT achievement_id FROM user_achievements WHERE user_id = $1)`,
    [userId]
  );

  for (const achievement of unearned.rows) {
    let earned = false;

    switch (achievement.criteria_type) {
      case 'activity_count': {
        const countResult = await query<{ count: string }>(
          'SELECT COUNT(*) FROM activities WHERE user_id = $1',
          [userId]
        );
        earned = parseInt(countResult.rows[0].count) >= achievement.criteria_value;
        break;
      }

      case 'single_run_distance':
        if (activity.type === 'run') {
          earned = parseFloat(String(activity.distance)) >= achievement.criteria_value;
        }
        break;

      case 'single_ride_distance':
        if (activity.type === 'ride') {
          earned = parseFloat(String(activity.distance)) >= achievement.criteria_value;
        }
        break;

      case 'single_elevation':
        earned = parseFloat(String(activity.elevation_gain)) >= achievement.criteria_value;
        break;

      case 'segment_count': {
        const segmentResult = await query<{ count: string }>(
          'SELECT COUNT(DISTINCT segment_id) FROM segment_efforts WHERE user_id = $1',
          [userId]
        );
        earned = parseInt(segmentResult.rows[0].count) >= achievement.criteria_value;
        break;
      }

      case 'total_kudos': {
        const kudosResult = await query<{ count: string }>(
          `SELECT COUNT(*) FROM kudos k
           JOIN activities a ON k.activity_id = a.id
           WHERE a.user_id = $1`,
          [userId]
        );
        earned = parseInt(kudosResult.rows[0].count) >= achievement.criteria_value;
        break;
      }

      default:
        break;
    }

    if (earned) {
      await query(
        'INSERT INTO user_achievements (user_id, achievement_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, achievement.id]
      );
      newAchievements.push(achievement);
      console.log(`User ${userId} earned achievement: ${achievement.name}`);
    }
  }

  return newAchievements;
}

/**
 * Get all achievements with user's progress
 */
export async function getAchievementsWithProgress(userId: string): Promise<AchievementWithProgress[]> {
  const result = await query<AchievementWithProgress>(
    `SELECT a.*,
            ua.earned_at IS NOT NULL as earned,
            ua.earned_at
     FROM achievements a
     LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = $1
     ORDER BY ua.earned_at DESC NULLS LAST, a.name`,
    [userId]
  );

  return result.rows;
}
