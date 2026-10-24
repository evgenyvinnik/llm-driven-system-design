/**
 * Timed practice runner for levels.md, in the format of the assessment it
 * reconstructs: one level visible at a time, tests you run against your own
 * code, and the next level unlocked only when the current one passes.
 *
 *   npm run practice -- start [--track backup|time] [--minutes 90]
 *   npm run practice -- check     run the unlocked levels' tests
 *   npm run practice -- next      unlock the next level (current one must pass)
 *   npm run practice -- status    split times per level
 *   npm run practice -- dedup     add the onsite duplicate-files bonus
 *   npm run practice -- reset --yes
 *
 * The attempt lives in backend/practice-attempt/ (git-ignored).
 * @module practice/cli
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  dedupStub,
  fileStoreStub,
  levelSignatures,
  levelsFor,
  levelTests,
  subjectFile,
  tsconfig,
  vitestConfig,
  type Level,
  type Track,
} from './templates.js'

const backendDir = fileURLToPath(new URL('../../', import.meta.url))
const levelsMd = join(backendDir, '..', 'levels.md')
const testsDir = join(backendDir, 'src', 'fs', 'tests')

interface State {
  track: Track
  minutes: number
  startedAt: string
  /** Index into levelsFor(track) of the level being worked on. */
  current: number
  unlockedAt: Partial<Record<Level, string>>
  passedAt: Partial<Record<Level, string>>
  dedup?: boolean
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    track: { type: 'string', default: 'backup' },
    minutes: { type: 'string', default: '90' },
    dir: { type: 'string', default: 'practice-attempt' },
    yes: { type: 'boolean', default: false },
  },
})

const dir = join(backendDir, values.dir!)
const statePath = join(dir, '.practice.json')
const command = positionals[0] ?? 'help'

function section(marker: string): string {
  const text = readFileSync(levelsMd, 'utf8')
  const match = text.match(new RegExp(`<!-- practice:${marker} -->\\n([\\s\\S]*?)<!-- /practice:${marker} -->`))
  if (!match) throw new Error(`levels.md has no practice:${marker} section`)
  return match[1].trim()
}

function loadState(): State {
  if (!existsSync(statePath)) fail('No attempt in progress. Start one with: npm run practice -- start')
  return JSON.parse(readFileSync(statePath, 'utf8')) as State
}

function saveState(state: State) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function clock(ms: number): string {
  const total = Math.round(ms / 1000)
  const sign = total < 0 ? '-' : ''
  const abs = Math.abs(total)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
}

function timeLine(state: State): string {
  const elapsed = Date.now() - Date.parse(state.startedAt)
  const left = state.minutes * 60_000 - elapsed
  return left >= 0 ? `Elapsed ${clock(elapsed)}, ${clock(left)} left.` : `Elapsed ${clock(elapsed)}: ${clock(-left)} over the ${state.minutes}-minute limit.`
}

function unlock(state: State, level: Level) {
  copyFileSync(join(testsDir, levelTests[level]), join(dir, 'tests', levelTests[level]))
  const signatures = `\n\n**Methods for this level:**\n\n\`\`\`ts\n${levelSignatures[level]}\n\`\`\`\n`
  appendFileSync(join(dir, 'SPEC.md'), `\n\n${section(`level:${level}`)}${level === '1' ? '' : signatures}`)
  state.unlockedAt[level] = new Date().toISOString()
}

function runTests(): boolean {
  const vitest = join(backendDir, 'node_modules', '.bin', 'vitest')
  const result = spawnSync(vitest, ['run', '--root', dir, '--config', join(dir, 'vitest.config.mjs')], { stdio: 'inherit' })
  return result.status === 0
}

