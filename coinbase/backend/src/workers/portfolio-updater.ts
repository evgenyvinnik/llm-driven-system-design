import { pool } from '../services/db.js';
import { EXCHANGE_USER_ID } from '../services/exchangeAccount.js';
import { marketService } from '../services/marketService.js';
import { logger } from '../services/logger.js';

const SNAPSHOT_INTERVAL = 60000; // 60 seconds

/** Takes a snapshot of all user portfolio values and stores them in the database. */
async function takePortfolioSnapshots(): Promise<void> {
  try {
    // Get all users with non-zero balances
    const usersResult = await pool.query(
      `SELECT DISTINCT user_id FROM wallets WHERE balance > 0 AND user_id <> $1`,
      [EXCHANGE_USER_ID]
    );

    for (const row of usersResult.rows) {
      const userId = row.user_id;

      // Get all wallet balances for this user
      const walletsResult = await pool.query(
        `SELECT currency_id, balance::text FROM wallets
         WHERE user_id = $1 AND balance > 0`,
        [userId]
      );

      let totalValueUsd = 0;
      const breakdown: Record<string, { balance: string; valueUsd: number }> = {};

      for (const wallet of walletsResult.rows) {
        const balance = parseFloat(wallet.balance);
        let valueUsd = 0;

        if (wallet.currency_id === 'USD') {
          valueUsd = balance;
        } else {
          const priceData = marketService.getPriceData(`${wallet.currency_id}-USD`);
          if (priceData) {
            valueUsd = balance * priceData.price;
          }
        }

        totalValueUsd += valueUsd;
        breakdown[wallet.currency_id] = {
          balance: wallet.balance,
          valueUsd,
        };
      }

      // Insert snapshot
      await pool.query(
        `INSERT INTO portfolio_snapshots (user_id, total_value_usd, breakdown)
         VALUES ($1, $2, $3)`,
        [userId, totalValueUsd.toString(), JSON.stringify(breakdown)]
      );
    }

    logger.debug(
      { userCount: usersResult.rows.length },
      'Portfolio snapshots completed'
    );
  } catch (error) {
    logger.error({ error }, 'Failed to take portfolio snapshots');
  }
}

async function run(): Promise<void> {
  logger.info('Portfolio updater worker started');

  // Take initial snapshot
  await takePortfolioSnapshots();

  // Then every 60 seconds
  setInterval(async () => {
    await takePortfolioSnapshots();
  }, SNAPSHOT_INTERVAL);
}

run().catch((error) => {
  logger.error({ error }, 'Portfolio updater failed to start');
  process.exit(1);
});
