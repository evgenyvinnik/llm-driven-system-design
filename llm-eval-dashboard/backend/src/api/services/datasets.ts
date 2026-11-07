/**
 * Datasets and their immutable versions. Editing submits the full case list
 * against a base version: the head moves only if the base is still the head
 * (409 otherwise), and the new version's cases are new rows. Old versions,
 * and every run pinned to them, are untouched.
 * @module api/services/datasets
 */
import { z } from 'zod'
import { caseHash, diffCases, nextCaseKey, versionHash, type KeyedCase } from '../../shared/dataset-diff.js'
import { withTransaction, type Queryable } from '../../shared/db.js'
import { HttpError, notFound } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'

export const caseInputSchema = z
  .object({
    caseKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).optional(),
    input: z.record(z.string().max(20_000)),
    reference: z.string().max(20_000),
    tags: z.array(z.string().min(1).max(40)).max(10).default([]),
  })
  .strict()

export const createVersionSchema = z
  .object({ baseVersion: z.number().int().min(0), message: z.string().trim().min(1).max(300), cases: z.array(caseInputSchema).min(1).max(2000) })
  .strict()

export const createDatasetSchema = z
  .object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).default(''), cases: z.array(caseInputSchema).min(1).max(2000) })
  .strict()

export async function listDatasets(db: Queryable, workspaceId: string) {
  const { rows } = await db.query<{ id: string; name: string; description: string; head_version: number; case_count: number | null; updated_at: Date; runs: number }>(
    `SELECT d.id, d.name, d.description, d.head_version, dv.case_count, d.updated_at,
            (SELECT count(*) FROM eval_runs r JOIN dataset_versions v ON v.id = r.dataset_version_id WHERE v.dataset_id = d.id) AS runs
       FROM datasets d LEFT JOIN dataset_versions dv ON dv.dataset_id = d.id AND dv.version = d.head_version
      WHERE d.workspace_id = $1 ORDER BY d.name`,
    [workspaceId],
  )
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, headVersion: r.head_version, caseCount: r.case_count ?? 0, updatedAt: r.updated_at.toISOString(), runs: r.runs }))
}

export async function getDataset(db: Queryable, workspaceId: string, datasetId: string) {
  const d = await db.query<{ id: string; name: string; description: string; head_version: number }>('SELECT id, name, description, head_version FROM datasets WHERE id = $1 AND workspace_id = $2', [datasetId, workspaceId])
  if (!d.rows[0]) throw notFound('Dataset')
  const versions = await db.query<{ id: string; version: number; message: string; case_count: number; content_hash: string; created_at: Date; created_by: string; runs: number }>(
    `SELECT v.id, v.version, v.message, v.case_count, v.content_hash, v.created_at, u.display_name AS created_by,
            (SELECT count(*) FROM eval_runs r WHERE r.dataset_version_id = v.id) AS runs
       FROM dataset_versions v JOIN users u ON u.id = v.created_by WHERE v.dataset_id = $1 ORDER BY v.version DESC`,
    [datasetId],
  )
  return {
    id: d.rows[0].id,
    name: d.rows[0].name,
    description: d.rows[0].description,
    headVersion: d.rows[0].head_version,
    versions: versions.rows.map((v) => ({ id: v.id, version: v.version, message: v.message, caseCount: v.case_count, contentHash: v.content_hash, createdAt: v.created_at.toISOString(), createdBy: v.created_by, runs: v.runs })),
  }
}

export async function versionCases(db: Queryable, workspaceId: string, datasetId: string, version: number): Promise<(KeyedCase & { id: string; ordinal: number; contentHash: string })[]> {
  const { rows } = await db.query<{ id: string; case_key: string; ordinal: number; input: Record<string, unknown>; reference: string; tags: string[]; content_hash: string }>(
    `SELECT c.id, c.case_key, c.ordinal, c.input, c.reference, c.tags, c.content_hash
       FROM dataset_cases c JOIN dataset_versions v ON v.id = c.dataset_version_id JOIN datasets d ON d.id = v.dataset_id
      WHERE d.id = $1 AND d.workspace_id = $2 AND v.version = $3 ORDER BY c.ordinal`,
    [datasetId, workspaceId, version],
  )
  return rows.map((r) => ({ id: r.id, caseKey: r.case_key, ordinal: r.ordinal, input: r.input, reference: r.reference, tags: r.tags, contentHash: r.content_hash }))
}

