import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { query } from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';
import { auditService } from '../services/auditService.js';
import { workflowEngine } from '../services/workflowEngine.js';

const router = Router();

// List envelopes for current user
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE e.sender_id = $1';
    const params = [req.user.id];

    if (status) {
      whereClause += ` AND e.status = $${params.length + 1}`;
      params.push(status);
    }

    const countResult = await query(
      `SELECT COUNT(*) as total FROM envelopes e ${whereClause}`,
      params
    );

    params.push(limit, offset);
    const result = await query(
      `SELECT e.*,
              (SELECT COUNT(*) FROM documents d WHERE d.envelope_id = e.id) as document_count,
              (SELECT COUNT(*) FROM recipients r WHERE r.envelope_id = e.id) as recipient_count,
              (SELECT COUNT(*) FROM recipients r WHERE r.envelope_id = e.id AND r.status = 'completed') as completed_count
       FROM envelopes e
       ${whereClause}
       ORDER BY e.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      envelopes: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(countResult.rows[0].total / limit)
      }
    });
  } catch (error) {
    console.error('List envelopes error:', error);
    res.status(500).json({ error: 'Failed to list envelopes' });
  }
});

// Create new envelope
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, message, authenticationLevel = 'email', expirationDate } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Envelope name is required' });
    }

    const envelopeId = uuid();
    const result = await query(
      `INSERT INTO envelopes (id, sender_id, name, message, authentication_level, expiration_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [envelopeId, req.user.id, name, message, authenticationLevel, expirationDate || null]
    );

    const envelope = result.rows[0];

    // Log audit event
    await auditService.log(envelopeId, 'envelope_created', {
      userId: req.user.id,
      userEmail: req.user.email,
      envelopeName: name
    }, req.user.id);

    res.status(201).json({ envelope });
  } catch (error) {
    console.error('Create envelope error:', error);
    res.status(500).json({ error: 'Failed to create envelope' });
  }
});

// Get envelope details
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const envelopeResult = await query(
      `SELECT e.*, u.name as sender_name, u.email as sender_email
       FROM envelopes e
       JOIN users u ON e.sender_id = u.id
       WHERE e.id = $1 AND e.sender_id = $2`,
      [id, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    const envelope = envelopeResult.rows[0];

    // Get documents
    const documentsResult = await query(
      'SELECT * FROM documents WHERE envelope_id = $1 ORDER BY created_at ASC',
      [id]
    );

    // Get recipients
    const recipientsResult = await query(
      'SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order ASC',
      [id]
    );

    // Get fields
    const fieldsResult = await query(
      `SELECT df.*, d.name as document_name, r.name as recipient_name, r.email as recipient_email
       FROM document_fields df
       JOIN documents d ON df.document_id = d.id
       JOIN recipients r ON df.recipient_id = r.id
       WHERE d.envelope_id = $1
       ORDER BY df.page_number ASC, df.y ASC`,
      [id]
    );

    res.json({
      envelope,
      documents: documentsResult.rows,
      recipients: recipientsResult.rows,
      fields: fieldsResult.rows
    });
  } catch (error) {
    console.error('Get envelope error:', error);
    res.status(500).json({ error: 'Failed to get envelope' });
  }
});

// Update envelope
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, message, authenticationLevel, expirationDate } = req.body;

    // Verify ownership and draft status
    const existing = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    if (existing.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Can only edit draft envelopes' });
    }

    const result = await query(
      `UPDATE envelopes
       SET name = COALESCE($2, name),
           message = COALESCE($3, message),
           authentication_level = COALESCE($4, authentication_level),
           expiration_date = COALESCE($5, expiration_date),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, name, message, authenticationLevel, expirationDate]
    );

    res.json({ envelope: result.rows[0] });
  } catch (error) {
    console.error('Update envelope error:', error);
    res.status(500).json({ error: 'Failed to update envelope' });
  }
});

// Send envelope
router.post('/:id/send', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const existing = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    // Send via workflow engine
    await workflowEngine.sendEnvelope(id, req.user.id);

    // Get updated envelope
    const result = await query('SELECT * FROM envelopes WHERE id = $1', [id]);

    res.json({ envelope: result.rows[0], message: 'Envelope sent successfully' });
  } catch (error) {
    console.error('Send envelope error:', error);
    res.status(400).json({ error: error.message || 'Failed to send envelope' });
  }
});

// Void envelope
router.post('/:id/void', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Verify ownership
    const existing = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    await workflowEngine.voidEnvelope(id, reason, req.user.id);

    const result = await query('SELECT * FROM envelopes WHERE id = $1', [id]);

    res.json({ envelope: result.rows[0], message: 'Envelope voided' });
  } catch (error) {
    console.error('Void envelope error:', error);
    res.status(400).json({ error: error.message || 'Failed to void envelope' });
  }
});

// Delete envelope (draft only)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await query(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Envelope not found' });
    }

    if (existing.rows[0].status !== 'draft') {
      return res.status(400).json({ error: 'Can only delete draft envelopes' });
    }

    await query('DELETE FROM envelopes WHERE id = $1', [id]);

    res.json({ message: 'Envelope deleted' });
  } catch (error) {
    console.error('Delete envelope error:', error);
    res.status(500).json({ error: 'Failed to delete envelope' });
  }
});

// Get envelope statistics for dashboard
router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'draft') as draft,
         COUNT(*) FILTER (WHERE status IN ('sent', 'delivered')) as pending,
         COUNT(*) FILTER (WHERE status = 'completed') as completed,
         COUNT(*) FILTER (WHERE status = 'declined') as declined,
         COUNT(*) FILTER (WHERE status = 'voided') as voided,
         COUNT(*) as total
       FROM envelopes
       WHERE sender_id = $1`,
      [req.user.id]
    );

    res.json({ stats: result.rows[0] });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

export default router;
