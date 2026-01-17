import { db } from '../config/database.js';
import { cache } from '../config/redis.js';

export class InsightsService {
  async analyzeUser(userId) {
    const insights = [];

    // Heart rate trends
    const hrInsight = await this.analyzeHeartRate(userId);
    if (hrInsight) insights.push(hrInsight);

    // Sleep patterns
    const sleepInsight = await this.analyzeSleep(userId);
    if (sleepInsight) insights.push(sleepInsight);

    // Activity trends
    const activityInsight = await this.analyzeActivity(userId);
    if (activityInsight) insights.push(activityInsight);

    // Weight trends
    const weightInsight = await this.analyzeWeight(userId);
    if (weightInsight) insights.push(weightInsight);

    // Store insights
    for (const insight of insights) {
      await this.storeInsight(userId, insight);
    }

    return insights;
  }

  async analyzeHeartRate(userId) {
    const data = await db.query(
      `SELECT period_start, value
       FROM health_aggregates
       WHERE user_id = $1
         AND type = 'RESTING_HEART_RATE'
         AND period = 'day'
         AND period_start >= NOW() - INTERVAL '30 days'
       ORDER BY period_start`,
      [userId]
    );

    if (data.rows.length < 7) {
      return null;
    }

    const values = data.rows.map(r => r.value);
    const trend = this.calculateTrend(values);

    if (Math.abs(trend.slope) > 0.5) {
      return {
        type: 'HEART_RATE_TREND',
        severity: Math.abs(trend.slope) > 1 ? 'high' : 'medium',
        direction: trend.slope > 0 ? 'increasing' : 'decreasing',
        message: trend.slope > 0
          ? 'Your resting heart rate has been increasing over the past month'
          : 'Your resting heart rate has been decreasing over the past month',
        recommendation: trend.slope > 0
          ? 'Consider consulting with a healthcare provider if this trend continues'
          : 'Great progress! Your cardiovascular health may be improving',
        data: {
          startValue: values[0],
          endValue: values[values.length - 1],
          change: values[values.length - 1] - values[0],
          slope: trend.slope
        }
      };
    }

    return null;
  }

  async analyzeSleep(userId) {
    const data = await db.query(
      `SELECT period_start, value
       FROM health_aggregates
       WHERE user_id = $1
         AND type = 'SLEEP_ANALYSIS'
         AND period = 'day'
         AND period_start >= NOW() - INTERVAL '14 days'
       ORDER BY period_start`,
      [userId]
    );

    if (data.rows.length < 7) return null;

    const avgSleep = data.rows.reduce((a, b) => a + b.value, 0) / data.rows.length;
    const avgHours = avgSleep / 60;

    if (avgHours < 6) {
      return {
        type: 'SLEEP_DEFICIT',
        severity: avgHours < 5 ? 'high' : 'medium',
        direction: null,
        message: `You've been averaging ${avgHours.toFixed(1)} hours of sleep over the past 2 weeks`,
        recommendation: 'Adults should aim for 7-9 hours of sleep per night for optimal health',
        data: { averageHours: avgHours, averageMinutes: avgSleep }
      };
    } else if (avgHours >= 7 && avgHours <= 9) {
      return {
        type: 'SLEEP_OPTIMAL',
        severity: 'positive',
        direction: null,
        message: `Great sleep habits! You're averaging ${avgHours.toFixed(1)} hours per night`,
        recommendation: 'Keep maintaining your current sleep schedule',
        data: { averageHours: avgHours, averageMinutes: avgSleep }
      };
    }

    return null;
  }

