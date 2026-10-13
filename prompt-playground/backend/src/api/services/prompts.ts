/**
 * Prompt, snapshot, and version data access with workspace authorization.
 */
import type { SessionUser } from '../../shared/auth.js'
import type { Queryable } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { contentHash, extractVariables } from '../../shared/template.js'

export interface PromptRow {
  id: string
  workspace_id: string
  title: string
  description: string
  head_version: number
  created_by: string
  updated_by: string
  created_at: Date
  updated_at: Date
}

export interface SnapshotRow {
  id: string
  system_text: string
  template_text: string
  variables: string[]
}

/** Loads a prompt the user may access. Non-members get the same 404 as a missing prompt. */
export async function loadPromptForUser(db: Queryable, promptId: string, user: SessionUser): Promise<PromptRow> {
  const { rows } = await db.query<PromptRow>(
    `SELECT p.* FROM prompts p
       JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2
      WHERE p.id = $1`,
    [promptId, user.id],
  )
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Prompt not found')
  return rows[0]
}

/** Finds or creates the content-addressed snapshot for this text. */
export async function upsertSnapshot(
  db: Queryable,
  promptId: string,
  systemText: string,
  templateText: string,
  userId: string,
): Promise<SnapshotRow> {
  const hash = contentHash(systemText, templateText)
  const variables = extractVariables(systemText, templateText)
  const inserted = await db.query<SnapshotRow>(
    `INSERT INTO prompt_snapshots (prompt_id, content_hash, system_text, template_text, variables, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (prompt_id, content_hash) DO NOTHING
     RETURNING id, system_text, template_text, variables`,
    [promptId, hash, systemText, templateText, variables, userId],
  )
  if (inserted.rows.length > 0) return inserted.rows[0]
  const existing = await db.query<SnapshotRow>(
    `SELECT id, system_text, template_text, variables FROM prompt_snapshots
      WHERE prompt_id = $1 AND content_hash = $2`,
    [promptId, hash],
  )
  return existing.rows[0]
}

/** Latest saved version whose text is exactly this snapshot, or null for an unsaved draft. */
export async function versionForSnapshot(db: Queryable, promptId: string, snapshotId: string): Promise<number | null> {
  const { rows } = await db.query<{ version: number | null }>(
    'SELECT max(version) AS version FROM prompt_versions WHERE prompt_id = $1 AND snapshot_id = $2',
    [promptId, snapshotId],
  )
  return rows[0]?.version ?? null
}

export interface VersionDetail {
  version: number
  message: string
  system: string
  template: string
  variables: string[]
  snapshotId: string
  createdBy: { id: string; displayName: string }
  createdAt: string
}

export async function loadVersion(db: Queryable, promptId: string, version: number): Promise<VersionDetail | null> {
  const { rows } = await db.query(
    `SELECT v.version, v.message, v.created_at, v.snapshot_id, s.system_text, s.template_text, s.variables,
            u.id AS user_id, u.display_name
       FROM prompt_versions v
       JOIN prompt_snapshots s ON s.id = v.snapshot_id
       JOIN users u ON u.id = v.created_by
      WHERE v.prompt_id = $1 AND v.version = $2`,
    [promptId, version],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    version: r.version,
    message: r.message,
    system: r.system_text,
    template: r.template_text,
    variables: r.variables,
    snapshotId: r.snapshot_id,
    createdBy: { id: r.user_id, displayName: r.display_name },
    createdAt: r.created_at.toISOString(),
  }
}
