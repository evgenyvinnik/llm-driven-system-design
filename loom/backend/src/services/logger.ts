import pino from 'pino';
import { config } from '../config/index.js';

/** Pino logger instance configured for the current environment. */
export const logger = pino({
  level: config.nodeEnv === 'test' ? 'silent' : 'info',
  // Session cookies, share-grant cookies and passwords are credentials; never log them.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
    ],
    censor: '[redacted]',
  },
  transport:
    config.nodeEnv === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});

/**
 * Share tokens are capabilities, so they are masked in logged URLs, and query strings
 * are dropped entirely.
 */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const path = url.split('?')[0];
  return path.replace(/^\/api\/share\/([^/]+)/, (_match, segment: string) =>
    `/api/share/${segment.slice(0, 4)}...`,
  );
}
