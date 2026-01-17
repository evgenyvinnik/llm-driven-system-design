import { pool } from '../db.js';

// Create a new playlist
export async function createPlaylist(userId, { name, description = '', isPublic = true }) {
  const result = await pool.query(
    `INSERT INTO playlists (owner_id, name, description, is_public)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, name, description, isPublic]
  );

  return result.rows[0];
}

// Get user's playlists
export async function getUserPlaylists(userId, { limit = 50, offset = 0 }) {
  const result = await pool.query(
    `SELECT p.*,
            u.username as owner_username,
            (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
     FROM playlists p
     JOIN users u ON p.owner_id = u.id
     WHERE p.owner_id = $1
     ORDER BY p.updated_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

  const countResult = await pool.query(
    'SELECT COUNT(*) FROM playlists WHERE owner_id = $1',
    [userId]
  );

  return {
    playlists: result.rows,
    total: parseInt(countResult.rows[0].count),
    limit,
    offset,
  };
}

// Get playlist by ID with tracks
export async function getPlaylistById(playlistId, userId = null) {
  const playlistResult = await pool.query(
    `SELECT p.*, u.username as owner_username
     FROM playlists p
     JOIN users u ON p.owner_id = u.id
     WHERE p.id = $1`,
    [playlistId]
  );

  if (playlistResult.rows.length === 0) {
    return null;
  }

  const playlist = playlistResult.rows[0];

  // Check access for private playlists
  if (!playlist.is_public && playlist.owner_id !== userId) {
    return null;
  }

  // Get tracks with full details
  const tracksResult = await pool.query(
    `SELECT pt.position, pt.added_at,
            t.*,
            a.title as album_title, a.cover_url as album_cover_url,
            ar.name as artist_name, ar.id as artist_id,
            adder.username as added_by_username
     FROM playlist_tracks pt
     JOIN tracks t ON pt.track_id = t.id
     JOIN albums a ON t.album_id = a.id
     JOIN artists ar ON a.artist_id = ar.id
     LEFT JOIN users adder ON pt.added_by = adder.id
     WHERE pt.playlist_id = $1
     ORDER BY pt.position`,
    [playlistId]
  );

  return {
    ...playlist,
    tracks: tracksResult.rows,
    track_count: tracksResult.rows.length,
  };
}

// Update playlist
export async function updatePlaylist(playlistId, userId, updates) {
  // Verify ownership
  const ownerCheck = await pool.query(
    'SELECT owner_id FROM playlists WHERE id = $1',
    [playlistId]
  );

  if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].owner_id !== userId) {
    throw new Error('Not authorized to update this playlist');
  }

  const allowedFields = ['name', 'description', 'is_public', 'cover_url'];
  const updateEntries = Object.entries(updates).filter(([key]) =>
    allowedFields.includes(key)
  );

  if (updateEntries.length === 0) {
    return await getPlaylistById(playlistId, userId);
  }

  const setClause = updateEntries
    .map(([key], index) => `${key} = $${index + 2}`)
    .join(', ');
  const values = updateEntries.map(([, value]) => value);

  await pool.query(
    `UPDATE playlists SET ${setClause}, updated_at = NOW()
     WHERE id = $1`,
    [playlistId, ...values]
  );

  return await getPlaylistById(playlistId, userId);
}

// Delete playlist
export async function deletePlaylist(playlistId, userId) {
  const ownerCheck = await pool.query(
    'SELECT owner_id FROM playlists WHERE id = $1',
    [playlistId]
  );

  if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].owner_id !== userId) {
    throw new Error('Not authorized to delete this playlist');
  }

  await pool.query('DELETE FROM playlists WHERE id = $1', [playlistId]);
  return { deleted: true };
}

