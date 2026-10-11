import { query, withTransaction } from '../utils/database.js';
import { urlCache, isCachedUrlLive, CachedUrl } from '../utils/cache.js';
import { SERVER_CONFIG, URL_CONFIG } from '../config.js';
import { Url, CreateUrlInput, UrlResponse, UserPublic } from '../models/types.js';
import { getNextKey, markKeyAsUsed, isCodeAvailable } from './keyService.js';
import { HttpError, PG_UNIQUE_VIOLATION, pgErrorCode } from '../utils/errors.js';
import logger from '../utils/logger.js';

/**
 * Shape every stored short code has (generated codes are 7 base62 characters, custom
 * codes 4-10 of [A-Za-z0-9_-]; the column is VARCHAR(10)). Anything else cannot exist,
 * so the redirect path rejects it without touching Redis or PostgreSQL.
 */
const SHORT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,10}$/;

/**
 * Checks whether a string could be a stored short code.
 * @param code - Candidate code from the request path
 */
export function isWellFormedShortCode(code: string): boolean {
  return SHORT_CODE_PATTERN.test(code);
}

/**
 * Validates that a string is a properly formatted HTTP/HTTPS URL.
 * @param url - The URL string to validate
 * @returns true if valid, false otherwise
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validates a custom short code against format and policy rules.
 * Length matches the urls.short_code VARCHAR(10) column; reserved words are checked
 * case-insensitively because Express routes match case-insensitively.
 * @param code - The custom code to validate
 * @returns Object with valid flag and optional error message
 */
export function validateCustomCode(code: string): { valid: boolean; error?: string } {
  const { customCodeMinLength, customCodeMaxLength } = URL_CONFIG;
  if (code.length < customCodeMinLength) {
    return { valid: false, error: `Custom code must be at least ${customCodeMinLength} characters` };
  }
  if (code.length > customCodeMaxLength) {
    return { valid: false, error: `Custom code must be at most ${customCodeMaxLength} characters` };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
    return { valid: false, error: 'Custom code can only contain letters, numbers, underscores, and hyphens' };
  }
  if (URL_CONFIG.reservedWords.includes(code.toLowerCase())) {
    return { valid: false, error: 'This short code is reserved' };
  }
  return { valid: true };
}

/**
 * Validates the optional expires_in field (seconds from now).
 * Absent/null means "never expires"; anything else must be a positive, bounded number,
 * so a link can never be created already expired.
 * @param expiresIn - Raw value from the request body
 * @returns Parsed seconds (or null for no expiry), or a validation error
 */
export function validateExpiresIn(
  expiresIn: unknown
): { valid: true; seconds: number | null } | { valid: false; error: string } {
  if (expiresIn === undefined || expiresIn === null) {
    return { valid: true, seconds: null };
  }
  const seconds = typeof expiresIn === 'string' && expiresIn.trim() !== '' ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return { valid: false, error: 'expires_in must be a positive number of seconds' };
  }
  if (seconds > URL_CONFIG.maxExpiresInSeconds) {
    return { valid: false, error: `expires_in must be at most ${URL_CONFIG.maxExpiresInSeconds} seconds` };
  }
  return { valid: true, seconds };
}

/**
 * Converts a database URL row to API response format.
 * Constructs the full short URL from the base URL and short code.
 * @param url - The database URL model
 * @returns Formatted URL response for API clients
 */
function toUrlResponse(url: Url): UrlResponse {
  return {
    short_url: `${SERVER_CONFIG.baseUrl}/${url.short_code}`,
    short_code: url.short_code,
    long_url: url.long_url,
    created_at: url.created_at.toISOString(),
    expires_at: url.expires_at ? url.expires_at.toISOString() : null,
    // BIGINT arrives from node-postgres as a string
    click_count: Number(url.click_count),
    is_custom: url.is_custom,
    is_active: url.is_active,
  };
}

