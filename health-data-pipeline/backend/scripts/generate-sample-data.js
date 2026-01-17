/**
 * Sample Data Generator for Health Data Pipeline
 *
 * This script generates realistic sample health data for testing.
 * Run after setting up a user and device.
 *
 * Usage:
 *   node scripts/generate-sample-data.js <userId> <deviceId> [days]
 *
 * Example:
 *   node scripts/generate-sample-data.js abc123 def456 30
 */

import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://health_user:health_password@localhost:5432/health_data'
});

// Generate random number within range
function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

// Generate random integer within range
function randomIntInRange(min, max) {
  return Math.floor(randomInRange(min, max));
}

// Generate step data for a day
function generateStepsForDay(date) {
  const samples = [];
  const totalSteps = randomIntInRange(3000, 15000);
  const hoursActive = randomIntInRange(8, 16);

  for (let hour = 7; hour < 7 + hoursActive && hour < 23; hour++) {
    const stepsThisHour = randomIntInRange(100, Math.floor(totalSteps / hoursActive * 2));
    const startDate = new Date(date);
    startDate.setHours(hour, randomIntInRange(0, 30), 0);
    const endDate = new Date(startDate);
    endDate.setMinutes(endDate.getMinutes() + randomIntInRange(30, 60));

    samples.push({
      type: 'STEPS',
      value: stepsThisHour,
      unit: 'count',
      startDate,
      endDate
    });
  }

  return samples;
}

// Generate heart rate data for a day
function generateHeartRateForDay(date) {
  const samples = [];
  const restingHR = randomIntInRange(55, 75);

  for (let hour = 0; hour < 24; hour++) {
    const numReadings = randomIntInRange(1, 4);
    for (let i = 0; i < numReadings; i++) {
      const isActive = hour >= 8 && hour <= 20 && Math.random() > 0.7;
      const heartRate = isActive
        ? randomIntInRange(90, 150)
        : randomIntInRange(restingHR - 5, restingHR + 15);

      const startDate = new Date(date);
      startDate.setHours(hour, randomIntInRange(0, 59), randomIntInRange(0, 59));

      samples.push({
        type: 'HEART_RATE',
        value: heartRate,
        unit: 'bpm',
        startDate,
        endDate: startDate
      });
    }
  }

  // Add resting heart rate
  const restingDate = new Date(date);
  restingDate.setHours(6, 30, 0);
  samples.push({
    type: 'RESTING_HEART_RATE',
    value: restingHR,
    unit: 'bpm',
    startDate: restingDate,
    endDate: restingDate
  });

  return samples;
}

// Generate sleep data for a night
function generateSleepForNight(date) {
  const samples = [];
  const sleepHours = randomInRange(5, 9);
  const sleepMinutes = Math.round(sleepHours * 60);

  const bedTime = new Date(date);
  bedTime.setDate(bedTime.getDate() - 1);
  bedTime.setHours(randomIntInRange(21, 24), randomIntInRange(0, 59), 0);

  const wakeTime = new Date(bedTime);
  wakeTime.setMinutes(wakeTime.getMinutes() + sleepMinutes);

  samples.push({
    type: 'SLEEP_ANALYSIS',
    value: sleepMinutes,
    unit: 'minutes',
    startDate: bedTime,
    endDate: wakeTime
  });

  return samples;
}

// Generate calories data for a day
function generateCaloriesForDay(date) {
  const samples = [];
  const totalCalories = randomIntInRange(200, 600);

  for (let hour = 7; hour < 22; hour++) {
    if (Math.random() > 0.6) {
      const calories = randomIntInRange(20, 100);
      const startDate = new Date(date);
      startDate.setHours(hour, 0, 0);
      const endDate = new Date(startDate);
      endDate.setMinutes(59);

      samples.push({
        type: 'ACTIVE_ENERGY',
        value: calories,
        unit: 'kcal',
        startDate,
        endDate
      });
    }
  }

  return samples;
}