// Add track to playlist
export async function addTrackToPlaylist(playlistId, trackId, userId) {
  // Check authorization (owner or collaborative)
  const playlistCheck = await pool.query(
    'SELECT owner_id, is_collaborative FROM playlists WHERE id = $1',
    [playlistId]
  );

  if (playlistCheck.rows.length === 0) {
    throw new Error('Playlist not found');
  }

  const playlist = playlistCheck.rows[0];
  if (playlist.owner_id !== userId && !playlist.is_collaborative) {
    throw new Error('Not authorized to add tracks to this playlist');
  }

  // Get the next position
  const positionResult = await pool.query(
    'SELECT COALESCE(MAX(position), 0) + 1 as next_position FROM playlist_tracks WHERE playlist_id = $1',
    [playlistId]
  );

  const nextPosition = positionResult.rows[0].next_position;

  await pool.query(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (playlist_id, track_id) DO NOTHING`,
    [playlistId, trackId, nextPosition, userId]
  );

  // Update playlist timestamp
  await pool.query(
    'UPDATE playlists SET updated_at = NOW() WHERE id = $1',
    [playlistId]
  );

  return { added: true };
}

// Remove track from playlist
export async function removeTrackFromPlaylist(playlistId, trackId, userId) {
  const playlistCheck = await pool.query(
    'SELECT owner_id, is_collaborative FROM playlists WHERE id = $1',
    [playlistId]
  );

  if (playlistCheck.rows.length === 0) {
    throw new Error('Playlist not found');
  }

  const playlist = playlistCheck.rows[0];
  if (playlist.owner_id !== userId && !playlist.is_collaborative) {
    throw new Error('Not authorized to remove tracks from this playlist');
  }

  // Get position of removed track
  const positionResult = await pool.query(
    'SELECT position FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
    [playlistId, trackId]
  );

  if (positionResult.rows.length === 0) {
    return { removed: false };
  }

  const removedPosition = positionResult.rows[0].position;

  // Delete the track
  await pool.query(
    'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
    [playlistId, trackId]
  );

  // Reorder remaining tracks
  await pool.query(
    `UPDATE playlist_tracks
     SET position = position - 1
     WHERE playlist_id = $1 AND position > $2`,
    [playlistId, removedPosition]
  );

  // Update playlist timestamp
  await pool.query(
    'UPDATE playlists SET updated_at = NOW() WHERE id = $1',
    [playlistId]
  );

  return { removed: true };
}

// Reorder tracks in playlist
export async function reorderPlaylistTracks(playlistId, userId, { trackId, newPosition }) {
  const playlistCheck = await pool.query(
    'SELECT owner_id, is_collaborative FROM playlists WHERE id = $1',
    [playlistId]
  );

  if (playlistCheck.rows.length === 0) {
    throw new Error('Playlist not found');
  }

  const playlist = playlistCheck.rows[0];
  if (playlist.owner_id !== userId && !playlist.is_collaborative) {
    throw new Error('Not authorized to reorder tracks in this playlist');
  }

  const currentPositionResult = await pool.query(
    'SELECT position FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
    [playlistId, trackId]
  );

  if (currentPositionResult.rows.length === 0) {
    throw new Error('Track not found in playlist');
  }

  const currentPosition = currentPositionResult.rows[0].position;

  if (currentPosition === newPosition) {
    return { reordered: true };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (newPosition > currentPosition) {
      // Moving down: shift tracks up
      await client.query(
        `UPDATE playlist_tracks
         SET position = position - 1
         WHERE playlist_id = $1 AND position > $2 AND position <= $3`,
        [playlistId, currentPosition, newPosition]
      );
    } else {
      // Moving up: shift tracks down
      await client.query(
        `UPDATE playlist_tracks
         SET position = position + 1
         WHERE playlist_id = $1 AND position >= $2 AND position < $3`,
        [playlistId, newPosition, currentPosition]
      );
    }

    // Update the track's position
    await client.query(
      `UPDATE playlist_tracks
       SET position = $1
       WHERE playlist_id = $2 AND track_id = $3`,
      [newPosition, playlistId, trackId]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { reordered: true };
}

// Get public playlists for browse
export async function getPublicPlaylists({ limit = 20, offset = 0 }) {
  const result = await pool.query(
    `SELECT p.*,
            u.username as owner_username,
            (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) as track_count
     FROM playlists p
     JOIN users u ON p.owner_id = u.id
     WHERE p.is_public = true
     ORDER BY p.follower_count DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return {
    playlists: result.rows,
    limit,
    offset,
  };
}

export default {
  createPlaylist,
  getUserPlaylists,
  getPlaylistById,
  updatePlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
  getPublicPlaylists,
};
