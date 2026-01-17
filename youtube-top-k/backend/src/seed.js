import dotenv from 'dotenv';
dotenv.config();

import { v4 as uuidv4 } from 'uuid';
import { initializeDatabase, query, getPool } from './models/database.js';

const CATEGORIES = ['music', 'gaming', 'sports', 'news', 'entertainment', 'education'];

const VIDEO_TEMPLATES = [
  // Music
  { category: 'music', titles: ['Amazing Piano Cover', 'Epic Guitar Solo', 'Chill Lofi Beats', 'Viral Dance Song', 'Acoustic Session'] },
  // Gaming
  { category: 'gaming', titles: ['Pro Gameplay Highlights', 'Speedrun World Record', 'Game Review', 'Lets Play Episode', 'Gaming Tips & Tricks'] },
  // Sports
  { category: 'sports', titles: ['Championship Highlights', 'Best Goals Compilation', 'Training Routine', 'Match Analysis', 'Athlete Interview'] },
  // News
  { category: 'news', titles: ['Breaking News Update', 'Weekly News Roundup', 'Tech News Today', 'World Events Summary', 'Industry Update'] },
  // Entertainment
  { category: 'entertainment', titles: ['Comedy Sketch', 'Movie Review', 'Celebrity Interview', 'Behind the Scenes', 'Prank Video'] },
  // Education
  { category: 'education', titles: ['Tutorial for Beginners', 'Advanced Techniques', 'How Things Work', 'History Documentary', 'Science Explained'] },
];

const CHANNEL_NAMES = [
  'TechGuru',
  'MusicMaster',
  'GameZone',
  'SportsCenter',
  'NewsDaily',
  'FunnyVids',
  'LearnWithMe',
  'CreativeCorner',
  'ProGaming',
  'ChillVibes',
];

function generateVideos(count = 50) {
  const videos = [];

  for (let i = 0; i < count; i++) {
    const categoryTemplate = VIDEO_TEMPLATES[i % VIDEO_TEMPLATES.length];
    const titleTemplate = categoryTemplate.titles[Math.floor(Math.random() * categoryTemplate.titles.length)];
    const channel = CHANNEL_NAMES[Math.floor(Math.random() * CHANNEL_NAMES.length)];
    const id = uuidv4();

    videos.push({
      id,
      title: `${titleTemplate} #${i + 1}`,
      description: `This is an amazing video about ${categoryTemplate.category}. Watch now!`,
      thumbnail_url: `https://picsum.photos/seed/${id}/320/180`,
      channel_name: channel,
      category: categoryTemplate.category,
      duration_seconds: Math.floor(Math.random() * 900) + 60, // 1-15 minutes
    });
  }

  return videos;
}

async function seed() {
  console.log('Initializing database...');
  await initializeDatabase();

  console.log('Clearing existing data...');
  await query('DELETE FROM view_events');
  await query('DELETE FROM trending_snapshots');
  await query('DELETE FROM videos');

  console.log('Generating videos...');
  const videos = generateVideos(60);

  console.log(`Inserting ${videos.length} videos...`);
  for (const video of videos) {
    await query(
      `INSERT INTO videos (id, title, description, thumbnail_url, channel_name, category, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [video.id, video.title, video.description, video.thumbnail_url, video.channel_name, video.category, video.duration_seconds]
    );
  }

  console.log('Seed completed successfully!');
  console.log(`Created ${videos.length} videos across ${CATEGORIES.length} categories`);

  // Close the pool
  const pool = getPool();
  await pool.end();
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