export async function diffVersions(db: Queryable, workspaceId: string, datasetId: string, from: number, to: number) {
  const [a, b] = await Promise.all([versionCases(db, workspaceId, datasetId, from), versionCases(db, workspaceId, datasetId, to)])
  if (a.length === 0 || b.length === 0) throw notFound('Dataset version')
  return diffCases(a, b)
}

type CaseInput = z.infer<typeof caseInputSchema>

async function insertVersion(client: Queryable, datasetId: string, version: number, message: string, cases: KeyedCase[], userId: string): Promise<string> {
  const id = newId('dsv')
  await client.query('INSERT INTO dataset_versions (id, dataset_id, version, message, case_count, content_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, datasetId, version, message, cases.length, versionHash(cases), userId])
  await client.query(
    `INSERT INTO dataset_cases (id, dataset_version_id, case_key, ordinal, input, reference, tags, content_hash)
     SELECT $1 || ':' || x.case_key, $1, x.case_key, x.ordinal, x.input, x.reference, ARRAY(SELECT jsonb_array_elements_text(x.tags)), x.content_hash
       FROM jsonb_to_recordset($2::jsonb) AS x(case_key text, ordinal int, input jsonb, reference text, tags jsonb, content_hash text)`,
    [id, JSON.stringify(cases.map((c, i) => ({ case_key: c.caseKey, ordinal: i + 1, input: c.input, reference: c.reference, tags: c.tags, content_hash: caseHash(c) })))],
  )
  return id
}

function assignKeys(cases: CaseInput[], existingKeys: string[], prefix: string): KeyedCase[] {
  const used = new Set<string>()
  const all = [...existingKeys]
  const out: KeyedCase[] = []
  for (const c of cases) {
    const key = c.caseKey ?? nextCaseKey([...all, ...used], prefix)
    if (used.has(key)) throw new HttpError(422, 'DUPLICATE_CASE_KEY', `Case key ${key} appears twice`)
    used.add(key)
    out.push({ caseKey: key, input: c.input, reference: c.reference, tags: c.tags })
  }
  return out
}

export async function createDataset(workspaceId: string, userId: string, input: z.infer<typeof createDatasetSchema>) {
  const id = newId('ds')
  const prefix = input.name.replace(/[^a-z]/gi, '').slice(0, 1).toLowerCase() || 'c'
  const cases = assignKeys(input.cases, [], prefix)
  return withTransaction(async (client) => {
    try {
      await client.query('INSERT INTO datasets (id, workspace_id, name, description, head_version, created_by) VALUES ($1, $2, $3, $4, 1, $5)', [id, workspaceId, input.name, input.description, userId])
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'NAME_TAKEN', 'A dataset with this name exists')
      throw err
    }
    const versionId = await insertVersion(client, id, 1, 'Initial version', cases, userId)
    return { id, versionId, version: 1 }
  })
}

export async function createVersion(workspaceId: string, userId: string, datasetId: string, input: z.infer<typeof createVersionSchema>) {
  return withTransaction(async (client) => {
    const d = await client.query<{ head_version: number }>('SELECT head_version FROM datasets WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [datasetId, workspaceId])
    if (!d.rows[0]) throw notFound('Dataset')
    const head = d.rows[0].head_version
    if (input.baseVersion !== head) throw new HttpError(409, 'VERSION_CONFLICT', `Dataset is at v${head}; you edited v${input.baseVersion}. Reload and re-apply your changes.`, { headVersion: head })
    const prev = await versionCases(client, workspaceId, datasetId, head)
    const prefix = prev[0]?.caseKey.replace(/-\d+$/, '') ?? 'c'
    const cases = assignKeys(input.cases, prev.map((c) => c.caseKey), prefix)
    if (versionHash(cases) === versionHash(prev)) throw new HttpError(422, 'NO_CHANGES', 'The cases are identical to the current version')
    const versionId = await insertVersion(client, datasetId, head + 1, input.message, cases, userId)
    await client.query('UPDATE datasets SET head_version = $2, updated_at = now() WHERE id = $1', [datasetId, head + 1])
    return { versionId, version: head + 1, diff: diffCases(prev, cases) }
  })
}

