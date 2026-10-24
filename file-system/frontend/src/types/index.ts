export interface DirEntry {
  name: string
  kind: 'file' | 'dir'
  /** A file's size, or the total bytes below a directory. */
  size: number
  owner: string | null
  /** Files anywhere below a directory; 1 for a file. */
  fileCount: number
}

export interface DirListing {
  path: string
  bytes: number
  fileCount: number
  entries: DirEntry[]
}

export interface LargestFile {
  path: string
  size: number
}

export interface BackupSummary {
  fileCount: number
  bytes: number
  takenAt: string
}

export interface UserSummary {
  id: string
  capacity: number
  used: number
  fileCount: number
  backup: BackupSummary | null
}

export interface RestoreResult {
  id: string
  restored: number
  skipped: string[]
}

export type StoreKind = 'memory' | 'postgres'