// Generate weight data (once per week)
function generateWeightForDay(date, dayIndex) {
  if (dayIndex % 7 !== 0) return [];

  const baseWeight = 70 + Math.random() * 20;
  const variance = (Math.random() - 0.5) * 2;

  const measureTime = new Date(date);
  measureTime.setHours(7, randomIntInRange(0, 30), 0);

  return [{
    type: 'WEIGHT',
    value: Math.round((baseWeight + variance) * 10) / 10,
    unit: 'kg',
    startDate: measureTime,
    endDate: measureTime
  }];
}

async function generateData(userId, deviceId, days) {
  console.log(`Generating ${days} days of health data for user ${userId}...`);

  const allSamples = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);

    allSamples.push(...generateStepsForDay(date));
    allSamples.push(...generateHeartRateForDay(date));
    allSamples.push(...generateSleepForNight(date));
    allSamples.push(...generateCaloriesForDay(date));
    allSamples.push(...generateWeightForDay(date, i));
  }

  console.log(`Generated ${allSamples.length} samples. Inserting into database...`);

  // Batch insert
  const batchSize = 100;
  for (let i = 0; i < allSamples.length; i += batchSize) {
    const batch = allSamples.slice(i, i + batchSize);

    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const sample of batch) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      values.push(
        uuidv4(),
        userId,
        sample.type,
        sample.value,
        sample.unit,
        sample.startDate,
        sample.endDate,
        deviceId
      );
    }

    await pool.query(`
      INSERT INTO health_samples
        (id, user_id, type, value, unit, start_date, end_date, source_device_id)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `, values);

    process.stdout.write(`\rInserted ${Math.min(i + batchSize, allSamples.length)}/${allSamples.length} samples`);
  }

  console.log('\n\nData generation complete!');
  console.log('Now running aggregation...');

  // Trigger aggregation
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days);

  // Simple aggregation - in production this would be done by the service
  const types = ['STEPS', 'HEART_RATE', 'RESTING_HEART_RATE', 'SLEEP_ANALYSIS', 'ACTIVE_ENERGY', 'WEIGHT'];

  for (const type of types) {
    // Daily aggregation
    await pool.query(`
      INSERT INTO health_aggregates (user_id, type, period, period_start, value, min_value, max_value, sample_count)
      SELECT
        $1 as user_id,
        $2 as type,
        'day' as period,
        DATE_TRUNC('day', start_date) as period_start,
        CASE
          WHEN $2 IN ('STEPS', 'SLEEP_ANALYSIS', 'ACTIVE_ENERGY') THEN SUM(value)
          WHEN $2 = 'WEIGHT' THEN (ARRAY_AGG(value ORDER BY start_date DESC))[1]
          ELSE AVG(value)
        END as value,
        MIN(value) as min_value,
        MAX(value) as max_value,
        COUNT(*) as sample_count
      FROM health_samples
      WHERE user_id = $1 AND type = $2 AND start_date >= $3
      GROUP BY DATE_TRUNC('day', start_date)
      ON CONFLICT (user_id, type, period, period_start)
      DO UPDATE SET
        value = EXCLUDED.value,
        min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value,
        sample_count = EXCLUDED.sample_count,
        updated_at = NOW()
    `, [userId, type, startDate]);

    console.log(`Aggregated ${type}`);
  }

  console.log('\nAll done! Check the dashboard for your health data.');
}

// Main
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node scripts/generate-sample-data.js <userId> <deviceId> [days]');
  console.log('\nTo get userId and deviceId:');
  console.log('1. Register a user via the API or frontend');
  console.log('2. Add a device via the API or frontend');
  console.log('3. Query the database: SELECT id FROM users; SELECT id FROM user_devices;');
  process.exit(1);
}

const userId = args[0];
const deviceId = args[1];
const days = parseInt(args[2] || '30');

generateData(userId, deviceId, days)
  .then(() => {
    pool.end();
  })
  .catch(err => {
    console.error('Error:', err);
    pool.end();
    process.exit(1);
  });
