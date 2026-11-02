import { describe, it, expect } from 'vitest';
import {
  generateCreateTable,
  generateAddColumn,
  generateDropColumn,
  generateRenameColumn,
  generateDropTable,
} from './ddlGenerator.js';
import { quoteIdent, newIdentifier, qualifiedTable } from './sqlIdentifiers.js';
import { ApiError } from './errors.js';

function status(fn: () => unknown): number {
  try {
    fn();
    return 200;
  } catch (err) {
    return err instanceof ApiError ? err.status : 500;
  }
}

describe('identifier quoting', () => {
  it('quotes every identifier and doubles embedded quotes', () => {
    expect(quoteIdent('orders')).toBe('"orders"');
    expect(quoteIdent('Order Items')).toBe('"Order Items"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
    // An injection attempt stays a single (odd) identifier.
    expect(quoteIdent('x"; DROP TABLE users; --')).toBe('"x""; DROP TABLE users; --"');
  });

  it('quotes reserved words that a keyword list would miss', () => {
    expect(quoteIdent('window')).toBe('"window"');
    expect(quoteIdent('offset')).toBe('"offset"');
  });

  it('rejects empty, NUL-containing and over-long names', () => {
    expect(status(() => quoteIdent(''))).toBe(400);
    expect(status(() => quoteIdent('a\0b'))).toBe(400);
    expect(status(() => quoteIdent('x'.repeat(64)))).toBe(400);
    expect(status(() => quoteIdent(42))).toBe(400);
  });

  it('rejects invalid new names instead of silently renaming them', () => {
    expect(status(() => newIdentifier('my table'))).toBe(400);
    expect(status(() => newIdentifier('!!!'))).toBe(400);
    expect(status(() => newIdentifier('1abc'))).toBe(400);
    expect(newIdentifier('MyTable')).toBe('"MyTable"');
  });

  it('schema-qualifies table names so search_path cannot resolve them to catalog tables', () => {
    expect(qualifiedTable('pg_authid')).toBe('"public"."pg_authid"');
  });
});

describe('generateCreateTable', () => {
  it('builds a quoted, schema-qualified CREATE TABLE', () => {
    const ddl = generateCreateTable('events', [
      { name: 'id', type: 'SERIAL', primaryKey: true },
      { name: 'title', type: 'varchar(255)' },
      { name: 'status', type: 'TEXT', defaultValue: "'pending'" },
      { name: 'created_at', type: 'TIMESTAMPTZ', defaultValue: 'NOW()' },
      { name: 'customer_id', type: 'INTEGER', nullable: true, references: { table: 'customers', column: 'id' } },
    ]);
    expect(ddl).toBe(
      'CREATE TABLE "public"."events" (\n' +
        '  "id" SERIAL PRIMARY KEY,\n' +
        '  "title" VARCHAR(255) NOT NULL,\n' +
        `  "status" TEXT NOT NULL DEFAULT 'pending',\n` +
        '  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n' +
        '  "customer_id" INTEGER REFERENCES "public"."customers"("id")\n' +
        ');',
    );
  });

  it('emits one table-level constraint for a composite primary key', () => {
    const ddl = generateCreateTable('order_lines', [
      { name: 'order_id', type: 'INTEGER', primaryKey: true },
      { name: 'line_no', type: 'INTEGER', primaryKey: true },
    ]);
    expect(ddl).not.toMatch(/INTEGER PRIMARY KEY/);
    expect(ddl).toContain('PRIMARY KEY ("order_id", "line_no")');
  });

  it('rejects SQL smuggled through the type or default slots', () => {
    expect(status(() => generateCreateTable('t', [{ name: 'a', type: 'INT); DROP TABLE customers; --' }]))).toBe(400);
    expect(status(() => generateCreateTable('t', [{ name: 'a', type: 'INT', defaultValue: '0; DROP TABLE x' }]))).toBe(400);
    expect(status(() => generateCreateTable('t', [{ name: 'a', type: 'TEXT', defaultValue: 'pending' }]))).toBe(400);
  });

  it('accepts multi-word, parameterised and array types', () => {
    expect(status(() => generateCreateTable('t', [{ name: 'a', type: 'DOUBLE PRECISION' }]))).toBe(200);
    expect(status(() => generateCreateTable('t', [{ name: 'a', type: 'NUMERIC(10, 2)' }]))).toBe(200);
    expect(status(() => generateCreateTable('t', [{ name: 'a', type: 'TEXT[]', defaultValue: "'{}'::text[]" }]))).toBe(200);
  });

  it('requires at least one column', () => {
    expect(status(() => generateCreateTable('t', []))).toBe(400);
  });
});

describe('ALTER and DROP', () => {
  it('quotes existing names as given, including ones the strict rules would refuse', () => {
    expect(generateDropColumn('Order Items', 'Unit Price')).toBe(
      'ALTER TABLE "public"."Order Items" DROP COLUMN "Unit Price";',
    );
    expect(generateDropTable('legacy-data')).toBe('DROP TABLE "public"."legacy-data" CASCADE;');
  });

  it('validates the new name on rename and add', () => {
    expect(status(() => generateRenameColumn('t', 'old', 'new name'))).toBe(400);
    expect(generateRenameColumn('t', 'old', 'new_name')).toBe(
      'ALTER TABLE "public"."t" RENAME COLUMN "old" TO "new_name";',
    );
    expect(generateAddColumn('t', { name: 'note', type: 'text', nullable: true })).toBe(
      'ALTER TABLE "public"."t" ADD COLUMN "note" TEXT;',
    );
  });
});
