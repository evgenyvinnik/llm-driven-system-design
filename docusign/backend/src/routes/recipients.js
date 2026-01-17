import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { query } from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';
import { auditService } from '../services/auditService.js';

const router = Router();

// Add recipient to envelope
router.post('/:envelopeId', authenticate, async (req, res) => {
  try {
    const { envelopeId } = req.params;
    const { name, email, role = 'signer', routingOrder = 1, phone, accessCode } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Verify envelope ownership and status
    const envelopeResult = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    if (envelopeResult.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Can only add recipients to draft envelopes' });
    }

    // Check for duplicate email in envelope
    const existingResult = await query(
      'SELECT id FROM recipients WHERE envelope_id = $1 AND email = $2',
      [envelopeId, email]
    );

    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: 'Recipient with this email already exists in envelope' });
    }

    const recipientId = uuid();
    const result = await query(
      `INSERT INTO recipients (id, envelope_id, name, email, role, routing_order, phone, access_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [recipientId, envelopeId, name, email, role, routingOrder, phone || null, accessCode || null]
    );

    const recipient = result.rows[0];

    // Log audit event
    await auditService.log(envelopeId, 'recipient_added', {
      recipientId,
      name,
      email,
      role,
      routingOrder,
      userId: req.user.id
    }, req.user.id);

    res.status(201).json({ recipient });
  } catch (error) {
    console.error('Add recipient error:', error);
    res.status(500).json({ error: 'Failed to add recipient' });
  }
});

// Get recipients for envelope
router.get('/envelope/:envelopeId', authenticate, async (req, res) => {
  try {
    const { envelopeId } = req.params;

    // Verify envelope ownership
    const envelopeResult = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    const result = await query(
      `SELECT r.*,
              (SELECT COUNT(*) FROM document_fields df
               JOIN documents d ON df.document_id = d.id
               WHERE d.envelope_id = r.envelope_id AND df.recipient_id = r.id) as field_count,
              (SELECT COUNT(*) FROM document_fields df
               JOIN documents d ON df.document_id = d.id
               WHERE d.envelope_id = r.envelope_id AND df.recipient_id = r.id AND df.completed = true) as completed_field_count
       FROM recipients r
       WHERE r.envelope_id = $1
       ORDER BY r.routing_order ASC, r.created_at ASC`,
      [envelopeId]
    );

    res.json({ recipients: result.rows });
  } catch (error) {
    console.error('Get recipients error:', error);
    res.status(500).json({ error: 'Failed to get recipients' });
  }
});

// Update recipient
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, routingOrder, phone, accessCode } = req.body;

    // Verify recipient and envelope ownership
    const recipientResult = await query(
      `SELECT r.*, e.sender_id, e.status as envelope_status
       FROM recipients r
       JOIN envelopes e ON r.envelope_id = e.id
       WHERE r.id = $1`,
      [id]
    );

    if (recipientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const recipient = recipientResult.rows[0];

    if (recipient.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (recipient.envelope_status !== 'draft') {
      return res.status(400).json({ error: 'Can only edit recipients in draft envelopes' });
    }

    // Check for duplicate email if changing
    if (email && email !== recipient.email) {
      const existingResult = await query(
        'SELECT id FROM recipients WHERE envelope_id = $1 AND email = $2 AND id != $3',
        [recipient.envelope_id, email, id]
      );

      if (existingResult.rows.length > 0) {
        return res.status(400).json({ error: 'Recipient with this email already exists in envelope' });
      }
    }

    const result = await query(
      `UPDATE recipients
       SET name = COALESCE($2, name),
           email = COALESCE($3, email),
           role = COALESCE($4, role),
           routing_order = COALESCE($5, routing_order),
           phone = COALESCE($6, phone),
           access_code = COALESCE($7, access_code)
       WHERE id = $1
       RETURNING *`,
      [id, name, email, role, routingOrder, phone, accessCode]
    );

    res.json({ recipient: result.rows[0] });
  } catch (error) {
    console.error('Update recipient error:', error);
    res.status(500).json({ error: 'Failed to update recipient' });
  }
});

// Delete recipient
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify recipient and envelope ownership
    const recipientResult = await query(
      `SELECT r.*, e.sender_id, e.status as envelope_status
       FROM recipients r
       JOIN envelopes e ON r.envelope_id = e.id
       WHERE r.id = $1`,
      [id]
    );

    if (recipientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const recipient = recipientResult.rows[0];

    if (recipient.sender_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (recipient.envelope_status !== 'draft') {
      return res.status(400).json({ error: 'Can only delete recipients from draft envelopes' });
    }

    await query('DELETE FROM recipients WHERE id = $1', [id]);

    res.json({ message: 'Recipient deleted' });
  } catch (error) {
    console.error('Delete recipient error:', error);
    res.status(500).json({ error: 'Failed to delete recipient' });
  }
});

// Reorder recipients
router.post('/envelope/:envelopeId/reorder', authenticate, async (req, res) => {
  try {
    const { envelopeId } = req.params;
    const { recipients } = req.body; // Array of { id, routingOrder }

    if (!Array.isArray(recipients)) {
      return res.status(400).json({ error: 'Recipients array is required' });
    }

    // Verify envelope ownership
    const envelopeResult = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    if (envelopeResult.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Can only reorder recipients in draft envelopes' });
    }

    // Update routing orders
    for (const recipient of recipients) {
      await query(
        'UPDATE recipients SET routing_order = $2 WHERE id = $1 AND envelope_id = $3',
        [recipient.id, recipient.routingOrder, envelopeId]
      );
    }

    // Return updated recipients
    const result = await query(
      'SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order ASC',
      [envelopeId]
    );

    res.json({ recipients: result.rows });
  } catch (error) {
    console.error('Reorder recipients error:', error);
    res.status(500).json({ error: 'Failed to reorder recipients' });
  }
});

export default router;
