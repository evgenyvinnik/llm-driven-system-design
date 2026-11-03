import { pool } from './db.js';
import { logger } from './logger.js';
import { canAccess, HttpError, isUuid, type Caller } from './accessPolicy.js';
import { STAGE_PROBABILITY } from './opportunityStages.js';

interface ConversionInput {
  leadId: string;
  accountName?: string;
  opportunityName?: string;
  /** Opportunity amount in cents. */
  opportunityAmountCents?: number;
  closeDate?: string;
  caller: Caller;
}

interface ConversionResult {
  accountId: string;
  contactId: string;
  opportunityId: string | null;
}

/**
 * Converts a lead to account + contact + optional opportunity in a single
 * PostgreSQL transaction.
 *
 * The lead row is read with FOR UPDATE, so two simultaneous conversions of the
 * same lead serialize: the second waits for the first to commit, then sees
 * converted_at set and gets a 409 instead of creating a second account and
 * contact. (A plain SELECT let both pass the converted_at IS NULL check.)
 *
 * The new records belong to the lead's owner, not to whoever clicked Convert,
 * so an admin converting a rep's lead doesn't take the rep's customer.
 */
export async function convertLead(input: ConversionInput): Promise<ConversionResult> {
  if (!isUuid(input.leadId)) throw new HttpError(404, 'Lead not found');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const leadResult = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [
      input.leadId,
    ]);
    const lead = leadResult.rows[0];

    if (!lead || !canAccess(lead, input.caller)) {
      throw new HttpError(404, 'Lead not found');
    }
    if (lead.converted_at) {
      throw new HttpError(409, 'Lead has already been converted');
    }

    const ownerId = lead.owner_id ?? input.caller.userId;

    // Create account
    const accountName = input.accountName || lead.company || `${lead.first_name} ${lead.last_name}`;
    const accountResult = await client.query(
      `INSERT INTO accounts (name, phone, owner_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [accountName, lead.phone, ownerId],
    );
    const accountId = accountResult.rows[0].id;

    // Create contact
    const contactResult = await client.query(
      `INSERT INTO contacts (account_id, first_name, last_name, email, phone, title, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [accountId, lead.first_name, lead.last_name, lead.email, lead.phone, lead.title, ownerId],
    );
    const contactId = contactResult.rows[0].id;

    // Optionally create opportunity. It starts in Qualification, so it gets
    // Qualification's probability (the column default of 10 is Prospecting's).
    let opportunityId: string | null = null;
    if (input.opportunityName) {
      const oppResult = await client.query(
        `INSERT INTO opportunities (account_id, name, amount_cents, stage, probability, close_date, owner_id)
         VALUES ($1, $2, $3, 'Qualification', $4, $5, $6)
         RETURNING id`,
        [
          accountId,
          input.opportunityName,
          input.opportunityAmountCents ?? null,
          STAGE_PROBABILITY.Qualification,
          input.closeDate || null,
          ownerId,
        ],
      );
      opportunityId = oppResult.rows[0].id;
    }

    // The converted_at guard is redundant under FOR UPDATE, but keeps the
    // write itself refusing a double conversion if the lock is ever removed.
    const updateResult = await client.query(
      `UPDATE leads
       SET status = 'Converted',
           converted_account_id = $1,
           converted_contact_id = $2,
           converted_opportunity_id = $3,
           converted_at = NOW(),
           updated_at = NOW()
       WHERE id = $4 AND converted_at IS NULL`,
      [accountId, contactId, opportunityId, input.leadId],
    );
    if (updateResult.rowCount !== 1) {
      throw new HttpError(409, 'Lead has already been converted');
    }

    await client.query('COMMIT');

    logger.info({ leadId: input.leadId, accountId, contactId, opportunityId }, 'Lead converted');

    return { accountId, contactId, opportunityId };
  } catch (err) {
    await client.query('ROLLBACK');
    if (!(err instanceof HttpError)) {
      logger.error({ err, leadId: input.leadId }, 'Lead conversion failed');
    }
    throw err;
  } finally {
    client.release();
  }
}
