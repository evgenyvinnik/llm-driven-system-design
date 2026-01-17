declare module 'cookie-parser' {
  import { RequestHandler } from 'express';

  function cookieParser(secret?: string | string[], options?: cookieParser.CookieParseOptions): RequestHandler;

  namespace cookieParser {
    interface CookieParseOptions {
      decode?(val: string): string;
    }

    function JSONCookie(str: string): object | undefined;
    function JSONCookies<T extends { [key: string]: string }>(obj: T): { [P in keyof T]: object | undefined };
    function signedCookie(str: string, secret: string | string[]): string | false;
    function signedCookies<T extends { [key: string]: string }>(obj: T, secret: string | string[]): { [P in keyof T]?: string };
  }

  export = cookieParser;
}

declare global {
  namespace Express {
    interface Request {
      cookies: { [key: string]: string };
      signedCookies: { [key: string]: string };
    }
  }
}
