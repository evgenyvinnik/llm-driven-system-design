-- Migration 001 DOWN: Drop initial schema
-- WARNING: This will delete all data!

DROP TRIGGER IF EXISTS trigger_update_swipe_timestamp ON swipes;
DROP TRIGGER IF EXISTS trigger_update_user_location ON users;
DROP FUNCTION IF EXISTS update_swipe_timestamp();
DROP FUNCTION IF EXISTS calculate_age(DATE);
DROP FUNCTION IF EXISTS update_user_location();

DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS swipes CASCADE;
DROP TABLE IF EXISTS photos CASCADE;
DROP TABLE IF EXISTS user_preferences CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP EXTENSION IF EXISTS "uuid-ossp";
DROP EXTENSION IF EXISTS postgis;
