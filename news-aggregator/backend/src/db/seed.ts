/**
 * Seeds the demo database with a realistic front page.
 *
 * The SQL fixture (`db-seed/base.sql`) only creates users and sources. Stories
 * and articles normally arrive from the crawler hitting live RSS feeds, which
 * means a freshly started stack shows "No stories found" until a crawl happens
 * to succeed — and in an offline or short-lived environment, never.
 *
 * So this seeder writes the *output* of a crawl: clustered stories with real
 * SimHash fingerprints computed by the project's own `computeSimHash`, their
 * constituent articles from multiple sources, and an Elasticsearch index entry
 * per article so search returns something too. Using the real fingerprint
 * function rather than fabricated numbers means the seeded data is consistent
 * with what clustering would actually produce.
 *
 * Run with: npm run db:seed
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './postgres.js';
import { indexArticle, indexStory, initElasticsearch } from './elasticsearch.js';
import { computeSimHash } from '../utils/simhash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function applyBaseSeed(): Promise<void> {
  const sqlPath = path.resolve(__dirname, '../../db-seed/base.sql');
  if (!fs.existsSync(sqlPath)) {
    console.warn('base.sql not found, skipping SQL seed');
    return;
  }
  await pool.query(fs.readFileSync(sqlPath, 'utf-8'));
  console.log('Base seed applied (users, sources, crawl schedule).');
}

interface SeedArticle {
  /** Domain of a source seeded by base.sql — resolved to its generated UUID. */
  domain: string;
  title: string;
  summary: string;
  author: string;
  minutesAgo: number;
}

interface SeedStory {
  title: string;
  summary: string;
  primaryTopic: string;
  topics: string[];
  entities: { name: string; type: string }[];
  isBreaking: boolean;
  /** 30-minute article velocity, the trending signal. */
  velocity: number;
  hoursAgo: number;
  imageUrl: string;
  articles: SeedArticle[];
}

/**
 * Each story is covered by several outlets, which is the point of the product:
 * the feed shows one story, not five near-identical articles.
 */
