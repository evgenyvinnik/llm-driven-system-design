import type pg from 'pg';
import { logger } from './logger.js';

/*
 * Introspection runs on a client checked out from the project's pool (via
 * queryExecutor.withTargetClient), so it shares the 5-connection cap, the
 * circuit breaker and the metadata-server guard with every other target query.
 * Pooled connections see committed DDL immediately; a fresh client per request
 * bought nothing but an extra connection outside the cap.
 */

export interface TableInfo {
  tableName: string;
  schema: string;
  columns: ColumnInfo[];
  /** Planner estimate (pg_class.reltuples); null when the table has never been analyzed. */
  rowCount: number | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyRef?: string;
  ordinalPosition: number;
}

export interface IndexInfo {
  indexName: string;
  tableName: string;
  indexDef: string;
}

/** Introspects all public tables with columns, primary keys, foreign keys, and row count estimates. */
export async function introspectTables(client: pg.ClientBase): Promise<TableInfo[]> {
  try {
    // Get all user tables
    const tablesResult = await client.query(`
      SELECT table_name, table_schema
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const tables: TableInfo[] = [];

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;
      const schema = row.table_schema;

      // Get columns
      const columnsResult = await client.query(`
        SELECT
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          c.ordinal_position
        FROM information_schema.columns c
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position
      `, [schema, tableName]);

      // Get primary keys
      const pkResult = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = $1
          AND tc.table_name = $2
      `, [schema, tableName]);
      const pkColumns = new Set(pkResult.rows.map((r: { column_name: string }) => r.column_name));

      // Get foreign keys
      const fkResult = await client.query(`
        SELECT
          kcu.column_name,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = $1
          AND tc.table_name = $2
      `, [schema, tableName]);
      const fkMap = new Map<string, string>();
      for (const fk of fkResult.rows) {
        fkMap.set(fk.column_name, `${fk.foreign_table_name}.${fk.foreign_column_name}`);
      }

      // Get row count estimate (schema-qualified: relname alone can match a same-named relation elsewhere)
      const countResult = await client.query(`
        SELECT c.reltuples::bigint AS estimate
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
      `, [schema, tableName]);
      // reltuples is -1 until the table is first vacuumed/analyzed (small seeded tables
      // never reach autovacuum's threshold); report "unknown" rather than a false 0.
      const estimate = Number(countResult.rows[0]?.estimate ?? -1);

      const columns: ColumnInfo[] = columnsResult.rows.map((col: {
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        ordinal_position: number;
      }) => ({
        name: col.column_name,
        dataType: col.data_type,
        isNullable: col.is_nullable === 'YES',
        columnDefault: col.column_default,
        isPrimaryKey: pkColumns.has(col.column_name),
        isForeignKey: fkMap.has(col.column_name),
        foreignKeyRef: fkMap.get(col.column_name),
        ordinalPosition: col.ordinal_position,
      }));

      tables.push({ tableName, schema, columns, rowCount: estimate >= 0 ? estimate : null });
    }

    return tables;
  } catch (err) {
    logger.error({ err }, 'Schema introspection failed');
    throw err;
  }
}

/** Retrieves all indexes for a specific table from pg_indexes. */
export async function introspectIndexes(client: pg.ClientBase, tableName: string): Promise<IndexInfo[]> {
  const result = await client.query(`
    SELECT indexname AS index_name, tablename AS table_name, indexdef AS index_def
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = $1
    ORDER BY indexname
  `, [tableName]);

  return result.rows.map((r: { index_name: string; table_name: string; index_def: string }) => ({
    indexName: r.index_name,
    tableName: r.table_name,
    indexDef: r.index_def,
  }));
}

export interface TableKeyInfo {
  columns: string[];
  primaryKey: string[];
}

/**
 * Columns and primary-key columns of a base table in `public`, or null if there
 * is no such table. Row edits use this rather than trusting a client-supplied
 * key column: a non-unique "id" would turn a one-row edit into a mass update.
 */
export async function getTableKeyInfo(client: pg.ClientBase, tableName: string): Promise<TableKeyInfo | null> {
  const result = await client.query(`
    SELECT
      c.column_name,
      EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_schema = tc.constraint_schema
          AND kcu.constraint_name = tc.constraint_name
          AND kcu.table_name = tc.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = c.table_schema
          AND tc.table_name = c.table_name
          AND kcu.column_name = c.column_name
      ) AS is_pk
    FROM information_schema.tables t
    JOIN information_schema.columns c
      ON c.table_schema = t.table_schema AND c.table_name = t.table_name
    WHERE t.table_schema = 'public' AND t.table_name = $1 AND t.table_type = 'BASE TABLE'
    ORDER BY c.ordinal_position
  `, [tableName]);

  if (result.rows.length === 0) return null;
  const rows = result.rows as { column_name: string; is_pk: boolean }[];
  return {
    columns: rows.map((r) => r.column_name),
    primaryKey: rows.filter((r) => r.is_pk).map((r) => r.column_name),
  };
}
