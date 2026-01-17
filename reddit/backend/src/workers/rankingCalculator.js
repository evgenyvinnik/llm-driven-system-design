import dotenv from 'dotenv';
import { query } from '../db/index.js';
import { calculateHotScore } from '../utils/ranking.js';

dotenv.config();

const RANKING_INTERVAL = parseInt(process.env.RANKING_CALCULATION_INTERVAL) || 60000;

const recalculateHotScores = async () => {
  console.log('Recalculating hot scores...');
  const start = Date.now();

  try {
    // Get all posts from the last 7 days (older posts don't need recalculation)
    const result = await query(`
      SELECT id, upvotes, downvotes, created_at
      FROM posts
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    for (const post of result.rows) {
      const hotScore = calculateHotScore(post.upvotes, post.downvotes, new Date(post.created_at));
      await query(`UPDATE posts SET hot_score = $1 WHERE id = $2`, [hotScore, post.id]);
    }

    console.log(`Recalculated ${result.rows.length} hot scores in ${Date.now() - start}ms`);
  } catch (error) {
    console.error('Error recalculating hot scores:', error);
  }
};

const run = async () => {
  console.log(`Ranking calculator started (interval: ${RANKING_INTERVAL}ms)`);

  // Initial calculation
  await recalculateHotScores();

  // Periodic recalculation
  setInterval(recalculateHotScores, RANKING_INTERVAL);
};

run();
