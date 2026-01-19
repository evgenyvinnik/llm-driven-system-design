import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { query } from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';
import { auditService } from '../services/auditService.js';
import { workflowEngine } from '../services/workflowEngine.js';

const router = Router();

interface EnvelopeRow {
  id: string;
  sender_id: string;
  name: string;
  message: string | null;
  status: string;
  authentication_level: string;
  expiration_date: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  sender_name?: string;
  sender_email?: string;
  document_count?: string;
  recipient_count?: string;
  completed_count?: string;
}

interface CountRow {
  total: string;
}

interface StatsRow {
  draft: string;
  pending: string;
  completed: string;
  declined: string;
  voided: string;
  total: string;
}

interface DocumentRow {
  id: string;
  envelope_id: string;
  name: string;
  page_count: number;
  s3_key: string;
  status: string;
  file_size: number;
  created_at: string;
}

interface RecipientRow {
  id: string;
  envelope_id: string;
  name: string;
  email: string;
  role: string;
  routing_order: number;
  status: string;
  access_token: string;
  created_at: string;
}

interface FieldRow {
  id: string;
  document_id: string;
  recipient_id: string;
  type: string;
  page_number: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  completed: boolean;
  document_name?: string;
  recipient_name?: string;
  recipient_email?: string;
}

// List envelopes for current user
router.get('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, page = '1', limit = '20' } = req.query as { status?: string; page?: string; limit?: string };
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    let whereClause = 'WHERE e.sender_id = $1';
    const params: unknown[] = [req.user.id];

    if (status) {
      whereClause += ` AND e.status = $${params.length + 1}`;
      params.push(status);
    }

    const countResult = await query<CountRow>(
      `SELECT COUNT(*) as total FROM envelopes e ${whereClause}`,
      params
    );

    params.push(limitNum, offset);
    const result = await query<EnvelopeRow>(
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
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(parseInt(countResult.rows[0].total) / limitNum)
      }
    });
  } catch (error) {
    console.error('List envelopes error:', error);
    res.status(500).json({ error: 'Failed to list envelopes' });
  }
});

// Create new envelope
router.post('/', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, message, authenticationLevel = 'email', expirationDate } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Envelope name is required' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const envelopeId = uuid();
    const result = await query<EnvelopeRow>(
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
router.get('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const envelopeResult = await query<EnvelopeRow>(
      `SELECT e.*, u.name as sender_name, u.email as sender_email
       FROM envelopes e
       JOIN users u ON e.sender_id = u.id
       WHERE e.id = $1 AND e.sender_id = $2`,
      [id, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    const envelope = envelopeResult.rows[0];

    // Get documents
    const documentsResult = await query<DocumentRow>(
      'SELECT * FROM documents WHERE envelope_id = $1 ORDER BY created_at ASC',
      [id]
    );

    // Get recipients
    const recipientsResult = await query<RecipientRow>(
      'SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order ASC',
      [id]
    );

    // Get fields
    const fieldsResult = await query<FieldRow>(
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
router.put('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, message, authenticationLevel, expirationDate } = req.body;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify ownership and draft status
    const existing = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    if (existing.rows[0].status !== 'draft') {
      res.status(400).json({ error: 'Can only edit draft envelopes' });
      return;
    }

    const result = await query<EnvelopeRow>(
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
router.post('/:id/send', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify ownership
    const existing = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    // Send via workflow engine
    await workflowEngine.sendEnvelope(id, req.user.id);

    // Get updated envelope
    const result = await query<EnvelopeRow>('SELECT * FROM envelopes WHERE id = $1', [id]);

    res.json({ envelope: result.rows[0], message: 'Envelope sent successfully' });
  } catch (error) {
    const err = error as Error;
    console.error('Send envelope error:', err);
    res.status(400).json({ error: err.message || 'Failed to send envelope' });
  }
});

// Void envelope
router.post('/:id/void', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify ownership
    const existing = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    await workflowEngine.voidEnvelope(id, reason, req.user.id);

    const result = await query<EnvelopeRow>('SELECT * FROM envelopes WHERE id = $1', [id]);

    res.json({ envelope: result.rows[0], message: 'Envelope voided' });
  } catch (error) {
    const err = error as Error;
    console.error('Void envelope error:', err);
    res.status(400).json({ error: err.message || 'Failed to void envelope' });
  }
});

// Delete envelope (draft only)
router.delete('/:id', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const existing = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    if (existing.rows[0].status !== 'draft') {
      res.status(400).json({ error: 'Can only delete draft envelopes' });
      return;
    }

    await query('DELETE FROM envelopes WHERE id = $1', [id]);

    res.json({ message: 'Envelope deleted' });
  } catch (error) {
    console.error('Delete envelope error:', error);
    res.status(500).json({ error: 'Failed to delete envelope' });
  }
});

// Get envelope statistics for dashboard
router.get('/stats/summary', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await query<StatsRow>(
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
