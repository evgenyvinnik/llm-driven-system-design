import { Router, Request, Response } from 'express';
import { query } from '../db/pool.js';
import { authenticateApiKey, AuthenticatedRequest } from '../middleware/auth.js';
import { getWebhookEvents, retryWebhook, verifySignature, WebhookEventRow } from '../services/webhooks.js';
import { generateWebhookSecret } from '../utils/helpers.js';

const router = Router();

// Interfaces
interface MerchantWebhookRow {
  webhook_url: string | null;
  webhook_secret: string | null;
}

interface WebhookEventResponse {
  id: string;
  type: string;
  data: Record<string, unknown>;
  status: string;
  attempts: number;
  last_error: string | null;
  delivered_at: Date | null;
  created: number;
}

/**
 * List webhook events for merchant
 * GET /v1/webhook_events
 */
router.get('/events', authenticateApiKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { limit = '50', offset = '0' } = req.query as { limit?: string; offset?: string };
    const events = await getWebhookEvents(req.merchantId!, parseInt(limit), parseInt(offset));

    res.json({
      object: 'list',
      data: events.map((e: WebhookEventRow): WebhookEventResponse => ({
        id: e.id,
        type: e.type,
        data: e.data as unknown as Record<string, unknown>,
        status: e.status,
        attempts: e.attempts,
        last_error: e.last_error,
        delivered_at: e.delivered_at,
        created: Math.floor(new Date(e.created_at).getTime() / 1000),
      })),
    });
  } catch (error) {
    console.error('List webhook events error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to list webhook events',
      },
    });
  }
});

/**
 * Retry a failed webhook
 * POST /v1/webhook_events/:id/retry
 */
router.post('/events/:id/retry', authenticateApiKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Verify event belongs to merchant
    const eventResult = await query<{ id: string }>(`
      SELECT * FROM webhook_events
      WHERE id = $1 AND merchant_id = $2
    `, [req.params.id, req.merchantId]);

    if (eventResult.rows.length === 0) {
      res.status(404).json({
        error: {
          type: 'invalid_request_error',
          message: 'Webhook event not found',
        },
      });
      return;
    }

    const signature = req.headers['stripe-signature'];
    const _signatureStr = Array.isArray(signature) ? signature[0] : signature;
    const result = await retryWebhook(req.params.id as string);
    res.json(result);
  } catch (error) {
    console.error('Retry webhook error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to retry webhook',
      },
    });
  }
});

/**
 * Update webhook endpoint settings
 * POST /v1/webhook_endpoints
 */
router.post('/endpoints', authenticateApiKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { url } = req.body as { url?: string };

    if (!url) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Webhook URL is required',
          param: 'url',
        },
      });
      return;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid webhook URL format',
          param: 'url',
        },
      });
      return;
    }

    // Generate new secret if not exists
    const merchantResult = await query<MerchantWebhookRow>(`
      SELECT webhook_secret FROM merchants WHERE id = $1
    `, [req.merchantId]);

    let webhookSecret = merchantResult.rows[0]?.webhook_secret;
    if (!webhookSecret) {
      webhookSecret = generateWebhookSecret();
    }

    // Update merchant
    await query(`
      UPDATE merchants
      SET webhook_url = $2, webhook_secret = $3
      WHERE id = $1
    `, [req.merchantId, url, webhookSecret]);

    res.json({
      object: 'webhook_endpoint',
      url,
      secret: webhookSecret,
      enabled: true,
    });
  } catch (error) {
    console.error('Update webhook endpoint error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to update webhook endpoint',
      },
    });
  }
});

/**
 * Get webhook endpoint settings
 * GET /v1/webhook_endpoints
 */
router.get('/endpoints', authenticateApiKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await query<MerchantWebhookRow>(`
      SELECT webhook_url, webhook_secret FROM merchants WHERE id = $1
    `, [req.merchantId]);

    const merchant = result.rows[0];

    if (!merchant.webhook_url) {
      res.json({
        object: 'webhook_endpoint',
        url: null,
        secret: null,
        enabled: false,
      });
      return;
    }

    res.json({
      object: 'webhook_endpoint',
      url: merchant.webhook_url,
      secret: merchant.webhook_secret,
      enabled: true,
    });
  } catch (error) {
    console.error('Get webhook endpoint error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to get webhook endpoint',
      },
    });
  }
});

/**
 * Delete webhook endpoint
 * DELETE /v1/webhook_endpoints
 */
router.delete('/endpoints', authenticateApiKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    await query(`
      UPDATE merchants
      SET webhook_url = NULL, webhook_secret = NULL
      WHERE id = $1
    `, [req.merchantId]);

    res.json({
      object: 'webhook_endpoint',
      deleted: true,
    });
  } catch (error) {
    console.error('Delete webhook endpoint error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to delete webhook endpoint',
      },
    });
  }
});

/**
 * Test webhook verification helper (for demo/testing)
 * POST /v1/webhooks/verify
 */
router.post('/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    const signature = req.headers['stripe-signature'] as string | undefined;
    const { secret } = req.query as { secret?: string };

    if (!signature || !secret) {
      res.status(400).json({
        error: {
          type: 'invalid_request_error',
          message: 'Signature header and secret are required',
        },
      });
      return;
    }

    const isValid = verifySignature(req.body, signature, secret);

    res.json({
      valid: isValid,
      message: isValid ? 'Signature verified successfully' : 'Invalid signature',
    });
  } catch (error) {
    console.error('Verify webhook error:', error);
    res.status(500).json({
      error: {
        type: 'api_error',
        message: 'Failed to verify webhook',
      },
    });
  }
});

export default router;
