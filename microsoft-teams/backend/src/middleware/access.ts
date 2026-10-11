import { Request, RequestHandler } from 'express';
import {
  canReadChannel,
  getChannelAccess,
  getMessageAccess,
  type ChannelAccess,
  type MessageAccess,
} from '../services/access.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      channelAccess?: ChannelAccess;
      messageAccess?: MessageAccess;
    }
  }
}

/**
 * Loads the caller's access to the channel a request names and rejects anyone who cannot read
 * it. "No such channel" and "not allowed" both answer 404, so private channels and other
 * tenants' channels cannot be discovered by probing ids. Every channel-scoped route goes through
 * this middleware, so a new endpoint cannot quietly skip the check.
 */
export function requireChannelAccess(channelIdFrom: (req: Request) => unknown): RequestHandler {
  return async (req, res, next) => {
    try {
      const channelId = channelIdFrom(req);
      if (typeof channelId !== 'string' || channelId === '') {
        res.status(400).json({ error: 'channelId is required' });
        return;
      }
      const access = await getChannelAccess(req.session.userId!, channelId);
      if (!access || !canReadChannel(access)) {
        res.status(404).json({ error: 'Channel not found' });
        return;
      }
      req.channelAccess = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The same check for routes that name a message: resolves its channel, then applies the rule. */
export function requireMessageAccess(messageIdFrom: (req: Request) => unknown): RequestHandler {
  return async (req, res, next) => {
    try {
      const messageId = messageIdFrom(req);
      if (typeof messageId !== 'string' || messageId === '') {
        res.status(400).json({ error: 'messageId is required' });
        return;
      }
      const access = await getMessageAccess(req.session.userId!, messageId);
      if (!access || !canReadChannel(access)) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      req.messageAccess = access;
      req.channelAccess = access;
      next();
    } catch (err) {
      next(err);
    }
  };
}