const STORIES: SeedStory[] = [
  {
    title: 'Fed holds rates steady, signals two cuts before year end',
    summary:
      'The Federal Reserve left its benchmark rate unchanged for a fourth consecutive meeting, but the updated dot plot points to two reductions in the second half of the year.',
    primaryTopic: 'business',
    topics: ['business', 'politics'],
    entities: [
      { name: 'Federal Reserve', type: 'ORG' },
      { name: 'Jerome Powell', type: 'PERSON' },
    ],
    isBreaking: true,
    velocity: 8.4,
    hoursAgo: 1,
    imageUrl: 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800',
    articles: [
      {
        domain: 'reuters.com',
        title: 'Fed holds rates steady, signals two cuts before year end',
        summary:
          'Policymakers voted unanimously to hold, with the median projection now showing two quarter-point cuts by December.',
        author: 'Reuters Staff',
        minutesAgo: 55,
      },
      {
        domain: 'bbc.com',
        title: 'US central bank keeps interest rates on hold',
        summary:
          'The decision was widely expected, though the accompanying projections were more dovish than markets had priced in.',
        author: 'Michelle Fleury',
        minutesAgo: 47,
      },
      {
        domain: 'npr.org',
        title: 'Fed stands pat as inflation cools, but cuts are now in view',
        summary:
          'Powell said the committee wants "greater confidence" that inflation is moving sustainably toward 2% before easing.',
        author: 'Scott Horsley',
        minutesAgo: 32,
      },
    ],
  },
  {
    title: 'Major cloud provider outage takes down large parts of the web',
    summary:
      'A misconfigured routing update in a single region cascaded into multi-hour failures across storage and identity services, affecting thousands of downstream sites.',
    primaryTopic: 'technology',
    topics: ['technology', 'business'],
    entities: [{ name: 'AWS', type: 'ORG' }],
    isBreaking: true,
    velocity: 12.1,
    hoursAgo: 3,
    imageUrl: 'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=800',
    articles: [
      {
        domain: 'theverge.com',
        title: 'A cloud outage is breaking a big chunk of the internet right now',
        summary:
          'Status pages lit up shortly after 09:00 UTC, with identity services failing first and storage following minutes later.',
        author: 'Jay Peters',
        minutesAgo: 175,
      },
      {
        domain: 'arstechnica.com',
        title: 'Routing change blamed for cascading cloud failure',
        summary:
          'The provider’s postmortem points to an automated update that withdrew routes faster than health checks could react.',
        author: 'Dan Goodin',
        minutesAgo: 150,
      },
      {
        domain: 'techcrunch.com',
        title: 'Cloud outage disrupts thousands of sites for hours',
        summary:
          'Startups relying on a single region were hit hardest, reviving a familiar argument about multi-region defaults.',
        author: 'Sarah Perez',
        minutesAgo: 128,
      },
      {
        domain: 'news.ycombinator.com',
        title: 'Ask HN: how are you handling today’s cloud outage?',
        summary:
          'A long thread of failover war stories, with several teams noting their status pages were hosted on the same provider.',
        author: 'hn',
        minutesAgo: 120,
      },
    ],
  },
  {
    title: 'Open-source model matches frontier performance on reasoning benchmarks',
    summary:
      'A newly released open-weights model posts scores within a point of the leading closed models on several reasoning suites, at a fraction of the inference cost.',
    primaryTopic: 'technology',
    topics: ['technology', 'science'],
    entities: [{ name: 'Hugging Face', type: 'ORG' }],
    isBreaking: false,
    velocity: 5.2,
    hoursAgo: 6,
    imageUrl: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800',
    articles: [
      {
        domain: 'wired.com',
        title: 'The open model that just caught up to the frontier',
        summary:
          'Independent evaluations broadly reproduce the published numbers, though benchmark contamination remains an open question.',
        author: 'Will Knight',
        minutesAgo: 350,
      },
      {
        domain: 'techcrunch.com',
        title: 'New open-weights model narrows the gap with closed labs',
        summary:
          'The permissive license is arguably the bigger story: it allows commercial use without a revenue threshold.',
        author: 'Kyle Wiggers',
        minutesAgo: 330,
      },
    ],
  },
  {
    title: 'Late equalizer sends the final to extra time',
    summary:
      'A 94th-minute header cancelled out a one-goal deficit and forced an additional thirty minutes in front of a sold-out crowd.',
    primaryTopic: 'sports',
    topics: ['sports'],
    entities: [],
    isBreaking: false,
    velocity: 6.8,
    hoursAgo: 9,
    imageUrl: 'https://images.unsplash.com/photo-1517649763962-0c623066013b?w=800',
    articles: [
      {
        domain: 'espn.com',
        title: 'Late equalizer sends the final to extra time',
        summary:
          'The substitute had been on the pitch for four minutes when he met the cross at the near post.',
        author: 'ESPN Staff',
        minutesAgo: 520,
      },
      {
        domain: 'theguardian.com',
        title: 'Dramatic stoppage-time header forces extra time in the final',
        summary:
          'A match that had drifted for an hour turned on a single set piece.',
        author: 'Barney Ronay',
        minutesAgo: 505,
      },
    ],
  },
  {
    title: 'Parliament passes sweeping data protection reform',
    summary:
      'The bill tightens consent requirements and introduces per-day penalties for delayed breach disclosure, with an eighteen-month compliance window.',
    primaryTopic: 'politics',
    topics: ['politics', 'technology'],
    entities: [{ name: 'European Parliament', type: 'ORG' }],
    isBreaking: false,
    velocity: 3.1,
    hoursAgo: 14,
    imageUrl: 'https://images.unsplash.com/photo-1529107386315-e1a2ed48a620?w=800',
    articles: [
      {
        domain: 'bbc.com',
        title: 'MEPs approve overhaul of data protection rules',
        summary:
          'The vote followed two years of negotiation over how far consent requirements should extend to inferred data.',
        author: 'Jessica Parker',
        minutesAgo: 840,
      },
      {
        domain: 'theguardian.com',
        title: 'New data law introduces daily fines for late breach reporting',
        summary:
          'Privacy groups called the disclosure clause the most consequential part of the package.',
        author: 'Alex Hern',
        minutesAgo: 820,
      },
    ],
  },
  {
    title: 'Telescope survey finds unexpected structure in the early universe',
    summary:
      'Deep-field observations reveal massive galaxies far earlier than current formation models predict, prompting a re-examination of assumptions about early star formation.',
    primaryTopic: 'science',
    topics: ['science', 'technology'],
    entities: [{ name: 'JWST', type: 'ORG' }],
    isBreaking: false,
    velocity: 2.4,
    hoursAgo: 20,
    imageUrl: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=800',
    articles: [
      {
        domain: 'arstechnica.com',
        title: 'Early galaxies are bigger than they should be',
        summary:
          'Either the galaxies formed faster than models allow, or the mass estimates are systematically off.',
        author: 'John Timmer',
        minutesAgo: 1180,
      },
      {
        domain: 'npr.org',
        title: 'Astronomers puzzle over surprisingly mature early galaxies',
        summary:
          'The results are consistent across several independent fields, which makes an instrumental artifact unlikely.',
        author: 'Nell Greenfieldboyce',
        minutesAgo: 1150,
      },
    ],
  },
];

