/**
 * Authentication Middleware.
 *
 * Two kinds of caller reach the HTTP API:
 * - **Admins** use the console. Login stores a random bearer session in Redis;
 *   `requireAdmin` resolves it.
 * - **Providers** send pushes. They present an ES256 JWT signed with a key an
 *   admin issued (see shared/providerToken). `requireProvider` verifies it and
 *   records which app bundles the key may reach. It also accepts an admin
 *   session so operators can send test pushes from the console.
 *
 * Devices do not use these: they authenticate their WebSocket with the raw
 * device token (see index.ts).
 *
 * @module shared/auth
 */

import { Request, Response, NextFunction } from "express";
import { getSession } from "../db/redis.js";
import { looksLikeJwt, verifyProviderToken } from "./providerToken.js";
import { getActiveProviderKey } from "../services/providerKeys.js";
import { auditAuth } from "./logger.js";

/** Session data stored in Redis at login. */
export interface AdminSession {
  user_id: string;
  username: string;
  role: string;
}

/**
 * The authenticated caller of a provider-facing route.
 * Admins are unscoped; a provider is limited to its key's app bundles.
 */
export type Principal =
  | { kind: "admin"; userId: string; username: string }
  | { kind: "provider"; keyId: string; teamId: string; appBundleIds: string[] };

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAdmin, or by requireProvider for a console session */
      admin?: AdminSession;
      /** Set by requireAdmin and requireProvider */
      principal?: Principal;
    }
  }
}

/** Extracts a bearer token; APNs clients send lowercase "bearer". */
function getBearerToken(req: Request): string | null {
  const match = /^bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  return match ? match[1] : null;
}

function adminPrincipal(session: AdminSession): Principal {
  return { kind: "admin", userId: session.user_id, username: session.username };
}

/**
 * Requires a valid admin console session.
 * Guards every /api/v1/admin route except login and logout.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Authentication required",
      });
      return;
    }

    const session = await getSession<AdminSession>(token);
    if (!session) {
      auditAuth("auth_failure", { ip: req.ip, reason: "invalid_session" });
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or expired session",
      });
      return;
    }

    req.admin = session;
    req.principal = adminPrincipal(session);
    next();
  } catch (error) {
    next(error);
  }
}

const PROVIDER_FAILURE_MESSAGES = {
  MissingProviderToken: "A provider token or admin session is required",
  InvalidProviderToken: "Provider token is invalid, revoked, or unsigned",
  ExpiredProviderToken: "Provider token is older than one hour; sign a new one",
} as const;

type ProviderFailure = keyof typeof PROVIDER_FAILURE_MESSAGES;

/**
 * Requires a provider JWT (or an admin session, for console test sends).
 *
 * @param style - "rest" answers 401 `{error, message}`; "apns" answers the
 *   APNs-style 403 `{reason}` used by the `/3/device` route
 * @returns Express middleware
 */
export function requireProvider(style: "rest" | "apns" = "rest") {
  const reject = (req: Request, res: Response, reason: ProviderFailure) => {
    auditAuth("auth_failure", { ip: req.ip, reason });
    if (style === "apns") {
      res.status(403).json({ reason });
    } else {
      res.status(401).json({
        error: reason,
        message: PROVIDER_FAILURE_MESSAGES[reason],
      });
    }
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = getBearerToken(req);
      if (!token) return reject(req, res, "MissingProviderToken");

      if (looksLikeJwt(token)) {
        const result = await verifyProviderToken(token, getActiveProviderKey);
        if (!result.ok) return reject(req, res, result.reason);
        req.principal = {
          kind: "provider",
          keyId: result.key.key_id,
          teamId: result.key.team_id,
          appBundleIds: result.key.app_bundle_ids,
        };
        return next();
      }

      const session = await getSession<AdminSession>(token);
      if (!session) return reject(req, res, "InvalidProviderToken");
      req.admin = session;
      req.principal = adminPrincipal(session);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * The bundle IDs a caller is limited to.
 *
 * @param principal - Authenticated caller
 * @returns The provider's bundle IDs, or undefined for an unscoped admin
 */
export function allowedBundleIds(principal: Principal | undefined): string[] | undefined {
  return principal?.kind === "provider" ? principal.appBundleIds : undefined;
}

/**
 * Whether a caller may act on data belonging to an app bundle.
 *
 * @param principal - Authenticated caller
 * @param appBundleId - Bundle that owns the device or feedback entry
 * @returns True for admins, or providers whose key covers the bundle
 */
export function canAccessBundle(
  principal: Principal | undefined,
  appBundleId: string
): boolean {
  if (!principal) return false;
  return principal.kind === "admin" || principal.appBundleIds.includes(appBundleId);
}