/**
 * Builds the redirect cache entry for a row.
 * @param url - Row with destination and expiry
 */
function toCachedUrl(url: Pick<Url, 'long_url' | 'expires_at'>): CachedUrl {
  return {
    url: url.long_url,
    expiresAt: url.expires_at ? url.expires_at.getTime() : null,
  };
}

/**
 * Inserts the urls row and, for pool keys, marks the key used, in ONE transaction.
 * Either both happen or neither does, so a failure can no longer leave a live link whose
 * key is still leasable (or report an error for a link that was actually created).
 * @returns The inserted row
 * @throws The pg error (code 23505 on a short code collision)
 */
async function insertUrl(
  shortCode: string,
  longUrl: string,
  userId: string | null,
  expiresAt: Date | null,
  isCustom: boolean
): Promise<Url> {
  return withTransaction(async (client) => {
    const result = await client.query<Url>(
      `INSERT INTO urls (short_code, long_url, user_id, expires_at, is_custom)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [shortCode, longUrl, userId, expiresAt, isCustom]
    );

    if (!isCustom) {
      await markKeyAsUsed(shortCode, client);
    }

    return result.rows[0];
  });
}

/**
 * Creates a link with a pool-generated code, retrying with a fresh code when the
 * urls primary key reports a collision (a custom code, random fallback, or reclaimed
 * lease that is already taken). Bounded by URL_CONFIG.maxCreateAttempts.
 */
async function insertWithGeneratedCode(
  longUrl: string,
  userId: string | null,
  expiresAt: Date | null
): Promise<Url> {
  for (let attempt = 1; ; attempt++) {
    const shortCode = await getNextKey();
    try {
      return await insertUrl(shortCode, longUrl, userId, expiresAt, false);
    } catch (error) {
      if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) {
        throw error;
      }

      logger.warn({ short_code: shortCode, attempt }, 'Generated short code collided, retrying');
      // The code exists in urls already: make sure no instance leases it again.
      await markKeyAsUsed(shortCode).catch((markError) => {
        logger.error({ err: markError, short_code: shortCode }, 'Failed to retire collided key');
      });

      if (attempt >= URL_CONFIG.maxCreateAttempts) {
        throw new HttpError(503, 'Could not allocate a unique short code, please retry');
      }
    }
  }
}

/**
 * Creates a new shortened URL.
 * Handles both auto-generated and custom short codes.
 * Validates input, persists to database, and caches the mapping.
 * @param input - URL creation parameters
 * @returns Promise resolving to the created URL response
 * @throws HttpError(400) on invalid input, HttpError(409) if the custom code is taken
 */
export async function createUrl(input: CreateUrlInput): Promise<UrlResponse> {
  const { long_url, custom_code, expires_in, user_id } = input;

  // Validate URL
  if (typeof long_url !== 'string' || !isValidUrl(long_url)) {
    throw new HttpError(400, 'Invalid URL format');
  }

  if (long_url.length > URL_CONFIG.maxUrlLength) {
    throw new HttpError(400, `URL exceeds maximum length of ${URL_CONFIG.maxUrlLength} characters`);
  }

  const expiry = validateExpiresIn(expires_in);
  if (!expiry.valid) {
    throw new HttpError(400, expiry.error);
  }
  const expiresAt = expiry.seconds === null ? null : new Date(Date.now() + expiry.seconds * 1000);

  let created: Url;

  if (custom_code !== undefined && custom_code !== null && custom_code !== '') {
    if (typeof custom_code !== 'string') {
      throw new HttpError(400, 'custom_code must be a string');
    }

    const validation = validateCustomCode(custom_code);
    if (!validation.valid) {
      throw new HttpError(400, validation.error ?? 'Invalid custom code');
    }

    // Friendly pre-check (also rejects codes still sitting in the key pool); the primary
    // key below is what actually closes the check-then-insert race.
    const available = await isCodeAvailable(custom_code);
    if (!available) {
      throw new HttpError(409, 'This custom code is already taken');
    }

    try {
      created = await insertUrl(custom_code, long_url, user_id ?? null, expiresAt, true);
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        throw new HttpError(409, 'This custom code is already taken');
      }
      throw error;
    }
  } else {
    created = await insertWithGeneratedCode(long_url, user_id ?? null, expiresAt);
  }

  // Warm the redirect cache and clear any "not found" entry left by earlier probes.
  await urlCache.prime(created.short_code, toCachedUrl(created));

  return toUrlResponse(created);
}

/**
 * Outcome of resolving a short code on the redirect path.
 * `source` says which tier answered: Redis (positive or negative entry), PostgreSQL,
 * or the syntax check for codes that cannot exist.
 */
export type RedirectResolution =
  | { found: true; longUrl: string; source: 'cache' | 'database' }
  | { found: false; source: 'cache' | 'database' | 'invalid' };

/**
 * Database reads in flight on this instance, keyed by short code (single-flight).
 */
const inflightLookups = new Map<string, Promise<CachedUrl | null>>();

/**
 * Reads a redirectable link from PostgreSQL and back-fills the cache.
 * Concurrent misses for the same code on this instance share one query, so a hot link
 * whose cache entry just expired produces one database read, not one per request.
 * Cache writes are fire-and-forget: they never delay the redirect.
 * @param shortCode - Code to load
 * @returns Destination and expiry, or null if the code does not resolve
 */
function loadForRedirect(shortCode: string): Promise<CachedUrl | null> {
  const existing = inflightLookups.get(shortCode);
  if (existing) {
    return existing;
  }

  const lookup = (async (): Promise<CachedUrl | null> => {
    const rows = await query<Pick<Url, 'long_url' | 'expires_at'>>(
      `SELECT long_url, expires_at FROM urls
       WHERE short_code = $1
       AND is_active = true
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [shortCode]
    );

    if (rows.length === 0) {
      void urlCache.fillNegative(shortCode);
      return null;
    }

    const entry = toCachedUrl(rows[0]);
    void urlCache.fill(shortCode, entry);
    return entry;
  })().finally(() => {
    inflightLookups.delete(shortCode);
  });

  inflightLookups.set(shortCode, lookup);
  return lookup;
}

