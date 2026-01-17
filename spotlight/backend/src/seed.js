import pg from 'pg';
import { Client } from '@elastic/elasticsearch';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'spotlight',
  user: process.env.PG_USER || 'spotlight',
  password: process.env.PG_PASSWORD || 'spotlight_password',
});

const esClient = new Client({
  node: process.env.ES_URL || 'http://localhost:9200',
});

// Sample data
const sampleApps = [
  { bundle_id: 'com.apple.Safari', name: 'Safari', path: '/Applications/Safari.app', category: 'browser' },
  { bundle_id: 'com.apple.mail', name: 'Mail', path: '/Applications/Mail.app', category: 'productivity' },
  { bundle_id: 'com.apple.finder', name: 'Finder', path: '/System/Library/CoreServices/Finder.app', category: 'system' },
  { bundle_id: 'com.apple.Notes', name: 'Notes', path: '/Applications/Notes.app', category: 'productivity' },
  { bundle_id: 'com.apple.Calendar', name: 'Calendar', path: '/Applications/Calendar.app', category: 'productivity' },
  { bundle_id: 'com.apple.Preview', name: 'Preview', path: '/Applications/Preview.app', category: 'utility' },
  { bundle_id: 'com.apple.TextEdit', name: 'TextEdit', path: '/Applications/TextEdit.app', category: 'productivity' },
  { bundle_id: 'com.apple.Terminal', name: 'Terminal', path: '/Applications/Utilities/Terminal.app', category: 'developer' },
  { bundle_id: 'com.microsoft.VSCode', name: 'Visual Studio Code', path: '/Applications/Visual Studio Code.app', category: 'developer' },
  { bundle_id: 'com.google.Chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app', category: 'browser' },
  { bundle_id: 'com.spotify.client', name: 'Spotify', path: '/Applications/Spotify.app', category: 'music' },
  { bundle_id: 'com.slack.Slack', name: 'Slack', path: '/Applications/Slack.app', category: 'communication' },
  { bundle_id: 'us.zoom.xos', name: 'Zoom', path: '/Applications/zoom.us.app', category: 'communication' },
  { bundle_id: 'com.docker.docker', name: 'Docker Desktop', path: '/Applications/Docker.app', category: 'developer' },
  { bundle_id: 'com.figma.Desktop', name: 'Figma', path: '/Applications/Figma.app', category: 'design' }
];

const sampleContacts = [
  { name: 'Alice Johnson', email: 'alice@example.com', phone: '+1-555-0101', company: 'Tech Corp' },
  { name: 'Bob Smith', email: 'bob@example.com', phone: '+1-555-0102', company: 'Design Studio' },
  { name: 'Carol Williams', email: 'carol@example.com', phone: '+1-555-0103', company: 'Marketing Inc' },
  { name: 'David Brown', email: 'david@example.com', phone: '+1-555-0104', company: 'Finance LLC' },
  { name: 'Eva Martinez', email: 'eva@example.com', phone: '+1-555-0105', company: 'Tech Corp' },
  { name: 'Frank Lee', email: 'frank@example.com', phone: '+1-555-0106', company: 'Startup Hub' },
  { name: 'Grace Chen', email: 'grace@example.com', phone: '+1-555-0107', company: 'Innovation Labs' },
  { name: 'Henry Wilson', email: 'henry@example.com', phone: '+1-555-0108', company: 'Consulting Group' }
];

