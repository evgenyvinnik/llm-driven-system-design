/**
 * Files the practice runner writes into an attempt folder, for each practice
 * problem. The level tests are copied from the problem's tests folder unchanged;
 * everything else comes from here.
 * @module practice/templates
 */

export type Problem = 'fs' | 'db'
export type Level = '1' | '2' | '3' | '4-backup' | '4-time' | '4-history'
export type Track = 'backup' | 'time' | 'history'

export interface ProblemSpec {
  /** The spec with the practice markers, relative to the project folder. */
  specFile: string
  /** The worked answer and its level tests, relative to backend/. */
  answerFile: string
  testsDir: string
  /** The class an attempt implements, and the file the attempt keeps it in. */
  className: string
  stubFile: string
  stub: string
  subject: string
  /** Level-4 tracks. The first is the default. */
  tracks: Partial<Record<Track, Level[]>>
  /** Test files each level adds. Earlier levels' tests keep running. */
  levelTests: Partial<Record<Level, string>>
  /** TypeScript signatures for the methods each level adds, appended to SPEC.md on unlock. */
  levelSignatures: Partial<Record<Level, string>>
}

// ── fs: the file store in levels.md ─────────────────────────────────────────

export const fileStoreStub = `/**
 * Your practice attempt. SPEC.md describes what to build; it grows one level at a time.
 * From backend/, run \`npm run practice -- check\` to test the levels you've unlocked.
 */
export class FileStore {
  addFile(path: string, size: number): boolean {
    throw new Error('Not implemented')
  }

  getSize(path: string): number | null {
    throw new Error('Not implemented')
  }

  updateFile(path: string, size: number): number | null {
    throw new Error('Not implemented')
  }

  deleteFile(path: string): number | null {
    throw new Error('Not implemented')
  }
}
`

const fileStoreSignatures: ProblemSpec['levelSignatures'] = {
  '1': `addFile(path: string, size: number): boolean
getSize(path: string): number | null
updateFile(path: string, size: number): number | null
deleteFile(path: string): number | null`,
  '2': `listDir(path: string): string[] | null
dirSize(path: string): number | null
largest(prefix: string, n: number): string[]`,
  '3': `addUser(userId: string, capacity: number): boolean
addFileAs(userId: string, path: string, size: number): number | null
getRemaining(userId: string): number | null
mergeUsers(targetId: string, sourceId: string): number | null`,
  '4-backup': `backupUser(userId: string): number | null
restoreUser(userId: string): number | null`,
  '4-time': `setTime(t: number): boolean
getSizeAt(path: string, t: number): number | null
// and an optional last parameter on two existing methods:
addFile(path: string, size: number, ttl?: number): boolean
addFileAs(userId: string, path: string, size: number, ttl?: number): number | null`,
}

// ── db: the key-value store in levels-db.md ─────────────────────────────────

export const kvStoreStub = `/**
 * Your practice attempt. SPEC.md describes what to build; it grows one level at a time.
 * From backend/, run \`npm run practice -- check\` to test the levels you've unlocked.
 */
export class KvStore {
  setField(key: string, field: string, value: string): string | null {
    throw new Error('Not implemented')
  }

  getField(key: string, field: string): string | null {
    throw new Error('Not implemented')
  }

  deleteField(key: string, field: string): string | null {
    throw new Error('Not implemented')
  }

  deleteRecord(key: string): number | null {
    throw new Error('Not implemented')
  }
}
`

const kvStoreSignatures: ProblemSpec['levelSignatures'] = {
  '1': `setField(key: string, field: string, value: string): string | null
getField(key: string, field: string): string | null
deleteField(key: string, field: string): string | null
deleteRecord(key: string): number | null`,
  '2': `scanRecord(key: string): string[]
scanPrefix(key: string, prefix: string): string[]
topRecords(prefix: string, n: number): string[]`,
  '3': `setFieldAt(t: number, key: string, field: string, value: string, ttl?: number): string | null
getFieldAt(t: number, key: string, field: string): string | null
deleteFieldAt(t: number, key: string, field: string): string | null
deleteRecordAt(t: number, key: string): number | null
scanRecordAt(t: number, key: string): string[]
scanPrefixAt(t: number, key: string, prefix: string): string[]
topRecordsAt(t: number, prefix: string, n: number): string[]`,
  '4-history': `getFieldAsOf(key: string, field: string, asOf: number): string | null
scanRecordAsOf(key: string, asOf: number): string[]`,
  '4-backup': `backupAt(t: number): number
restoreAt(t: number, backupTime: number): number | null`,
}

function subjectFor(className: string, stubFile: string): string {
  return `// What the tests construct. Leave this as it is.
import { ${className} } from './${stubFile.replace(/\.ts$/, '.js')}'

export function createStore() {
  return new ${className}()
}
`
}

export const problems: Record<Problem, ProblemSpec> = {
  fs: {
    specFile: 'levels.md',
    answerFile: 'src/fs/file-store.ts',
    testsDir: 'src/fs/tests',
    className: 'FileStore',
    stubFile: 'file-store.ts',
    stub: fileStoreStub,
    subject: subjectFor('FileStore', 'file-store.ts'),
    tracks: {
      backup: ['1', '2', '3', '4-backup'],
      time: ['1', '2', '3', '4-time'],
    },
    levelTests: {
      '1': 'level1.test.ts',
      '2': 'level2.test.ts',
      '3': 'level3.test.ts',
      '4-backup': 'level4-backup.test.ts',
      '4-time': 'level4-time.test.ts',
    },
    levelSignatures: fileStoreSignatures,
  },
  db: {
    specFile: 'levels-db.md',
    answerFile: 'src/kv/kv-store.ts',
    testsDir: 'src/kv/tests',
    className: 'KvStore',
    stubFile: 'kv-store.ts',
    stub: kvStoreStub,
    subject: subjectFor('KvStore', 'kv-store.ts'),
    tracks: {
      backup: ['1', '2', '3', '4-backup'],
      history: ['1', '2', '3', '4-history'],
    },
    levelTests: {
      '1': 'level1.test.ts',
      '2': 'level2.test.ts',
      '3': 'level3.test.ts',
      '4-backup': 'level4-backup.test.ts',
      '4-history': 'level4-history.test.ts',
    },
    levelSignatures: kvStoreSignatures,
  },
}

export function levelsFor(problem: Problem, track: Track): Level[] {
  const levels = problems[problem].tracks[track]
  if (!levels) throw new Error(`Problem "${problem}" has no track "${track}"`)
  return levels
}

export const dedupStub = `/**
 * Bonus exercise: see the "Onsite Variant" section of SPEC.md.
 * From backend/, run \`npm run practice -- check\` to test it.
 */
export async function findDuplicates(root: string): Promise<string[][]> {
  throw new Error('Not implemented')
}
`

export const vitestConfig = `// Practice attempts run on their own, without the backend's vitest config.
export default { test: { include: ['tests/**/*.test.ts'], environment: 'node' } }
`

export const tsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["**/*.ts"]
}
`