/**
 * Resolves a short code for a redirect. This is the only lookup the redirect route uses.
 * Order: syntax check, Redis (positive entry with expiry enforced, then negative entry),
 * then a single-flight PostgreSQL read that only returns active, unexpired links.
 * @param shortCode - The short code to look up
 * @returns Resolution with the destination when found
 */
export async function resolveShortCode(shortCode: string): Promise<RedirectResolution> {
  if (!isWellFormedShortCode(shortCode)) {
    return { found: false, source: 'invalid' };
  }

  const cached = await urlCache.lookup(shortCode);
  if (cached.entry) {
    if (isCachedUrlLive(cached.entry, Date.now())) {
      return { found: true, longUrl: cached.entry.url, source: 'cache' };
    }
    // Cached before it expired; the TTL is about to remove it.
    return { found: false, source: 'cache' };
  }
  if (cached.negative) {
    return { found: false, source: 'cache' };
  }

  const entry = await loadForRedirect(shortCode);
  return entry
    ? { found: true, longUrl: entry.url, source: 'database' }
    : { found: false, source: 'database' };
}

/**
 * Retrieves full URL details for display or management.
 * Optionally filters by user ID for ownership verification.
 * @param shortCode - The short code to look up
 * @param userId - Optional user ID to filter by ownership
 * @returns Promise resolving to URL response or null if not found
 */
export async function getUrlDetails(shortCode: string, userId?: string): Promise<UrlResponse | null> {
  let queryText = `SELECT * FROM urls WHERE short_code = $1`;
  const params: (string | undefined)[] = [shortCode];

  if (userId) {
    queryText += ` AND user_id = $2`;
    params.push(userId);
  }

  const result = await query<Url>(queryText, params);

  if (result.length === 0) {
    return null;
  }

  return toUrlResponse(result[0]);
}

