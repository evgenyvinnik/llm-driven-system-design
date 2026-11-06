/**
 * npm run replay -- analytics            rebuild the projection from position 0, then verify it
 * npm run replay -- analytics --verify   only verify: re-fold the applied events and diff with the live tables
 */
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'
import { rebuildAnalytics, verifyAnalytics } from './rebuild.js'

const [projection = 'analytics', ...flags] = process.argv.slice(2).filter((a) => a !== '--')

async function main(): Promise<void> {
  if (projection !== 'analytics') {
    console.error(`Unknown projection "${projection}". Available: analytics`)
    process.exitCode = 1
    return
  }
  const verifyOnly = flags.includes('--verify')
  const result = verifyOnly ? await verifyAnalytics() : await rebuildAnalytics()
  console.log(`${verifyOnly ? 'Verified' : 'Rebuilt'} projection "${projection}" from position 0 in ${result.ms} ms`)
  console.log(`  events folded:        ${result.events} (max position ${result.maxPosition})`)
  console.log(`  upcast on read:       ${result.upcast} (stored as an older schema version)`)
  console.log(`  skipped (unreadable): ${result.skipped.length}`)
  console.log(`  not yet applied live: ${result.notYetApplied}`)
  console.log(`  replay == live:       ${result.match ? 'yes' : 'NO'}`)
  for (const d of result.diffs.slice(0, 20)) console.log(`    ${d}`)
  if (!result.match) process.exitCode = 2
}

try {
  await main()
} finally {
  await pool.end()
  redis.disconnect()
}
