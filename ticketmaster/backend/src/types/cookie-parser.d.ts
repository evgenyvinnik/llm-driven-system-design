declare module 'cookie-parser' {
  import { RequestHandler } from 'express';

  interface CookieParseOptions {
    decode?: (val: string) => string;
  }

  function cookieParser(secret?: string | string[], options?: CookieParseOptions): RequestHandler;

  export = cookieParser;
}

declare namespace Express {
  export interface Request {
    cookies: { [key: string]: string };
    signedCookies: { [key: string]: string };
  }
}
