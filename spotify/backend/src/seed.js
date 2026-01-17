import { pool, initializeDatabase } from './db.js';
import { migrate } from './models/migrate.js';
import bcrypt from 'bcrypt';

// Sample data for seeding
const artists = [
  { name: 'The Midnight', bio: 'Synthwave duo from Los Angeles', image_url: 'https://picsum.photos/seed/midnight/300/300', verified: true, monthly_listeners: 2500000 },
  { name: 'Tycho', bio: 'Ambient and electronic musician from San Francisco', image_url: 'https://picsum.photos/seed/tycho/300/300', verified: true, monthly_listeners: 1800000 },
  { name: 'ODESZA', bio: 'Electronic music duo from Seattle', image_url: 'https://picsum.photos/seed/odesza/300/300', verified: true, monthly_listeners: 4500000 },
  { name: 'Bonobo', bio: 'British musician and producer', image_url: 'https://picsum.photos/seed/bonobo/300/300', verified: true, monthly_listeners: 3200000 },
  { name: 'Khruangbin', bio: 'Psychedelic trio from Houston', image_url: 'https://picsum.photos/seed/khruangbin/300/300', verified: true, monthly_listeners: 2800000 },
  { name: 'Glass Animals', bio: 'British indie rock band from Oxford', image_url: 'https://picsum.photos/seed/glassanimals/300/300', verified: true, monthly_listeners: 5500000 },
  { name: 'Tame Impala', bio: 'Psychedelic music project from Australia', image_url: 'https://picsum.photos/seed/tameimpala/300/300', verified: true, monthly_listeners: 7200000 },
  { name: 'Mac DeMarco', bio: 'Canadian singer-songwriter', image_url: 'https://picsum.photos/seed/macdem/300/300', verified: true, monthly_listeners: 4100000 },
  { name: 'Beach House', bio: 'Dream pop duo from Baltimore', image_url: 'https://picsum.photos/seed/beachhouse/300/300', verified: true, monthly_listeners: 2900000 },
  { name: 'Caribou', bio: 'Canadian electronic musician', image_url: 'https://picsum.photos/seed/caribou/300/300', verified: true, monthly_listeners: 1500000 },
];

