import { query } from '../utils/database.js';
import { urlCache } from '../utils/cache.js';
import { SERVER_CONFIG, URL_CONFIG } from '../config.js';
import { Url, CreateUrlInput, UrlResponse } from '../models/types.js';
import { getNextKey, markKeyAsUsed, isCodeAvailable } from './keyService.js';

// Validate URL format
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// Validate custom short code format
function isValidCustomCode(code: string): { valid: boolean; error?: string } {
  if (code.length < 4) {
    return { valid: false, error: 'Custom code must be at least 4 characters' };
  }
  if (code.length > 20) {
    return { valid: false, error: 'Custom code must be at most 20 characters' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
    return { valid: false, error: 'Custom code can only contain letters, numbers, underscores, and hyphens' };
  }
  if (URL_CONFIG.reservedWords.includes(code.toLowerCase())) {
    return { valid: false, error: 'This short code is reserved' };
  }
  return { valid: true };
}

// Convert database row to response format
function toUrlResponse(url: Url): UrlResponse {
  return {
    short_url: `${SERVER_CONFIG.baseUrl}/${url.short_code}`,
    short_code: url.short_code,
    long_url: url.long_url,
    created_at: url.created_at.toISOString(),
    expires_at: url.expires_at ? url.expires_at.toISOString() : null,
    click_count: url.click_count,
    is_custom: url.is_custom,
  };
}

// Create a new shortened URL
export async function createUrl(input: CreateUrlInput): Promise<UrlResponse> {
  const { long_url, custom_code, expires_in, user_id } = input;

  // Validate URL
  if (!isValidUrl(long_url)) {
    throw new Error('Invalid URL format');
  }

  if (long_url.length > URL_CONFIG.maxUrlLength) {
    throw new Error(`URL exceeds maximum length of ${URL_CONFIG.maxUrlLength} characters`);
  }

  let shortCode: string;
  let isCustom = false;

  if (custom_code) {
    // Validate custom code
    const validation = isValidCustomCode(custom_code);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Check availability
    const available = await isCodeAvailable(custom_code);
    if (!available) {
      throw new Error('This custom code is already taken');
    }

    shortCode = custom_code;
    isCustom = true;
  } else {
    // Get a key from the pool
    shortCode = await getNextKey();
  }

  // Calculate expiration
  let expiresAt: Date | null = null;
  if (expires_in) {
    expiresAt = new Date(Date.now() + expires_in * 1000);
  }

  // Insert into database
  const result = await query<Url>(
    `INSERT INTO urls (short_code, long_url, user_id, expires_at, is_custom)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [shortCode, long_url, user_id || null, expiresAt, isCustom]
  );

  // Mark key as used if from pool
  if (!isCustom) {
    await markKeyAsUsed(shortCode);
  }

  // Cache the URL mapping
  await urlCache.set(shortCode, long_url);

  return toUrlResponse(result[0]);
}

// Get URL by short code (for redirect)
export async function getUrlByShortCode(shortCode: string): Promise<string | null> {
  // Check cache first
  const cached = await urlCache.get(shortCode);
  if (cached) {
    return cached;
  }

  // Cache miss - query database
  const result = await query<Url>(
    `SELECT * FROM urls
     WHERE short_code = $1
     AND is_active = true
     AND (expires_at IS NULL OR expires_at > NOW())`,
    [shortCode]
  );

  if (result.length === 0) {
    return null;
  }

  const url = result[0];

  // Update cache
  await urlCache.set(shortCode, url.long_url);

  return url.long_url;
}

// Get URL details
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

// Get user's URLs
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

// Update URL (deactivate, change expiration)
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

  // Invalidate cache
  if (updates.is_active === false) {
    await urlCache.delete(shortCode);
  }

  return toUrlResponse(result[0]);
}

// Delete URL (soft delete)
export async function deleteUrl(shortCode: string, userId: string): Promise<boolean> {
  const result = await query<Url>(
    `UPDATE urls SET is_active = false WHERE short_code = $1 AND user_id = $2 RETURNING *`,
    [shortCode, userId]
  );

  if (result.length > 0) {
    await urlCache.delete(shortCode);
    return true;
  }

  return false;
}

// Increment click count
export async function incrementClickCount(shortCode: string): Promise<void> {
  await query(
    `UPDATE urls SET click_count = click_count + 1 WHERE short_code = $1`,
    [shortCode]
  );
}