function start() {
  if (existsSync(dir)) fail(`${dir} already exists. Finish it, or delete it with: npm run practice -- reset --yes`)
  const track = values.track as Track
  if (track !== 'backup' && track !== 'time') fail('--track must be "backup" or "time"')
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'file-store.ts'), fileStoreStub)
  writeFileSync(join(dir, 'subject.ts'), subjectFile)
  writeFileSync(join(dir, 'vitest.config.mjs'), vitestConfig)
  writeFileSync(join(dir, 'tsconfig.json'), tsconfig)
  writeFileSync(join(dir, 'SPEC.md'), `# Practice Attempt\n\n${section('rules')}`)
  const state: State = {
    track,
    minutes: Number(values.minutes),
    startedAt: new Date().toISOString(),
    current: 0,
    unlockedAt: {},
    passedAt: {},
  }
  unlock(state, '1')
  saveState(state)
  console.log(`Practice started: ${state.minutes} minutes, level 4 track "${track}".

  Read:  ${join(dir, 'SPEC.md')}
  Edit:  ${join(dir, 'file-store.ts')}
  Test:  npm run practice -- check
  Next:  npm run practice -- next   (once the current level passes)

The clock is running. Don't open levels.md or src/fs/file-store.ts until you're done.`)
}

function check() {
  const state = loadState()
  const levels = levelsFor(state.track)
  const level = levels[state.current]
  const passed = runTests()
  if (passed && !state.passedAt[level]) {
    state.passedAt[level] = new Date().toISOString()
    saveState(state)
  }
  console.log(`\n${timeLine(state)}`)
  if (!passed) console.log(`Level ${level} isn't passing yet.`)
  else if (state.current < levels.length - 1) console.log(`Level ${level} passes. Unlock the next one with: npm run practice -- next`)
  else console.log('Every level passes. Compare with ../src/fs/file-store.ts and levels.md, and note your splits (npm run practice -- status) in CLAUDE.md.')
  process.exitCode = passed ? 0 : 1
}

function next() {
  const state = loadState()
  const levels = levelsFor(state.track)
  const level = levels[state.current]
  if (state.current === levels.length - 1) fail('There is no level after this one.')
  if (!state.passedAt[level]) {
    if (!runTests()) fail(`\nLevel ${level} must pass before the next one unlocks.`)
    state.passedAt[level] = new Date().toISOString()
  }
  state.current += 1
  const unlocked = levels[state.current]
  unlock(state, unlocked)
  saveState(state)
  console.log(`Level ${unlocked} unlocked: SPEC.md has a new section and tests/ has ${levelTests[unlocked]}.
Add the new methods to FileStore. Some earlier methods gain rules too. ${timeLine(state)}`)
}

function status() {
  const state = loadState()
  let previous = Date.parse(state.startedAt)
  console.log(`Track "${state.track}", ${state.minutes}-minute limit. ${timeLine(state)}\n`)
  for (const level of levelsFor(state.track)) {
    const passed = state.passedAt[level]
    const unlocked = state.unlockedAt[level]
    const line = !unlocked ? 'locked' : passed ? `passed after ${clock(Date.parse(passed) - previous)}` : 'in progress'
    console.log(`  Level ${level.padEnd(9)} ${line}`)
    if (passed) previous = Date.parse(passed)
  }
}

function dedup() {
  const state = loadState()
  if (state.dedup) fail('The dedup bonus is already in this attempt.')
  writeFileSync(join(dir, 'dedup.ts'), dedupStub)
  copyFileSync(join(testsDir, 'dedup.test.ts'), join(dir, 'tests', 'dedup.test.ts'))
  appendFileSync(join(dir, 'SPEC.md'), `\n\n${section('dedup')}\n`)
  state.dedup = true
  saveState(state)
  console.log('Added dedup.ts and tests/dedup.test.ts, and appended the problem to SPEC.md.')
}

function reset() {
  if (!values.yes) fail(`This deletes ${dir} and your code in it. Rerun with --yes to confirm.`)
  rmSync(dir, { recursive: true, force: true })
  console.log(`Deleted ${dir}.`)
}

const commands: Record<string, () => void> = { start, check, test: check, next, status, dedup, reset }
const run = commands[command]
if (run) run()
else console.log('Usage: npm run practice -- <start|check|next|status|dedup|reset> [--track backup|time] [--minutes 90]')
