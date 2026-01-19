import { Logger } from 'pino';

// User from database
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

// Signing session data
export interface SignerData {
  id: string;
  envelope_id: string;
  email: string;
  name: string;
  status: string;
  envelope_status: string;
  envelope_name: string;
  [key: string]: unknown;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      token?: string;
      signer?: SignerData;
      accessToken?: string;
      log?: Logger;
      idempotencyKey?: string;
    }
  }
}