/**
 * Looks up who owns a link (null for links created anonymously).
 * @param shortCode - The short code to look up
 * @returns The owner row, or null if the code does not exist
 */
export async function getUrlOwner(shortCode: string): Promise<{ user_id: string | null } | null> {
  const rows = await query<{ user_id: string | null }>(
    `SELECT user_id FROM urls WHERE short_code = $1`,
    [shortCode]
  );
  return rows[0] ?? null;
}

/**
 * Owner-or-admin rule for per-link data such as analytics (which include raw IPs and
 * user agents). Anonymous links have no owner, so only admins can read them.
 * @param ownerId - The link's user_id
 * @param user - The authenticated user
 */
export function canAccessUrl(ownerId: string | null, user: Pick<UserPublic, 'id' | 'role'> | undefined): boolean {
  if (!user) {
    return false;
  }
  if (user.role === 'admin') {
    return true;
  }
  return ownerId !== null && ownerId === user.id;
}

/**
 * Retrieves paginated list of URLs for a user.
 * Used by the dashboard to display the user's created URLs.
 * @param userId - The user's ID
 * @param limit - Maximum number of URLs to return (default: 50)
 * @param offset - Number of URLs to skip (default: 0)
 * @returns Promise resolving to URLs array and total count
 */
export async function getUserUrls(
  userId: string,
  limit: number = 50,
  offset: number = 0
): Promise<{ urls: UrlResponse[]; total: number }> {
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM urls WHERE user_id = $1`,
    [userId]
  );

  const result = await query<Url>(
    `SELECT * FROM urls
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  return {
    urls: result.map(toUrlResponse),
    total: parseInt(countResult[0].count, 10),
  };
}

/**
 * Updates a URL's active status or expiration.
 * Any change invalidates the redirect cache: deactivation must stop redirects, and an
 * expiry change alters what the cached entry is allowed to serve.
 * @param shortCode - The short code of the URL to update
 * @param userId - The owner's user ID (for authorization)
 * @param updates - Object with optional is_active and expires_at (null clears the expiry)
 * @returns Promise resolving to updated URL or null if not found/unauthorized
 */
export async function updateUrl(
  shortCode: string,
  userId: string,
  updates: { is_active?: boolean; expires_at?: Date | null }
): Promise<UrlResponse | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (updates.is_active !== undefined) {
    setClauses.push(`is_active = $${paramIndex++}`);
    params.push(updates.is_active);
  }

  if (updates.expires_at !== undefined) {
    setClauses.push(`expires_at = $${paramIndex++}`);
    params.push(updates.expires_at);
  }

  if (setClauses.length === 0) {
    return getUrlDetails(shortCode, userId);
  }

  params.push(shortCode, userId);

  const result = await query<Url>(
    `UPDATE urls
     SET ${setClauses.join(', ')}
     WHERE short_code = $${paramIndex++} AND user_id = $${paramIndex}
     RETURNING *`,
    params
  );

  if (result.length === 0) {
    return null;
  }

  await urlCache.invalidate(shortCode);

  return toUrlResponse(result[0]);
}

/**
 * Soft-deletes a URL by marking it inactive.
 * Removes the URL from cache to prevent further redirects.
 * @param shortCode - The short code of the URL to delete
 * @param userId - The owner's user ID (for authorization)
 * @returns Promise resolving to true if deleted, false if not found
 */
export async function deleteUrl(shortCode: string, userId: string): Promise<boolean> {
  const result = await query<Url>(
    `UPDATE urls SET is_active = false WHERE short_code = $1 AND user_id = $2 RETURNING *`,
    [shortCode, userId]
  );

  if (result.length > 0) {
    await urlCache.invalidate(shortCode);
    return true;
  }

  return false;
}
