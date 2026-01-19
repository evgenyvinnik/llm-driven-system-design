import type { Logger } from 'pino';
import type { UserPublic } from './index.js';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      log?: Logger;
      user?: UserPublic;
    }
  }
}

export {};
