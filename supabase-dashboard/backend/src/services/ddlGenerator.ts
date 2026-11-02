import { ApiError } from './errors.js';
import { newIdentifier, quoteIdent, qualifiedTable, TARGET_SCHEMA } from './sqlIdentifiers.js';

export interface ColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string;
  primaryKey?: boolean;
  unique?: boolean;
  references?: { table: string; column: string };
}

/*
 * Each ColumnDef field arrives in a known slot, so each is validated for what
 * that slot may contain instead of being spliced into the statement as text:
 * names go through the identifier rules, types must look like a type name, and
 * defaults must be a literal or a zero-argument function call. Anything more
 * exotic (CHECK constraints, generated columns, complex defaults) belongs in the
 * SQL editor.
 */

// INTEGER, VARCHAR(255), NUMERIC(10, 2), DOUBLE PRECISION, TIMESTAMP WITH TIME ZONE, TEXT[]
const TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*( [A-Za-z][A-Za-z0-9_]*)*(\(\s*\d+\s*(,\s*\d+\s*)?\))?(\[\])*$/;

const DEFAULT_PATTERNS = [
  /^-?\d+(\.\d+)?$/, // numbers
  /^'(?:[^']|'')*'(::[A-Za-z][A-Za-z0-9_ ]*(\[\])?)?$/, // 'quoted text', optionally cast: '{}'::jsonb
  /^(true|false|null|current_timestamp|current_date|current_time|localtimestamp)$/i,
  /^[A-Za-z_][A-Za-z0-9_]*\(\)$/, // zero-argument calls: now(), gen_random_uuid()
];

function columnType(col: ColumnDef): string {
  const type = typeof col.type === 'string' ? col.type.trim() : '';
  if (!TYPE_PATTERN.test(type)) {
    throw new ApiError(400, `Invalid type "${String(col.type ?? '')}" for column "${String(col.name ?? '')}"`);
  }
  return type.toUpperCase();
}

function defaultClause(col: ColumnDef): string | null {
  if (col.defaultValue === undefined || col.defaultValue === null || String(col.defaultValue).trim() === '') {
    return null;
  }
  const value = String(col.defaultValue).trim();
  if (!DEFAULT_PATTERNS.some((p) => p.test(value))) {
    throw new ApiError(
      400,
      `Invalid default for column "${col.name}": use a number, a quoted string like 'pending', ` +
        `true/false/null, or a function call like now()`,
    );
  }
  return `DEFAULT ${value}`;
}

function referencesClause(col: ColumnDef): string | null {
  if (!col.references) return null;
  return `REFERENCES ${qualifiedTable(col.references.table)}(${quoteIdent(col.references.column, 'referenced column')})`;
}

/** Generates a CREATE TABLE DDL statement from structured column definitions. */
export function generateCreateTable(tableName: string, columns: ColumnDef[]): string {
  const table = `${quoteIdent(TARGET_SCHEMA)}.${newIdentifier(tableName, 'table name')}`;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new ApiError(400, 'At least one column is required');
  }

  // Several PK columns can't each say PRIMARY KEY ("multiple primary keys are not
  // allowed"), so a composite key becomes one table-level constraint.
  const pkColumns = columns.filter((c) => c.primaryKey === true);
  const inlinePk = pkColumns.length === 1;

  const columnDefs = columns.map((col) => {
    const parts = [newIdentifier(col.name, 'column name'), columnType(col)];
    if (col.primaryKey === true && inlinePk) parts.push('PRIMARY KEY');
    if (col.nullable !== true && col.primaryKey !== true) parts.push('NOT NULL');
    if (col.unique === true) parts.push('UNIQUE');
    const def = defaultClause(col);
    if (def) parts.push(def);
    const ref = referencesClause(col);
    if (ref) parts.push(ref);
    return '  ' + parts.join(' ');
  });

  if (pkColumns.length > 1) {
    columnDefs.push(`  PRIMARY KEY (${pkColumns.map((c) => newIdentifier(c.name, 'column name')).join(', ')})`);
  }

  return `CREATE TABLE ${table} (\n${columnDefs.join(',\n')}\n);`;
}

/** Generates an ALTER TABLE ADD COLUMN DDL statement. */
export function generateAddColumn(tableName: string, column: ColumnDef): string {
  const parts = [`ADD COLUMN ${newIdentifier(column.name, 'column name')} ${columnType(column)}`];
  if (column.nullable !== true) parts.push('NOT NULL');
  const def = defaultClause(column);
  if (def) parts.push(def);
  return `ALTER TABLE ${qualifiedTable(tableName)} ${parts.join(' ')};`;
}

/** Generates an ALTER TABLE DROP COLUMN DDL statement. */
export function generateDropColumn(tableName: string, columnName: string): string {
  return `ALTER TABLE ${qualifiedTable(tableName)} DROP COLUMN ${quoteIdent(columnName, 'column name')};`;
}

/** Generates an ALTER TABLE RENAME COLUMN DDL statement. */
export function generateRenameColumn(tableName: string, oldName: string, newName: string): string {
  return `ALTER TABLE ${qualifiedTable(tableName)} RENAME COLUMN ${quoteIdent(oldName, 'column name')} TO ${newIdentifier(newName, 'new column name')};`;
}

/** Generates a DROP TABLE CASCADE DDL statement. */
export function generateDropTable(tableName: string): string {
  return `DROP TABLE ${qualifiedTable(tableName)} CASCADE;`;
}

/** Generates an ALTER TABLE ALTER COLUMN TYPE DDL statement. */
export function generateAlterColumnType(tableName: string, columnName: string, newType: string): string {
  return `ALTER TABLE ${qualifiedTable(tableName)} ALTER COLUMN ${quoteIdent(columnName, 'column name')} TYPE ${columnType({ name: columnName, type: newType })};`;
}

/** Generates an ALTER TABLE SET/DROP NOT NULL DDL statement. */
export function generateSetColumnNullable(tableName: string, columnName: string, nullable: boolean): string {
  const action = nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
  return `ALTER TABLE ${qualifiedTable(tableName)} ALTER COLUMN ${quoteIdent(columnName, 'column name')} ${action};`;
}

/** Generates an ALTER TABLE SET/DROP DEFAULT DDL statement. */
export function generateSetColumnDefault(tableName: string, columnName: string, defaultValue: string | null): string {
  const target = `ALTER TABLE ${qualifiedTable(tableName)} ALTER COLUMN ${quoteIdent(columnName, 'column name')}`;
  const def = defaultValue === null ? null : defaultClause({ name: columnName, type: 'text', defaultValue });
  return def ? `${target} SET ${def};` : `${target} DROP DEFAULT;`;
}
