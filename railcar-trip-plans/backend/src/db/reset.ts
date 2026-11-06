/**
 * Clears the event log, every projection and every stream so the scenario can run again from scratch.
 * Reference data (network, cars, users) stays. Stop the services first.
 */
import { Redis } from 'ioredis'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'

const TABLES = [
  'event_cars', 'train_run_cars', 'plan_run_index', 'events', 'processed_events', 'consumer_checkpoints', 'trip_plans', 'trip_plan_versions',
  'plan_legs_current', 'car_state', 'car_eta', 'eta_history', 'exceptions', 'replan_sagas', 'notification_items', 'shipper_digest_state', 'digests',
  'car_last_notified', 'replay_runs', 'run_reservations', 'train_runs',
]

const redis = new Redis(config.redisUrl)
try {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
  await pool.query("DELETE FROM cars WHERE car_id LIKE 'LPSX%'")
  let cursor = '0'
  let deleted = 0
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${config.streams.prefix}:*`, 'COUNT', 500)
    cursor = next
    const doomed = keys.filter((k) => !k.startsWith(`${config.streams.prefix}:session:`))
    if (doomed.length) deleted += await redis.del(...doomed)
  } while (cursor !== '0')
  console.log(`Reset: truncated ${TABLES.length} tables, deleted ${deleted} Valkey keys`)
} finally {
  redis.disconnect()
  await pool.end()
}
