import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = { query: vi.fn(), release: vi.fn() };
vi.mock('./db.js', () => ({ pool: { connect: vi.fn(async () => client), query: vi.fn() } }));

import { convertLead } from './leadConversionService.js';
import { HttpError } from './accessPolicy.js';

const LEAD_ID = '1ead0003-0000-0000-0000-000000000003';
const BOB = 'b2222222-2222-2222-2222-222222222222';
const ALICE = 'a1111111-1111-1111-1111-111111111111';
const lead = {
  id: LEAD_ID, first_name: 'Jonah', last_name: 'Bright', email: 'j@x.test', phone: '1', title: 'Ops',
  company: 'Quay Marine', owner_id: BOB, converted_at: null,
};

/** Scripts client.query by statement, returning `lead` for the locking SELECT. */
function scriptQueries(leadRow: object | undefined, updateRowCount = 1) {
  client.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT * FROM leads')) return { rows: leadRow ? [leadRow] : [] };
    if (sql.includes('INSERT INTO accounts')) return { rows: [{ id: 'acc-new' }] };
    if (sql.includes('INSERT INTO contacts')) return { rows: [{ id: 'con-new' }] };
    if (sql.includes('INSERT INTO opportunities')) return { rows: [{ id: 'opp-new' }] };
    if (sql.includes('UPDATE leads')) return { rows: [], rowCount: updateRowCount };
    return { rows: [] };
  });
}

const statements = () => client.query.mock.calls.map((c) => String(c[0]));

async function statusOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
}

describe('convertLead', () => {
  beforeEach(() => {
    client.query.mockReset();
    client.release.mockReset();
  });

  it('locks the lead row, creates all records in one transaction, and commits', async () => {
    scriptQueries(lead);
    const result = await convertLead({
      leadId: LEAD_ID, opportunityName: 'Quay - Fleet', opportunityAmountCents: 4200000, caller: { userId: BOB, role: 'user' },
    });

    expect(result).toEqual({ accountId: 'acc-new', contactId: 'con-new', opportunityId: 'opp-new' });
    const sql = statements();
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toMatch(/FOR UPDATE/);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.find((s) => s.includes('UPDATE leads'))).toMatch(/converted_at IS NULL/);
    expect(client.release).toHaveBeenCalled();
  });

  it('gives the opportunity Qualification probability (20, not the column default 10)', async () => {
    scriptQueries(lead);
    await convertLead({ leadId: LEAD_ID, opportunityName: 'Quay - Fleet', caller: { userId: BOB } });
    const oppInsert = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO opportunities'));
    expect(oppInsert?.[1]).toContain(20);
  });

  it("assigns the new records to the lead's owner when an admin converts it", async () => {
    scriptQueries(lead);
    await convertLead({ leadId: LEAD_ID, caller: { userId: ALICE, role: 'admin' } });
    const accountInsert = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO accounts'));
    expect(accountInsert?.[1]).toContain(BOB);
    expect(accountInsert?.[1]).not.toContain(ALICE);
  });

  it("hides another rep's lead (404) and rolls back", async () => {
    scriptQueries({ ...lead, owner_id: ALICE });
    expect(await statusOf(convertLead({ leadId: LEAD_ID, caller: { userId: BOB, role: 'user' } }))).toBe(404);
    expect(statements()).toContain('ROLLBACK');
    expect(statements().some((s) => s.includes('INSERT'))).toBe(false);
  });

  it('refuses a second conversion with 409 and creates nothing', async () => {
    scriptQueries({ ...lead, converted_at: new Date() });
    expect(await statusOf(convertLead({ leadId: LEAD_ID, caller: { userId: BOB } }))).toBe(409);
    expect(statements().some((s) => s.includes('INSERT'))).toBe(false);
    expect(statements()).toContain('ROLLBACK');
  });

  it('rolls back everything if the guarded UPDATE finds the lead already converted', async () => {
    scriptQueries(lead, 0);
    expect(await statusOf(convertLead({ leadId: LEAD_ID, caller: { userId: BOB } }))).toBe(409);
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
  });

  it('rejects a malformed lead id before touching the database', async () => {
    expect(await statusOf(convertLead({ leadId: 'nope', caller: { userId: BOB } }))).toBe(404);
    expect(client.query).not.toHaveBeenCalled();
  });
});