// Album templates with tracks
const albumTemplates = [
  {
    artistIndex: 0, // The Midnight
    albums: [
      {
        title: 'Endless Summer', release_date: '2016-07-15', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/endlesssummer/300/300',
        tracks: [
          { title: 'Sunset', duration_ms: 234000, track_number: 1 },
          { title: 'Endless Summer', duration_ms: 287000, track_number: 2 },
          { title: 'Gloria', duration_ms: 312000, track_number: 3 },
          { title: 'Vampires', duration_ms: 268000, track_number: 4 },
          { title: 'Jason', duration_ms: 245000, track_number: 5 },
        ]
      },
      {
        title: 'Nocturnal', release_date: '2017-09-22', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/nocturnal/300/300',
        tracks: [
          { title: 'America Online', duration_ms: 198000, track_number: 1 },
          { title: 'River of Darkness', duration_ms: 276000, track_number: 2 },
          { title: 'Nocturnal', duration_ms: 321000, track_number: 3 },
          { title: 'Shadows', duration_ms: 289000, track_number: 4 },
        ]
      }
    ]
  },
  {
    artistIndex: 1, // Tycho
    albums: [
      {
        title: 'Dive', release_date: '2011-11-29', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/dive/300/300',
        tracks: [
          { title: 'A Walk', duration_ms: 305000, track_number: 1 },
          { title: 'Hours', duration_ms: 265000, track_number: 2 },
          { title: 'Dive', duration_ms: 298000, track_number: 3 },
          { title: 'Coastal Brake', duration_ms: 345000, track_number: 4 },
        ]
      },
      {
        title: 'Awake', release_date: '2014-03-18', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/awake/300/300',
        tracks: [
          { title: 'Awake', duration_ms: 356000, track_number: 1 },
          { title: 'Montana', duration_ms: 289000, track_number: 2 },
          { title: 'L', duration_ms: 245000, track_number: 3 },
          { title: 'Dye', duration_ms: 312000, track_number: 4 },
          { title: 'See', duration_ms: 278000, track_number: 5 },
        ]
      }
    ]
  },
  {
    artistIndex: 2, // ODESZA
    albums: [
      {
        title: 'A Moment Apart', release_date: '2017-09-08', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/momentapart/300/300',
        tracks: [
          { title: 'A Moment Apart', duration_ms: 258000, track_number: 1 },
          { title: 'Higher Ground', duration_ms: 245000, track_number: 2 },
          { title: 'Boy', duration_ms: 223000, track_number: 3 },
          { title: 'Line of Sight', duration_ms: 289000, track_number: 4 },
          { title: 'Late Night', duration_ms: 276000, track_number: 5 },
        ]
      },
      {
        title: 'In Return', release_date: '2014-09-09', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/inreturn/300/300',
        tracks: [
          { title: 'Say My Name', duration_ms: 267000, track_number: 1 },
          { title: 'Bloom', duration_ms: 298000, track_number: 2 },
          { title: 'White Lies', duration_ms: 245000, track_number: 3 },
          { title: 'Kusanagi', duration_ms: 312000, track_number: 4 },
        ]
      }
    ]
  },
  {
    artistIndex: 3, // Bonobo
    albums: [
      {
        title: 'Migration', release_date: '2017-01-13', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/migration/300/300',
        tracks: [
          { title: 'Migration', duration_ms: 312000, track_number: 1 },
          { title: 'Kerala', duration_ms: 287000, track_number: 2 },
          { title: 'Break Apart', duration_ms: 298000, track_number: 3 },
          { title: 'No Reason', duration_ms: 256000, track_number: 4 },
        ]
      }
    ]
  },
  {
    artistIndex: 4, // Khruangbin
    albums: [
      {
        title: 'Con Todo El Mundo', release_date: '2018-01-26', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/contodo/300/300',
        tracks: [
          { title: 'Como Me Quieres', duration_ms: 223000, track_number: 1 },
          { title: 'Maria También', duration_ms: 198000, track_number: 2 },
          { title: 'Evan Finds the Third Room', duration_ms: 267000, track_number: 3 },
          { title: 'August 10', duration_ms: 245000, track_number: 4 },
          { title: 'Friday Morning', duration_ms: 212000, track_number: 5 },
        ]
      },
      {
        title: 'Mordechai', release_date: '2020-06-26', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/mordechai/300/300',
        tracks: [
          { title: 'First Class', duration_ms: 198000, track_number: 1 },
          { title: 'Time (You and I)', duration_ms: 234000, track_number: 2 },
          { title: 'Pelota', duration_ms: 267000, track_number: 3 },
          { title: 'So We Wont Forget', duration_ms: 289000, track_number: 4 },
        ]
      }
    ]
  },
  {
    artistIndex: 5, // Glass Animals
    albums: [
      {
        title: 'Dreamland', release_date: '2020-08-07', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/dreamland/300/300',
        tracks: [
          { title: 'Dreamland', duration_ms: 145000, track_number: 1 },
          { title: 'Tangerine', duration_ms: 245000, track_number: 2 },
          { title: 'Heat Waves', duration_ms: 238000, track_number: 3 },
          { title: 'Space Ghost Coast to Coast', duration_ms: 276000, track_number: 4 },
          { title: 'Tokyo Drifting', duration_ms: 256000, track_number: 5 },
          { title: 'Melon and the Coconut', duration_ms: 289000, track_number: 6 },
        ]
      }
    ]
  },
  {
    artistIndex: 6, // Tame Impala
    albums: [
      {
        title: 'Currents', release_date: '2015-07-17', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/currents/300/300',
        tracks: [
          { title: 'Let It Happen', duration_ms: 467000, track_number: 1 },
          { title: 'Nangs', duration_ms: 107000, track_number: 2 },
          { title: 'The Moment', duration_ms: 284000, track_number: 3 },
          { title: 'Yes I\'m Changing', duration_ms: 282000, track_number: 4 },
          { title: 'Eventually', duration_ms: 319000, track_number: 5 },
          { title: 'The Less I Know The Better', duration_ms: 218000, track_number: 6 },
        ]
      },
      {
        title: 'The Slow Rush', release_date: '2020-02-14', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/slowrush/300/300',
        tracks: [
          { title: 'One More Year', duration_ms: 337000, track_number: 1 },
          { title: 'Instant Destiny', duration_ms: 193000, track_number: 2 },
          { title: 'Borderline', duration_ms: 237000, track_number: 3 },
          { title: 'Breathe Deeper', duration_ms: 372000, track_number: 4 },
          { title: 'Lost in Yesterday', duration_ms: 248000, track_number: 5 },
        ]
      }
    ]
  },
  {
    artistIndex: 7, // Mac DeMarco
    albums: [
      {
        title: 'Salad Days', release_date: '2014-04-01', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/saladdays/300/300',
        tracks: [
          { title: 'Salad Days', duration_ms: 168000, track_number: 1 },
          { title: 'Blue Boy', duration_ms: 178000, track_number: 2 },
          { title: 'Brother', duration_ms: 247000, track_number: 3 },
          { title: 'Let Her Go', duration_ms: 201000, track_number: 4 },
          { title: 'Chamber of Reflection', duration_ms: 265000, track_number: 5 },
        ]
      }
    ]
  },
  {
    artistIndex: 8, // Beach House
    albums: [
      {
        title: 'Depression Cherry', release_date: '2015-08-28', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/depcherry/300/300',
        tracks: [
          { title: 'Levitation', duration_ms: 265000, track_number: 1 },
          { title: 'Sparks', duration_ms: 243000, track_number: 2 },
          { title: 'Space Song', duration_ms: 321000, track_number: 3 },
          { title: 'Beyond Love', duration_ms: 287000, track_number: 4 },
          { title: 'PPP', duration_ms: 356000, track_number: 5 },
        ]
      },
      {
        title: '7', release_date: '2018-05-11', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/beachhouse7/300/300',
        tracks: [
          { title: 'Dark Spring', duration_ms: 287000, track_number: 1 },
          { title: 'Pay No Mind', duration_ms: 265000, track_number: 2 },
          { title: 'Lemon Glow', duration_ms: 312000, track_number: 3 },
          { title: 'Dive', duration_ms: 298000, track_number: 4 },
        ]
      }
    ]
  },
  {
    artistIndex: 9, // Caribou
    albums: [
      {
        title: 'Suddenly', release_date: '2020-02-28', album_type: 'album',
        cover_url: 'https://picsum.photos/seed/suddenly/300/300',
        tracks: [
          { title: 'Sister', duration_ms: 232000, track_number: 1 },
          { title: 'You and I', duration_ms: 298000, track_number: 2 },
          { title: 'Sunny\'s Time', duration_ms: 287000, track_number: 3 },
          { title: 'New Jade', duration_ms: 312000, track_number: 4 },
          { title: 'Never Come Back', duration_ms: 356000, track_number: 5 },
        ]
      }
    ]
  }
];

