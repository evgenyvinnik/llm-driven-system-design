// Reddit epoch: December 8, 2005, 7:46:43 AM UTC
const REDDIT_EPOCH = 1134028003;

/**
 * Calculate hot score using Reddit's algorithm
 * Score = sign(score) * log10(|score|) + seconds / 45000
 */
export const calculateHotScore = (upvotes, downvotes, createdAt) => {
  const score = upvotes - downvotes;
  const order = Math.log10(Math.max(Math.abs(score), 1));
  const sign = score > 0 ? 1 : score < 0 ? -1 : 0;
  const seconds = Math.floor(createdAt.getTime() / 1000) - REDDIT_EPOCH;
  return sign * order + seconds / 45000;
};

/**
 * Calculate top score (simple net score)
 */
export const calculateTopScore = (upvotes, downvotes) => {
  return upvotes - downvotes;
};

/**
 * Calculate controversial score
 * High engagement + balanced votes = controversial
 */
export const calculateControversialScore = (upvotes, downvotes) => {
  if (upvotes <= 0 || downvotes <= 0) return 0;
  const magnitude = upvotes + downvotes;
  const balance = Math.min(upvotes, downvotes) / Math.max(upvotes, downvotes);
  return magnitude * balance;
};

/**
 * Wilson score confidence interval for "best" sorting
 * Lower bound of Wilson score with 95% confidence
 */
export const calculateWilsonScore = (upvotes, downvotes) => {
  const n = upvotes + downvotes;
  if (n === 0) return 0;

  const z = 1.96; // 95% confidence
  const p = upvotes / n;

  const left = p + z * z / (2 * n);
  const right = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  const under = 1 + z * z / n;

  return (left - right) / under;
};

/**
 * Calculate rising score (velocity-based)
 * Posts gaining votes quickly
 */
export const calculateRisingScore = (upvotes, downvotes, createdAt, recentVotes) => {
  const ageMinutes = (Date.now() - createdAt.getTime()) / (1000 * 60);
  if (ageMinutes < 1) return 0;

  // Recent votes per minute
  const velocity = recentVotes / Math.min(ageMinutes, 60);
  const score = upvotes - downvotes;

  return velocity * Math.log10(Math.max(score, 1) + 1);
};