const sampleFiles = [
  { path: '/Users/demo/Documents/project-proposal.pdf', name: 'Project Proposal', type: 'document', content: 'project proposal budget timeline objectives', size: 245000, modified_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
  { path: '/Users/demo/Documents/meeting-notes.txt', name: 'Meeting Notes', type: 'document', content: 'meeting notes discussion action items follow up', size: 12000, modified_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) },
  { path: '/Users/demo/Documents/budget-2024.xlsx', name: 'Budget 2024', type: 'spreadsheet', content: 'budget expenses revenue forecast', size: 89000, modified_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
  { path: '/Users/demo/Pictures/vacation-photo.jpg', name: 'Vacation Photo', type: 'image', content: 'vacation beach sunset photo', size: 3500000, modified_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
  { path: '/Users/demo/Downloads/presentation.pptx', name: 'Quarterly Presentation', type: 'presentation', content: 'quarterly report sales growth presentation', size: 567000, modified_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
  { path: '/Users/demo/Projects/app/README.md', name: 'README', type: 'code', content: 'readme installation guide usage documentation', size: 8500, modified_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) },
  { path: '/Users/demo/Projects/app/src/index.ts', name: 'index.ts', type: 'code', content: 'typescript main entry point application', size: 4200, modified_at: new Date() },
  { path: '/Users/demo/Documents/resume.pdf', name: 'Resume', type: 'document', content: 'resume experience education skills', size: 125000, modified_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
  { path: '/Users/demo/Documents/contract.docx', name: 'Contract Agreement', type: 'document', content: 'contract agreement terms conditions legal', size: 78000, modified_at: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
  { path: '/Users/demo/Music/playlist.m3u', name: 'Favorite Playlist', type: 'music', content: 'playlist music songs favorites', size: 2500, modified_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
];

const sampleWebItems = [
  { url: 'https://github.com', title: 'GitHub', description: 'Where the world builds software' },
  { url: 'https://stackoverflow.com', title: 'Stack Overflow', description: 'Where developers learn, share, and build careers' },
  { url: 'https://developer.mozilla.org', title: 'MDN Web Docs', description: 'Resources for developers, by developers' },
  { url: 'https://news.ycombinator.com', title: 'Hacker News', description: 'Social news website focusing on computer science' },
  { url: 'https://www.youtube.com', title: 'YouTube', description: 'Video sharing platform' },
  { url: 'https://docs.google.com', title: 'Google Docs', description: 'Create and edit documents online' },
  { url: 'https://calendar.google.com', title: 'Google Calendar', description: 'Online calendar service' },
  { url: 'https://www.notion.so', title: 'Notion', description: 'All-in-one workspace' }
];

async function seed() {
  console.log('Seeding database...');

  try {
    // Seed applications
    console.log('Seeding applications...');
    for (const app of sampleApps) {
      await pool.query(`
        INSERT INTO applications (bundle_id, name, path, category)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (bundle_id) DO UPDATE SET name = $2, path = $3, category = $4
      `, [app.bundle_id, app.name, app.path, app.category]);

      await esClient.index({
        index: 'spotlight_apps',
        id: app.bundle_id,
        body: {
          bundle_id: app.bundle_id,
          name: app.name,
          path: app.path,
          category: app.category,
          usage_count: Math.floor(Math.random() * 50),
          last_used: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000)
        },
        refresh: true
      });
    }
    console.log(`Seeded ${sampleApps.length} applications`);

    // Seed contacts
    console.log('Seeding contacts...');
    for (const contact of sampleContacts) {
      const result = await pool.query(`
        INSERT INTO contacts (name, email, phone, company)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [contact.name, contact.email, contact.phone, contact.company]);

      if (result.rows.length > 0) {
        await esClient.index({
          index: 'spotlight_contacts',
          id: result.rows[0].id.toString(),
          body: contact,
          refresh: true
        });
      }
    }
    console.log(`Seeded ${sampleContacts.length} contacts`);

    // Seed files
    console.log('Seeding files...');
    for (const file of sampleFiles) {
      await pool.query(`
        INSERT INTO indexed_files (path, name, type, size, modified_at, metadata)
        VALUES ($1, $2, $3, $4, $5, '{}')
        ON CONFLICT (path) DO UPDATE SET name = $2, type = $3, size = $4, modified_at = $5
      `, [file.path, file.name, file.type, file.size, file.modified_at]);

      await esClient.index({
        index: 'spotlight_files',
        id: file.path,
        body: {
          path: file.path,
          name: file.name,
          content: file.content,
          type: file.type,
          size: file.size,
          modified_at: file.modified_at,
          indexed_at: new Date()
        },
        refresh: true
      });
    }
    console.log(`Seeded ${sampleFiles.length} files`);

    // Seed web items
    console.log('Seeding web items...');
    for (const web of sampleWebItems) {
      const result = await pool.query(`
        INSERT INTO web_items (url, title, description)
        VALUES ($1, $2, $3)
        ON CONFLICT (url) DO UPDATE SET title = $2, description = $3
        RETURNING id
      `, [web.url, web.title, web.description]);

      await esClient.index({
        index: 'spotlight_web',
        id: web.url,
        body: {
          ...web,
          visited_count: Math.floor(Math.random() * 20) + 1,
          last_visited: new Date(Date.now() - Math.random() * 14 * 24 * 60 * 60 * 1000)
        },
        refresh: true
      });
    }
    console.log(`Seeded ${sampleWebItems.length} web items`);

    // Add some usage patterns
    console.log('Seeding usage patterns...');
    const hours = [9, 10, 11, 14, 15, 16]; // Working hours
    for (const app of sampleApps.slice(0, 5)) {
      for (const hour of hours) {
        for (let day = 1; day <= 5; day++) { // Weekdays
          await pool.query(`
            INSERT INTO app_usage_patterns (bundle_id, hour, day_of_week, count, last_used)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (bundle_id, hour, day_of_week) DO UPDATE SET count = $4
          `, [app.bundle_id, hour, day, Math.floor(Math.random() * 10) + 1]);
        }
      }
    }
    console.log('Seeded usage patterns');

    console.log('Seeding complete!');
  } catch (error) {
    console.error('Seeding failed:', error);
  } finally {
    await pool.end();
    await esClient.close();
  }
}

seed();
