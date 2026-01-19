import { Router, Request, Response } from 'express';
import { query } from '../utils/db.js';
import { authenticate } from '../middleware/auth.js';
import { auditService } from '../services/auditService.js';

const router = Router();

interface EnvelopeRow {
  id: string;
  sender_id: string;
  name: string;
  status: string;
  completed_at: string | null;
}

interface SignerRow {
  name: string;
  email: string;
  completed_at: string | null;
}

interface FormattedEvent {
  id: string;
  type: string;
  timestamp: string;
  actor: string | null;
  details: string;
  data: Record<string, unknown>;
  hash: string;
}

interface FormattedSigner {
  name: string;
  email: string;
  signedAt: string | null;
}

// Get audit events for envelope
router.get('/envelope/:envelopeId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { envelopeId } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify envelope ownership
    const envelopeResult = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    const events = await auditService.getEvents(envelopeId);

    // Format events for display
    const formattedEvents: FormattedEvent[] = events.map(e => ({
      id: e.id,
      type: e.event_type,
      timestamp: e.timestamp,
      actor: e.actor,
      details: auditService.formatEventDetails(e),
      data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data,
      hash: e.hash
    }));

    res.json({ events: formattedEvents });
  } catch (error) {
    console.error('Get audit events error:', error);
    res.status(500).json({ error: 'Failed to get audit events' });
  }
});

// Verify audit chain integrity
router.get('/verify/:envelopeId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { envelopeId } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify envelope ownership
    const envelopeResult = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    const verification = await auditService.verifyChain(envelopeId);

    res.json({ verification });
  } catch (error) {
    console.error('Verify chain error:', error);
    res.status(500).json({ error: 'Failed to verify audit chain' });
  }
});

// Get certificate of completion data
router.get('/certificate/:envelopeId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { envelopeId } = req.params;

    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Verify envelope ownership
    const envelopeResult = await query<EnvelopeRow>(
      'SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2',
      [envelopeId, req.user.id]
    );

    if (envelopeResult.rows.length === 0) {
      res.status(404).json({ error: 'Envelope not found' });
      return;
    }

    const envelope = envelopeResult.rows[0];

    if (envelope.status !== 'completed') {
      res.status(400).json({ error: 'Certificate only available for completed envelopes' });
      return;
    }

    const certificate = await auditService.generateCertificateData(envelopeId);

    res.json({ certificate });
  } catch (error) {
    console.error('Get certificate error:', error);
    res.status(500).json({ error: 'Failed to get certificate' });
  }
});

// Public endpoint to verify document signature (by envelope ID or hash)
router.get('/public/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    const { envelopeId, hash } = req.query as { envelopeId?: string; hash?: string };

    if (!envelopeId && !hash) {
      res.status(400).json({ error: 'envelopeId or hash is required' });
      return;
    }

    let envelope: EnvelopeRow | undefined;

    if (envelopeId) {
      const result = await query<EnvelopeRow>(
        'SELECT id, name, status, completed_at FROM envelopes WHERE id = $1',
        [envelopeId]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Envelope not found' });
        return;
      }

      envelope = result.rows[0];
    } else {
      // Find envelope by any audit event hash
      const result = await query<EnvelopeRow>(
        `SELECT e.id, e.name, e.status, e.completed_at
         FROM audit_events ae
         JOIN envelopes e ON ae.envelope_id = e.id
         WHERE ae.hash = $1
         LIMIT 1`,
        [hash]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'No document found with this hash' });
        return;
      }

      envelope = result.rows[0];
    }

    // Verify chain integrity
    const verification = await auditService.verifyChain(envelope.id);

    // Get signer summary
    const signersResult = await query<SignerRow>(
      `SELECT name, email, completed_at
       FROM recipients
       WHERE envelope_id = $1 AND status = 'completed'
       ORDER BY completed_at ASC`,
      [envelope.id]
    );

    const formattedSigners: FormattedSigner[] = signersResult.rows.map(s => ({
      name: s.name,
      email: s.email.replace(/(.{2}).*@/, '$1***@'), // Partially mask email
      signedAt: s.completed_at
    }));

    res.json({
      envelope: {
        id: envelope.id,
        name: envelope.name,
        status: envelope.status,
        completedAt: envelope.completed_at
      },
      verification,
      signers: formattedSigners
    });
  } catch (error) {
    console.error('Public verify error:', error);
    res.status(500).json({ error: 'Failed to verify' });
  }
});

export default router;
