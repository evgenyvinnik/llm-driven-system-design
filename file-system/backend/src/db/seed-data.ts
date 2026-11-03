/**
 * Demo data, loaded through the FsBackend API so the memory and PostgreSQL
 * stores end up identical. All names and files are fictitious.
 *
 * The order tells a story the Users page can replay: alice backs up while she
 * owns /shared/roadmap.md, then deletes it, and bob creates his own file at that
 * path. Restoring alice therefore skips it, reverts ideas.md, and removes
 * thesis-final.pdf, which she wrote after the backup.
 * @module db/seed-data
 */
import type { FsBackend } from '../store/backend.js'

const MiB = 1024 * 1024

const users: Array<[id: string, capacity: number]> = [
  ['alice', 64 * MiB],
  ['bob', 48 * MiB],
  ['carol', 24 * MiB],
  ['carol-archive', 4 * MiB],
  ['dmitri', 8 * MiB],
]

const files: Array<[path: string, size: number, owner: string | null]> = [
  ['/system/boot.img', 4_194_304, null],
  ['/system/config/hosts', 1_024, null],
  ['/system/config/motd.txt', 312, null],
  ['/system/logs/2026-10-21.log', 734_003, null],
  ['/system/logs/2026-10-22.log', 812_550, null],
  ['/home/alice/notes/standup-2026-10-20.md', 2_148, 'alice'],
  ['/home/alice/notes/ideas.md', 904, 'alice'],
  ['/home/alice/photos/lake.jpg', 3_481_220, 'alice'],
  ['/home/alice/photos/trail.jpg', 2_877_105, 'alice'],
  ['/home/alice/photos/trail-copy.jpg', 2_877_105, 'alice'],
  ['/home/alice/thesis.pdf', 7_912_448, 'alice'],
  ['/shared/budget-2026.xlsx', 301_442, 'alice'],
  ['/shared/roadmap.md', 17_002, 'alice'],
  ['/home/bob/music/demo.wav', 12_582_912, 'bob'],
  ['/home/bob/music/demo-v2.wav', 13_107_200, 'bob'],
  ['/home/bob/todo.txt', 402, 'bob'],
  ['/home/carol/datasets/survey.csv', 5_242_880, 'carol'],
  ['/home/carol/datasets/survey-clean.csv', 4_980_736, 'carol'],
  ['/home/carol/report.docx', 614_400, 'carol'],
  ['/shared/team-photo.png', 2_202_009, 'carol'],
  ['/archive/carol/2025/survey-2025.csv', 2_097_152, 'carol-archive'],
  ['/archive/carol/2025/notes.md', 6_100, 'carol-archive'],
  ['/home/dmitri/vm/disk.qcow2', 7_340_032, 'dmitri'],
  ['/home/dmitri/readme.txt', 1_200, 'dmitri'],
]

export async function seedDemo(backend: FsBackend): Promise<void> {
  await backend.clear()
  for (const [id, capacity] of users) await backend.addUser(id, capacity)
  for (const [path, size, owner] of files) await backend.addFile(path, size, owner)

  await backend.backupUser('alice')
  await backend.backupUser('carol')
  // After alice's backup:
  await backend.deleteFile('/shared/roadmap.md')
  await backend.addFile('/shared/roadmap.md', 18_230, 'bob')
  await backend.addFile('/home/alice/thesis-final.pdf', 8_011_776, 'alice')
  await backend.updateFile('/home/alice/notes/ideas.md', 1_377)
}
