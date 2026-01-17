import dotenv from 'dotenv';
import { aggregateAllVotes } from '../models/vote.js';

dotenv.config();

const AGGREGATION_INTERVAL = parseInt(process.env.VOTE_AGGREGATION_INTERVAL) || 5000;

const run = async () => {
  console.log(`Vote aggregator started (interval: ${AGGREGATION_INTERVAL}ms)`);

  // Periodic aggregation
  setInterval(async () => {
    try {
      await aggregateAllVotes();
    } catch (error) {
      console.error('Error aggregating votes:', error);
    }
  }, AGGREGATION_INTERVAL);
};

run();
