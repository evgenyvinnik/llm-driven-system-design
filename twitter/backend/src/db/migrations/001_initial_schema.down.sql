-- Rollback: initial_schema
-- Version: 001
-- WARNING: This will destroy all data!

-- Drop triggers first
DROP TRIGGER IF EXISTS trigger_reply_count ON tweets;
DROP TRIGGER IF EXISTS trigger_retweet_count ON retweets;
DROP TRIGGER IF EXISTS trigger_like_count ON likes;
DROP TRIGGER IF EXISTS trigger_tweet_count ON tweets;
DROP TRIGGER IF EXISTS trigger_follow_counts ON follows;

-- Drop functions
DROP FUNCTION IF EXISTS update_reply_count();
DROP FUNCTION IF EXISTS update_retweet_count();
DROP FUNCTION IF EXISTS update_like_count();
DROP FUNCTION IF EXISTS update_tweet_count();
DROP FUNCTION IF EXISTS update_follow_counts();

-- Drop tables (in reverse order of dependencies)
DROP TABLE IF EXISTS hashtag_activity;
DROP TABLE IF EXISTS retweets;
DROP TABLE IF EXISTS likes;
DROP TABLE IF EXISTS follows;
DROP TABLE IF EXISTS tweets;
DROP TABLE IF EXISTS users;