async function seedStories(): Promise<void> {
  const existing = await pool.query('SELECT 1 FROM stories LIMIT 1');
  if ((existing.rowCount ?? 0) > 0) {
    console.log('Stories already seeded, skipping.');
    return;
  }

  // Elasticsearch is a derived index — if it isn't reachable, seed Postgres
  // anyway and let search be the only degraded surface.
  //
  // The retry matters: a single-node ES cluster takes tens of seconds to accept
  // requests, and seeding usually runs moments after the stack comes up. Without
  // waiting, indexing silently fails and the only symptom is that search returns
  // nothing while the feed is full.
  let esReady = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await initElasticsearch();
      esReady = true;
      break;
    } catch (err) {
      if (attempt === 10) {
        console.warn(`  Elasticsearch unavailable, skipping indexing: ${(err as Error).message}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  const { rows: sources } = await pool.query<{ id: string; domain: string }>(
    'SELECT id, domain FROM sources',
  );
  const sourceByDomain = new Map(sources.map((s) => [s.domain, s.id]));

  let storyCount = 0;
  let articleCount = 0;

  for (const story of STORIES) {
    // The real fingerprint function, so the seeded rows are what clustering
    // would actually have produced for this text.
    const fingerprint = computeSimHash(`${story.title} ${story.summary}`);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO stories
         (title, summary, primary_topic, topics, entities, fingerprint,
          article_count, source_count, velocity, is_breaking, breaking_started_at,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               CASE WHEN $10 THEN NOW() - ($11 || ' hours')::interval ELSE NULL END,
               NOW() - ($11 || ' hours')::interval,
               NOW() - ($11 || ' hours')::interval)
       RETURNING id`,
      [
        story.title,
        story.summary,
        story.primaryTopic,
        story.topics,
        JSON.stringify(story.entities),
        // Written as a string: node-postgres passes it through to BIGINT
        // unchanged, avoiding the precision loss that Number(fingerprint)
        // would introduce in exactly the low bits Hamming distance uses.
        fingerprint.toString(),
        story.articles.length,
        new Set(story.articles.map((a) => a.domain)).size,
        story.velocity,
        story.isBreaking,
        story.hoursAgo,
      ],
    );
    const storyId = rows[0].id;
    storyCount++;

    for (const article of story.articles) {
      const sourceId = sourceByDomain.get(article.domain);
      if (!sourceId) {
        console.warn(`  no seeded source for ${article.domain}, skipping article`);
        continue;
      }

      const articleFingerprint = computeSimHash(`${article.title} ${article.summary}`);
      const url = `https://${article.domain}/${storyId}/${articleCount}`;

      const { rows: inserted } = await pool.query<{ id: string }>(
        `INSERT INTO articles
           (source_id, story_id, url, title, summary, body, author, image_url,
            published_at, fingerprint, topics, entities)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 NOW() - ($9 || ' minutes')::interval, $10, $11, $12)
         ON CONFLICT (url) DO NOTHING
         RETURNING id`,
        [
          sourceId,
          storyId,
          url,
          article.title,
          article.summary,
          `${article.summary}\n\n${story.summary}`,
          article.author,
          story.imageUrl,
          article.minutesAgo,
          articleFingerprint.toString(),
          story.topics,
          JSON.stringify(story.entities),
        ],
      );
      if (inserted.length === 0) continue;
      articleCount++;

      if (esReady) {
        try {
          await indexArticle({
            id: inserted[0].id,
            title: article.title,
            summary: article.summary,
            body: story.summary,
            topics: story.topics,
            entities: story.entities,
            published_at: new Date(Date.now() - article.minutesAgo * 60_000),
            source_id: sourceId,
            story_id: storyId,
          });
        } catch (err) {
          console.warn(`  failed to index article: ${(err as Error).message}`);
        }
      }
    }

    if (esReady) {
      try {
        await indexStory({
          id: storyId,
          title: story.title,
          summary: story.summary,
          primary_topic: story.primaryTopic,
          topics: story.topics,
          velocity: story.velocity,
          is_breaking: story.isBreaking,
          article_count: story.articles.length,
          created_at: new Date(Date.now() - story.hoursAgo * 3_600_000),
        });
      } catch (err) {
        console.warn(`  failed to index story: ${(err as Error).message}`);
      }
    }
  }

  console.log(`Seeded ${storyCount} stories and ${articleCount} articles.`);
}

applyBaseSeed()
  .then(seedStories)
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seeding failed:', err);
    pool.end();
    process.exit(1);
  });