  async analyzeActivity(userId) {
    const thisWeek = await db.query(
      `SELECT COALESCE(SUM(value), 0) as total
       FROM health_aggregates
       WHERE user_id = $1
         AND type = 'STEPS'
         AND period = 'day'
         AND period_start >= DATE_TRUNC('week', NOW())`,
      [userId]
    );

    const lastMonth = await db.query(
      `SELECT COALESCE(AVG(weekly_total), 0) as avg
       FROM (
         SELECT DATE_TRUNC('week', period_start) as week, SUM(value) as weekly_total
         FROM health_aggregates
         WHERE user_id = $1
           AND type = 'STEPS'
           AND period = 'day'
           AND period_start >= NOW() - INTERVAL '4 weeks'
           AND period_start < DATE_TRUNC('week', NOW())
         GROUP BY week
       ) weekly`,
      [userId]
    );

    const currentTotal = parseFloat(thisWeek.rows[0].total);
    const monthlyAvg = parseFloat(lastMonth.rows[0].avg);

    if (monthlyAvg > 0) {
      const percentChange = ((currentTotal - monthlyAvg) / monthlyAvg) * 100;

      if (Math.abs(percentChange) > 20) {
        return {
          type: 'ACTIVITY_CHANGE',
          severity: percentChange > 0 ? 'positive' : 'medium',
          direction: percentChange > 0 ? 'increased' : 'decreased',
          message: percentChange > 0
            ? `Great job! You're ${percentChange.toFixed(0)}% more active this week`
            : `Your activity is down ${Math.abs(percentChange).toFixed(0)}% this week`,
          recommendation: percentChange > 0
            ? 'Keep up the great work!'
            : 'Try to incorporate more movement into your daily routine',
          data: { currentWeek: currentTotal, monthlyAverage: monthlyAvg, percentChange }
        };
      }
    }

    return null;
  }

  async analyzeWeight(userId) {
    const data = await db.query(
      `SELECT period_start, value
       FROM health_aggregates
       WHERE user_id = $1
         AND type = 'WEIGHT'
         AND period = 'day'
         AND period_start >= NOW() - INTERVAL '30 days'
       ORDER BY period_start`,
      [userId]
    );

    if (data.rows.length < 3) return null;

    const values = data.rows.map(r => r.value);
    const firstValue = values[0];
    const lastValue = values[values.length - 1];
    const change = lastValue - firstValue;
    const percentChange = (change / firstValue) * 100;

    if (Math.abs(percentChange) > 3) {
      return {
        type: 'WEIGHT_CHANGE',
        severity: Math.abs(percentChange) > 5 ? 'high' : 'medium',
        direction: change > 0 ? 'increased' : 'decreased',
        message: `Your weight has ${change > 0 ? 'increased' : 'decreased'} by ${Math.abs(change).toFixed(1)} kg over the past month`,
        recommendation: 'Track your diet and exercise to understand this change',
        data: { startWeight: firstValue, currentWeight: lastValue, change, percentChange }
      };
    }

    return null;
  }

  calculateTrend(values) {
    const n = values.length;
    if (n < 2) return { slope: 0, intercept: values[0] || 0 };

    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((sum, val, i) => sum + i * val, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    return { slope, intercept };
  }

  async storeInsight(userId, insight) {
    // Check for duplicate recent insight
    const existing = await db.query(
      `SELECT id FROM health_insights
       WHERE user_id = $1
         AND type = $2
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [userId, insight.type]
    );

    if (existing.rows.length > 0) {
      // Update existing insight
      await db.query(
        `UPDATE health_insights
         SET message = $1, data = $2, severity = $3, direction = $4, recommendation = $5
         WHERE id = $6`,
        [insight.message, JSON.stringify(insight.data), insight.severity, insight.direction, insight.recommendation, existing.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO health_insights (user_id, type, severity, direction, message, recommendation, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, insight.type, insight.severity, insight.direction, insight.message, insight.recommendation, JSON.stringify(insight.data)]
      );
    }
  }

  async getUserInsights(userId, options = {}) {
    const { limit = 10, unreadOnly = false } = options;

    let query = `
      SELECT * FROM health_insights
      WHERE user_id = $1
    `;
    const params = [userId];

    if (unreadOnly) {
      query += ` AND acknowledged = false`;
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await db.query(query, params);
    return result.rows;
  }

  async acknowledgeInsight(userId, insightId) {
    await db.query(
      `UPDATE health_insights
       SET acknowledged = true
       WHERE id = $1 AND user_id = $2`,
      [insightId, userId]
    );
  }
}

export const insightsService = new InsightsService();