async function seed() {
  console.log('Starting database seed...');

  try {
    await initializeDatabase();
    await migrate();

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Clear existing data
      await client.query('DELETE FROM playback_events');
      await client.query('DELETE FROM listening_history');
      await client.query('DELETE FROM user_library');
      await client.query('DELETE FROM playlist_tracks');
      await client.query('DELETE FROM playlists');
      await client.query('DELETE FROM track_artists');
      await client.query('DELETE FROM tracks');
      await client.query('DELETE FROM albums');
      await client.query('DELETE FROM artists');
      await client.query('DELETE FROM users');

      console.log('Cleared existing data');

      // Create demo user
      const passwordHash = await bcrypt.hash('password123', 10);
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, username, display_name, is_premium)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        ['demo@spotify.local', passwordHash, 'demo', 'Demo User', true]
      );
      const userId = userResult.rows[0].id;
      console.log('Created demo user');

      // Insert artists
      const artistIds = [];
      for (const artist of artists) {
        const result = await client.query(
          `INSERT INTO artists (name, bio, image_url, verified, monthly_listeners)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [artist.name, artist.bio, artist.image_url, artist.verified, artist.monthly_listeners]
        );
        artistIds.push(result.rows[0].id);
      }
      console.log(`Inserted ${artistIds.length} artists`);

      // Insert albums and tracks
      let trackCount = 0;
      let albumCount = 0;
      const allTrackIds = [];

      for (const template of albumTemplates) {
        const artistId = artistIds[template.artistIndex];

        for (const album of template.albums) {
          const albumResult = await client.query(
            `INSERT INTO albums (artist_id, title, release_date, cover_url, album_type, total_tracks)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [artistId, album.title, album.release_date, album.cover_url, album.album_type, album.tracks.length]
          );
          const albumId = albumResult.rows[0].id;
          albumCount++;

          for (const track of album.tracks) {
            // Use a sample audio file URL for demo (Creative Commons audio)
            const audioUrl = `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${(trackCount % 16) + 1}.mp3`;

            const trackResult = await client.query(
              `INSERT INTO tracks (album_id, title, duration_ms, track_number, audio_url, stream_count, audio_features)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id`,
              [
                albumId,
                track.title,
                track.duration_ms,
                track.track_number,
                audioUrl,
                Math.floor(Math.random() * 10000000), // Random stream count
                JSON.stringify({
                  tempo: 80 + Math.floor(Math.random() * 80),
                  energy: Math.random(),
                  danceability: Math.random(),
                  acousticness: Math.random(),
                })
              ]
            );
            const trackId = trackResult.rows[0].id;
            allTrackIds.push(trackId);
            trackCount++;

            // Add track-artist relationship
            await client.query(
              `INSERT INTO track_artists (track_id, artist_id, is_primary)
               VALUES ($1, $2, $3)`,
              [trackId, artistId, true]
            );
          }
        }
      }
      console.log(`Inserted ${albumCount} albums and ${trackCount} tracks`);

      // Create demo playlist with some tracks
      const playlistResult = await client.query(
        `INSERT INTO playlists (owner_id, name, description, is_public)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [userId, 'My Favorites', 'A collection of my favorite tracks', true]
      );
      const playlistId = playlistResult.rows[0].id;

      // Add first 10 tracks to playlist
      for (let i = 0; i < Math.min(10, allTrackIds.length); i++) {
        await client.query(
          `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by)
           VALUES ($1, $2, $3, $4)`,
          [playlistId, allTrackIds[i], i + 1, userId]
        );
      }
      console.log('Created demo playlist with 10 tracks');

      // Like some tracks for the demo user
      for (let i = 0; i < Math.min(20, allTrackIds.length); i++) {
        if (Math.random() > 0.5) {
          await client.query(
            `INSERT INTO user_library (user_id, item_type, item_id)
             VALUES ($1, $2, $3)`,
            [userId, 'track', allTrackIds[i]]
          );
        }
      }
      console.log('Added liked tracks for demo user');

      // Follow some artists
      for (let i = 0; i < Math.min(5, artistIds.length); i++) {
        await client.query(
          `INSERT INTO user_library (user_id, item_type, item_id)
           VALUES ($1, $2, $3)`,
          [userId, 'artist', artistIds[i]]
        );
      }
      console.log('Added followed artists for demo user');

      // Add some listening history
      for (let i = 0; i < 30; i++) {
        const randomTrackId = allTrackIds[Math.floor(Math.random() * allTrackIds.length)];
        await client.query(
          `INSERT INTO listening_history (user_id, track_id, duration_played_ms, completed, played_at)
           VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${Math.floor(Math.random() * 28)} days')`,
          [userId, randomTrackId, 180000 + Math.floor(Math.random() * 120000), Math.random() > 0.2]
        );
      }
      console.log('Added listening history for demo user');

      await client.query('COMMIT');
      console.log('Database seeded successfully!');
      console.log('\nDemo account:');
      console.log('  Email: demo@spotify.local');
      console.log('  Password: password123');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    process.exit(0);
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  }
}

seed();
