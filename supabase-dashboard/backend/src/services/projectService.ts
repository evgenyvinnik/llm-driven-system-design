import { pool } from './db.js';
import { ApiError } from './errors.js';
import { encryptSecret } from './credentials.js';
import { pointsAtMetadataServer, removeTargetPool } from './queryExecutor.js';

/**
 * Project records and their connection settings. PUT /projects/:id and
 * PUT /projects/:id/settings both write through `updateProject`, so validation,
 * encryption of the password and eviction of the cached pool can't diverge
 * between the two routes.
 */

export interface ProjectInput {
  name?: string;
  description?: string | null;
  dbHost?: string;
  dbPort?: number;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
}

// Hostnames, IPv4 and (bracketed) IPv6. No '/' so a value can't name a Unix socket directory.
const HOST_RE = /^[A-Za-z0-9._:\-[\]]{1,255}$/;

function optionalString(body: Record<string, unknown>, key: string, max: number, label: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new ApiError(400, `${label} must be 1-${max} characters`);
  }
  return value.trim();
}

/**
 * Validates a create/update body. `undefined` fields mean "keep"; for
 * description, null or '' means "clear"; for dbPassword, '' means "keep".
 */
export function parseProjectInput(body: unknown, { partial }: { partial: boolean }): ProjectInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const input: ProjectInput = {};

  input.name = optionalString(b, 'name', 100, 'Project name');
  if (!partial && !input.name) throw new ApiError(400, 'Project name is required');

  if (b.description !== undefined) {
    if (b.description !== null && typeof b.description !== 'string') {
      throw new ApiError(400, 'Description must be a string');
    }
    input.description = typeof b.description === 'string' && b.description.trim() !== '' ? b.description : null;
  }

  const host = optionalString(b, 'dbHost', 255, 'Database host');
  if (host !== undefined && !HOST_RE.test(host)) throw new ApiError(400, 'Database host is not a valid hostname or IP address');
  input.dbHost = host;

  if (b.dbPort !== undefined && b.dbPort !== null && b.dbPort !== '') {
    const port = typeof b.dbPort === 'number' ? b.dbPort : Number(b.dbPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, 'Database port must be 1-65535');
    input.dbPort = port;
  }

  input.dbName = optionalString(b, 'dbName', 100, 'Database name');
  input.dbUser = optionalString(b, 'dbUser', 100, 'Database user');

  if (b.dbPassword !== undefined && b.dbPassword !== null && b.dbPassword !== '') {
    if (typeof b.dbPassword !== 'string' || b.dbPassword.length > 1024) {
      throw new ApiError(400, 'Database password must be a string of at most 1024 characters');
    }
    input.dbPassword = b.dbPassword;
  }
  return input;
}

function assertNotMetadata(host: string, port: number): void {
  if (pointsAtMetadataServer(host, port)) {
    throw new ApiError(
      400,
      "This connection points at the dashboard's own metadata database. Projects must use a separate PostgreSQL server.",
    );
  }
}

/** API shape of a project row. Never includes db_password, in any form. */
export function projectDto(r: Record<string, unknown>, memberRole?: string) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    dbHost: r.db_host,
    dbPort: r.db_port,
    dbName: r.db_name,
    dbUser: r.db_user,
    createdBy: r.created_by,
    ...(memberRole ? { memberRole } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PUBLIC_COLUMNS = 'id, name, description, db_host, db_port, db_name, db_user, created_by, created_at, updated_at';

/** Creates a project and its owner membership in one transaction. */
export async function createProject(input: ProjectInput, userId: string) {
  const host = input.dbHost ?? 'localhost';
  const port = input.dbPort ?? 5433;
  assertNotMetadata(host, port);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO projects (name, description, db_host, db_port, db_name, db_user, db_password, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        input.name,
        input.description ?? null,
        host,
        port,
        input.dbName ?? 'sample_db',
        input.dbUser ?? 'sample',
        encryptSecret(input.dbPassword ?? 'sample123'),
        userId,
      ],
    );
    const project = result.rows[0];
    // The member list should show the creator like everyone else.
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner'`,
      [project.id, userId],
    );
    await client.query('COMMIT');
    return projectDto(project, 'owner');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies a partial update. The row is locked so the metadata-server check runs
 * on the settings that will actually be stored (a port-only change is checked
 * against the stored host), and concurrent updates can't interleave.
 */
export async function updateProject(projectId: string, input: ProjectInput) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT db_host, db_port FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (current.rows.length === 0) throw new ApiError(404, 'Project not found');
    assertNotMetadata(input.dbHost ?? current.rows[0].db_host, input.dbPort ?? current.rows[0].db_port);

    const result = await client.query(
      `UPDATE projects
       SET name = COALESCE($1, name),
           description = CASE WHEN $2::boolean THEN $3 ELSE description END,
           db_host = COALESCE($4, db_host),
           db_port = COALESCE($5, db_port),
           db_name = COALESCE($6, db_name),
           db_user = COALESCE($7, db_user),
           db_password = COALESCE($8, db_password),
           updated_at = NOW()
       WHERE id = $9
       RETURNING ${PUBLIC_COLUMNS}`,
      [
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        input.dbHost ?? null,
        input.dbPort ?? null,
        input.dbName ?? null,
        input.dbUser ?? null,
        input.dbPassword !== undefined ? encryptSecret(input.dbPassword) : null,
        projectId,
      ],
    );
    await client.query('COMMIT');
    // Pools are keyed by a fingerprint of the settings, so the next query builds a
    // fresh pool regardless; this closes the old connections now and resets the breaker.
    removeTargetPool(projectId);
    return result.rows[0] as Record<string, unknown>;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
