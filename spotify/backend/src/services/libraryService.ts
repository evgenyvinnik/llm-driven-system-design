import { pool } from '../db.js';
import type {
  LibraryItemType,
  TrackWithPlayedAt,
  AlbumWithArtist,
  Artist,
  PlaylistWithOwner,
  PaginationParams,
} from '../types.js';

interface SaveResult {
  saved: boolean;
}

interface LibraryTracksResponse {
  tracks: TrackWithPlayedAt[];
  total: number;
  limit: number;
  offset: number;
}

interface LibraryAlbumsResponse {
  albums: (AlbumWithArtist & { saved_at: Date })[];
  total: number;
  limit: number;
  offset: number;
}

interface LibraryArtistsResponse {
  artists: (Artist & { followed_at: Date })[];
  total: number;
  limit: number;
  offset: number;
}

interface LibraryPlaylistsResponse {
  playlists: (PlaylistWithOwner & { saved_at: Date })[];
  total: number;
  limit: number;
  offset: number;
}

// Save item to library (like a track, album, artist, or follow a playlist)
export async function saveToLibrary(
  userId: string,
  itemType: LibraryItemType,
  itemId: string
): Promise<SaveResult> {
  await pool.query(
    `INSERT INTO user_library (user_id, item_type, item_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, item_type, item_id) DO NOTHING`,
    [userId, itemType, itemId]
  );
  return { saved: true };
}

// Remove item from library
export async function removeFromLibrary(
  userId: string,
  itemType: LibraryItemType,
  itemId: string
): Promise<SaveResult> {
  await pool.query(
    `DELETE FROM user_library
     WHERE user_id = $1 AND item_type = $2 AND item_id = $3`,
    [userId, itemType, itemId]
  );
  return { saved: false };
}

// Check if item is in library
export async function isInLibrary(
  userId: string,
  itemType: LibraryItemType,
  itemId: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM user_library
     WHERE user_id = $1 AND item_type = $2 AND item_id = $3`,
    [userId, itemType, itemId]
  );
  return result.rows.length > 0;
}

// Check multiple items at once
export async function checkMultipleInLibrary(
  userId: string,
  itemType: LibraryItemType,
  itemIds: string[]
): Promise<Record<string, boolean>> {
  if (!itemIds || itemIds.length === 0) return {};

  const result = await pool.query(
    `SELECT item_id FROM user_library
     WHERE user_id = $1 AND item_type = $2 AND item_id = ANY($3)`,
    [userId, itemType, itemIds]
  );

  const savedMap: Record<string, boolean> = {};
  for (const id of itemIds) {
    savedMap[id] = result.rows.some((row: { item_id: string }) => row.item_id === id);
  }
  return savedMap;
}

// Get liked songs
export async function getLikedSongs(
  userId: string,
  { limit = 50, offset = 0 }: PaginationParams
): Promise<LibraryTracksResponse> {
  const result = await pool.query(
    `SELECT t.*,
            a.title as album_title, a.cover_url as album_cover_url,
            ar.name as artist_name, ar.id as artist_id,
            ul.saved_at
     FROM user_library ul
     JOIN tracks t ON ul.item_id = t.id
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE ul.user_id = $1 AND ul.item_type = 'track'
     ORDER BY ul.saved_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM user_library
     WHERE user_id = $1 AND item_type = 'track'`,
    [userId]
  );

  return {
    tracks: result.rows as TrackWithPlayedAt[],
    total: parseInt(countResult.rows[0].count as string),
    limit,
    offset,
  };
}

// Get saved albums
export async function getSavedAlbums(
  userId: string,
  { limit = 50, offset = 0 }: PaginationParams
): Promise<LibraryAlbumsResponse> {
  const result = await pool.query(
    `SELECT a.*, ar.name as artist_name, ul.saved_at
     FROM user_library ul
     JOIN albums a ON ul.item_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     WHERE ul.user_id = $1 AND ul.item_type = 'album'
     ORDER BY ul.saved_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM user_library
     WHERE user_id = $1 AND item_type = 'album'`,
    [userId]
  );

  return {
    albums: result.rows as (AlbumWithArtist & { saved_at: Date })[],
    total: parseInt(countResult.rows[0].count as string),
    limit,
    offset,
  };
}

// Get followed artists
export async function getFollowedArtists(
  userId: string,
  { limit = 50, offset = 0 }: PaginationParams
): Promise<LibraryArtistsResponse> {
  const result = await pool.query(
    `SELECT ar.*, ul.saved_at as followed_at
     FROM user_library ul
     JOIN artists ar ON ul.item_id = ar.id
     WHERE ul.user_id = $1 AND ul.item_type = 'artist'
     ORDER BY ul.saved_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM user_library
     WHERE user_id = $1 AND item_type = 'artist'`,
    [userId]
  );

  return {
    artists: result.rows as (Artist & { followed_at: Date })[],
    total: parseInt(countResult.rows[0].count as string),
    limit,
    offset,
  };
}

// Get followed/saved playlists
export async function getSavedPlaylists(
  userId: string,
  { limit = 50, offset = 0 }: PaginationParams
): Promise<LibraryPlaylistsResponse> {
  const result = await pool.query(
    `SELECT p.*, u.username as owner_username, ul.saved_at
     FROM user_library ul
     JOIN playlists p ON ul.item_id = p.id
     JOIN users u ON p.owner_id = u.id
     WHERE ul.user_id = $1 AND ul.item_type = 'playlist'
     ORDER BY ul.saved_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM user_library
     WHERE user_id = $1 AND item_type = 'playlist'`,
    [userId]
  );

  return {
    playlists: result.rows as (PlaylistWithOwner & { saved_at: Date })[],
    total: parseInt(countResult.rows[0].count as string),
    limit,
    offset,
  };
}

export default {
  saveToLibrary,
  removeFromLibrary,
  isInLibrary,
  checkMultipleInLibrary,
  getLikedSongs,
  getSavedAlbums,
  getFollowedArtists,
  getSavedPlaylists,
};
