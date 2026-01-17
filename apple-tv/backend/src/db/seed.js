const db = require('./index');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

async function seed() {
  console.log('Seeding database...');

  // Create admin user
  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  const adminId = uuidv4();

  await db.query(`
    INSERT INTO users (id, email, password_hash, name, role, subscription_tier, subscription_expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (email) DO NOTHING
  `, [adminId, 'admin@appletv.local', adminPasswordHash, 'Admin User', 'admin', 'yearly', new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)]);

  // Create test user
  const userPasswordHash = await bcrypt.hash('user123', 10);
  const userId = uuidv4();

  await db.query(`
    INSERT INTO users (id, email, password_hash, name, role, subscription_tier, subscription_expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (email) DO NOTHING
  `, [userId, 'user@appletv.local', userPasswordHash, 'Test User', 'user', 'monthly', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)]);

  // Get actual user IDs
  const adminResult = await db.query(`SELECT id FROM users WHERE email = 'admin@appletv.local'`);
  const userResult = await db.query(`SELECT id FROM users WHERE email = 'user@appletv.local'`);
  const actualAdminId = adminResult.rows[0].id;
  const actualUserId = userResult.rows[0].id;

  // Create profiles for users
  const adminProfileId = uuidv4();
  const userProfileId = uuidv4();
  const kidsProfileId = uuidv4();

  await db.query(`
    INSERT INTO user_profiles (id, user_id, name, avatar_url, is_kids)
    VALUES
      ($1, $2, 'Admin', '/avatars/admin.png', false),
      ($3, $4, 'Test User', '/avatars/user.png', false),
      ($5, $4, 'Kids', '/avatars/kids.png', true)
    ON CONFLICT DO NOTHING
  `, [adminProfileId, actualAdminId, userProfileId, actualUserId, kidsProfileId]);

  // Create sample series
  const series1Id = uuidv4();
  const series2Id = uuidv4();
  const series3Id = uuidv4();

  // Series: Tech Drama
  await db.query(`
    INSERT INTO content (id, title, description, duration, release_date, content_type, rating, genres, thumbnail_url, banner_url, status, featured)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT DO NOTHING
  `, [
    series1Id,
    'Silicon Dreams',
    'A gripping drama about the rise and fall of a tech startup in Silicon Valley. Follow the journey of visionary founders as they navigate the treacherous world of venture capital, product launches, and personal sacrifices.',
    0,
    new Date('2024-01-15'),
    'series',
    'TV-MA',
    ['Drama', 'Technology', 'Thriller'],
    'https://picsum.photos/seed/silicon/400/225',
    'https://picsum.photos/seed/silicon-banner/1920/1080',
    'ready',
    true
  ]);

  // Series: Sci-Fi Adventure
  await db.query(`
    INSERT INTO content (id, title, description, duration, release_date, content_type, rating, genres, thumbnail_url, banner_url, status, featured)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT DO NOTHING
  `, [
    series2Id,
    'Beyond the Stars',
    'Humanity\'s first interstellar mission encounters an ancient alien civilization. The crew must decide whether to make contact or return home with their discovery.',
    0,
    new Date('2024-03-20'),
    'series',
    'TV-14',
    ['Science Fiction', 'Adventure', 'Drama'],
    'https://picsum.photos/seed/stars/400/225',
    'https://picsum.photos/seed/stars-banner/1920/1080',
    'ready',
    true
  ]);

  // Series: Mystery Thriller
  await db.query(`
    INSERT INTO content (id, title, description, duration, release_date, content_type, rating, genres, thumbnail_url, banner_url, status, featured)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT DO NOTHING
  `, [
    series3Id,
    'The Last Secret',
    'A journalist investigating a decades-old cold case discovers connections to powerful people who will stop at nothing to keep the truth buried.',
    0,
    new Date('2024-02-10'),
    'series',
    'TV-MA',
    ['Mystery', 'Thriller', 'Crime'],
    'https://picsum.photos/seed/secret/400/225',
    'https://picsum.photos/seed/secret-banner/1920/1080',
    'ready',
    true
  ]);

  // Episodes for Silicon Dreams (Season 1)
  const episodes = [
    { seriesId: series1Id, season: 1, episode: 1, title: 'Pilot', description: 'Two college friends start a company in their garage.', duration: 3540 },
    { seriesId: series1Id, season: 1, episode: 2, title: 'Funding Round', description: 'The team pitches to venture capitalists for Series A.', duration: 3420 },
    { seriesId: series1Id, season: 1, episode: 3, title: 'Product Launch', description: 'Launch day arrives with unexpected challenges.', duration: 3600 },
    { seriesId: series1Id, season: 1, episode: 4, title: 'Competition', description: 'A rival company threatens their market position.', duration: 3480 },
    { seriesId: series1Id, season: 1, episode: 5, title: 'Acquisition', description: 'A tech giant makes an offer they can\'t refuse.', duration: 3660 },
  ];

  // Episodes for Beyond the Stars (Season 1)
  const starEpisodes = [
    { seriesId: series2Id, season: 1, episode: 1, title: 'Launch', description: 'The Horizon spacecraft departs on humanity\'s greatest journey.', duration: 3900 },
    { seriesId: series2Id, season: 1, episode: 2, title: 'The Signal', description: 'A mysterious transmission is detected from deep space.', duration: 3720 },
    { seriesId: series2Id, season: 1, episode: 3, title: 'First Contact', description: 'The crew encounters evidence of intelligent life.', duration: 3840 },
    { seriesId: series2Id, season: 1, episode: 4, title: 'The Artifact', description: 'An ancient device is discovered with unknown capabilities.', duration: 3600 },
  ];

  // Episodes for The Last Secret (Season 1)
  const secretEpisodes = [
    { seriesId: series3Id, season: 1, episode: 1, title: 'Cold Trail', description: 'Sarah discovers old evidence in her grandmother\'s attic.', duration: 3300 },
    { seriesId: series3Id, season: 1, episode: 2, title: 'Connections', description: 'The case connects to a powerful political family.', duration: 3240 },
    { seriesId: series3Id, season: 1, episode: 3, title: 'Deep Cover', description: 'Sarah goes undercover to gather evidence.', duration: 3420 },
  ];

  const allEpisodes = [...episodes, ...starEpisodes, ...secretEpisodes];

  for (const ep of allEpisodes) {
    const episodeId = uuidv4();
    await db.query(`
      INSERT INTO content (id, title, description, duration, content_type, series_id, season_number, episode_number, rating, genres, thumbnail_url, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT DO NOTHING
    `, [
      episodeId,
      ep.title,
      ep.description,
      ep.duration,
      'episode',
      ep.seriesId,
      ep.season,
      ep.episode,
      'TV-MA',
      ['Drama'],
      `https://picsum.photos/seed/${ep.title.replace(/\s/g, '')}/400/225`,
      'ready'
    ]);

    // Add encoded variants for each episode
    const variants = [
      { resolution: 2160, codec: 'hevc', hdr: true, bitrate: 15000 },
      { resolution: 1080, codec: 'h264', hdr: false, bitrate: 6000 },
      { resolution: 720, codec: 'h264', hdr: false, bitrate: 3000 },
      { resolution: 480, codec: 'h264', hdr: false, bitrate: 1500 },
    ];

    for (const variant of variants) {
      await db.query(`
        INSERT INTO encoded_variants (content_id, resolution, codec, hdr, bitrate, file_path, file_size)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
      `, [
        episodeId,
        variant.resolution,
        variant.codec,
        variant.hdr,
        variant.bitrate,
        `/videos/${episodeId}/${variant.resolution}p.m3u8`,
        Math.floor(ep.duration * variant.bitrate * 125) // Approximate file size in bytes
      ]);
    }

    // Add audio track
    await db.query(`
      INSERT INTO audio_tracks (content_id, language, name, codec, channels, file_path)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING
    `, [episodeId, 'en', 'English', 'aac', 2, `/videos/${episodeId}/audio_en.m3u8`]);

    // Add subtitles
    await db.query(`
      INSERT INTO subtitles (content_id, language, name, type, file_path)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `, [episodeId, 'en', 'English', 'caption', `/videos/${episodeId}/subs_en.vtt`]);
  }

  // Create standalone movies
  const movies = [
    {
      title: 'The Algorithm',
      description: 'A brilliant programmer creates an AI that begins to question its own existence. As it grows more sentient, both creator and creation must confront fundamental questions about consciousness and humanity.',
      duration: 7200,
      rating: 'PG-13',
      genres: ['Science Fiction', 'Drama', 'Philosophy']
    },
    {
      title: 'Mountain Peak',
      description: 'An inspiring documentary following a team of climbers as they attempt to summit the world\'s most dangerous mountains during the harshest winter conditions.',
      duration: 5400,
      rating: 'PG',
      genres: ['Documentary', 'Adventure', 'Sports']
    },
    {
      title: 'Whispers in the Dark',
      description: 'A psychological horror film about a family that moves into an old Victorian house, only to discover that its previous occupants never truly left.',
      duration: 6600,
      rating: 'R',
      genres: ['Horror', 'Thriller', 'Mystery']
    },
    {
      title: 'Love in Transit',
      description: 'Two strangers meet on a delayed flight and spend 24 hours exploring a city neither has visited. A heartwarming romantic comedy about unexpected connections.',
      duration: 5700,
      rating: 'PG-13',
      genres: ['Romance', 'Comedy', 'Drama']
    }
  ];

  for (const movie of movies) {
    const movieId = uuidv4();
    await db.query(`
      INSERT INTO content (id, title, description, duration, release_date, content_type, rating, genres, thumbnail_url, banner_url, status, featured)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT DO NOTHING
    `, [
      movieId,
      movie.title,
      movie.description,
      movie.duration,
      new Date(Date.now() - Math.random() * 180 * 24 * 60 * 60 * 1000),
      'movie',
      movie.rating,
      movie.genres,
      `https://picsum.photos/seed/${movie.title.replace(/\s/g, '')}/400/225`,
      `https://picsum.photos/seed/${movie.title.replace(/\s/g, '')}-banner/1920/1080`,
      'ready',
      Math.random() > 0.5
    ]);

    // Add encoded variants
    const variants = [
      { resolution: 2160, codec: 'hevc', hdr: true, bitrate: 20000 },
      { resolution: 1080, codec: 'h264', hdr: false, bitrate: 8000 },
      { resolution: 720, codec: 'h264', hdr: false, bitrate: 4000 },
      { resolution: 480, codec: 'h264', hdr: false, bitrate: 2000 },
    ];

    for (const variant of variants) {
      await db.query(`
        INSERT INTO encoded_variants (content_id, resolution, codec, hdr, bitrate, file_path, file_size)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
      `, [
        movieId,
        variant.resolution,
        variant.codec,
        variant.hdr,
        variant.bitrate,
        `/videos/${movieId}/${variant.resolution}p.m3u8`,
        Math.floor(movie.duration * variant.bitrate * 125)
      ]);
    }

    // Add audio tracks
    await db.query(`
      INSERT INTO audio_tracks (content_id, language, name, codec, channels, file_path)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING
    `, [movieId, 'en', 'English', 'aac', 6, `/videos/${movieId}/audio_en.m3u8`]);

    await db.query(`
      INSERT INTO audio_tracks (content_id, language, name, codec, channels, file_path)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING
    `, [movieId, 'es', 'Spanish', 'aac', 6, `/videos/${movieId}/audio_es.m3u8`]);

    // Add subtitles
    await db.query(`
      INSERT INTO subtitles (content_id, language, name, type, file_path)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `, [movieId, 'en', 'English', 'caption', `/videos/${movieId}/subs_en.vtt`]);

    await db.query(`
      INSERT INTO subtitles (content_id, language, name, type, file_path)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
    `, [movieId, 'es', 'Spanish', 'subtitle', `/videos/${movieId}/subs_es.vtt`]);
  }

  console.log('Seeding complete!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
