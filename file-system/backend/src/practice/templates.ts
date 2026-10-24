/**
 * Files the practice runner writes into an attempt folder. The level tests are
 * copied from src/fs/tests unchanged; everything else comes from here.
 * @module practice/templates
 */

export type Level = '1' | '2' | '3' | '4-backup' | '4-time'
export type Track = 'backup' | 'time'

export function levelsFor(track: Track): Level[] {
  return ['1', '2', '3', track === 'backup' ? '4-backup' : '4-time']
}

/** Test files each level adds. Earlier levels' tests keep running. */
export const levelTests: Record<Level, string> = {
  '1': 'level1.test.ts',
  '2': 'level2.test.ts',
  '3': 'level3.test.ts',
  '4-backup': 'level4-backup.test.ts',
  '4-time': 'level4-time.test.ts',
}

/** TypeScript signatures for the methods each level adds, appended to SPEC.md on unlock. */
export const levelSignatures: Record<Level, string> = {
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

export const subjectFile = `// What the tests construct. Leave this as it is.
import { FileStore } from './file-store.js'

export function createStore() {
  return new FileStore()
}
`

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
