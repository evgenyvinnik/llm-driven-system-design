-- Seed Data for Ad Click Aggregator
-- Run after init.sql: psql -d ad_clicks -f seed.sql
-- Uses ON CONFLICT DO NOTHING for idempotency

-- ============================================================================
-- USERS (for admin dashboard access)
-- ============================================================================

-- password123 = $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Note: This project doesn't have a users table in the schema
-- The focus is on ad metrics, not user authentication

-- ============================================================================
-- ADDITIONAL ADVERTISERS
-- ============================================================================

INSERT INTO advertisers (id, name) VALUES
    ('adv_004', 'FoodDelivery Plus'),
    ('adv_005', 'FinTech Solutions'),
    ('adv_006', 'Travel Adventures Inc'),
    ('adv_007', 'Gaming Universe'),
    ('adv_008', 'Health & Wellness Co')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- ADDITIONAL CAMPAIGNS
-- ============================================================================

INSERT INTO campaigns (id, advertiser_id, name, status) VALUES
    -- FoodDelivery Plus campaigns
    ('camp_005', 'adv_004', 'Free Delivery Week', 'active'),
    ('camp_006', 'adv_004', 'New Restaurant Launch', 'active'),
    -- FinTech Solutions campaigns
    ('camp_007', 'adv_005', 'Investment App Promo', 'active'),
    ('camp_008', 'adv_005', 'Credit Card Cashback', 'paused'),
    -- Travel Adventures campaigns
    ('camp_009', 'adv_006', 'Summer Destinations 2024', 'active'),
    ('camp_010', 'adv_006', 'Last Minute Deals', 'active'),
    -- Gaming Universe campaigns
    ('camp_011', 'adv_007', 'New Game Release', 'active'),
    ('camp_012', 'adv_007', 'Gaming Tournament', 'active'),
    -- Health & Wellness campaigns
    ('camp_013', 'adv_008', 'Fitness App Launch', 'active'),
    ('camp_014', 'adv_008', 'Mental Health Awareness', 'active')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- ADDITIONAL ADS
-- ============================================================================

INSERT INTO ads (id, campaign_id, name, creative_url, status) VALUES
    -- FoodDelivery Plus ads
    ('ad_006', 'camp_005', 'Free Delivery Banner', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=300', 'active'),
    ('ad_007', 'camp_005', 'Food Hero Image', 'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=728', 'active'),
    ('ad_008', 'camp_006', 'New Restaurant Carousel', 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=300', 'active'),
    -- FinTech Solutions ads
    ('ad_009', 'camp_007', 'Investment Dashboard', 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=300', 'active'),
    ('ad_010', 'camp_008', 'Cashback Card Image', 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=300', 'paused'),
    -- Travel Adventures ads
    ('ad_011', 'camp_009', 'Beach Vacation Banner', 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=728', 'active'),
    ('ad_012', 'camp_009', 'Mountain Escape', 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=300', 'active'),
    ('ad_013', 'camp_010', 'Last Minute Deals CTA', 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=300', 'active'),
    -- Gaming Universe ads
    ('ad_014', 'camp_011', 'Game Trailer Thumbnail', 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=300', 'active'),
    ('ad_015', 'camp_012', 'Tournament Registration', 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=728', 'active'),
    -- Health & Wellness ads
    ('ad_016', 'camp_013', 'Fitness App Screenshot', 'https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=300', 'active'),
    ('ad_017', 'camp_014', 'Mindfulness Banner', 'https://images.unsplash.com/photo-1545389336-cf090694435e?w=300', 'active')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- SAMPLE CLICK EVENTS (last 24 hours)
-- ============================================================================

-- Generate sample click events for testing analytics
-- Using a series of timestamps from the last 24 hours

INSERT INTO click_events (click_id, ad_id, campaign_id, advertiser_id, user_id, timestamp, device_type, os, browser, country, region, ip_hash, is_fraudulent, fraud_reason) VALUES
    -- Morning clicks (mobile-heavy)
    ('clk_001', 'ad_001', 'camp_001', 'adv_001', 'user_101', NOW() - INTERVAL '23 hours', 'mobile', 'iOS', 'Safari', 'USA', 'California', 'hash_a1b2c3', false, NULL),
    ('clk_002', 'ad_001', 'camp_001', 'adv_001', 'user_102', NOW() - INTERVAL '23 hours', 'mobile', 'Android', 'Chrome', 'USA', 'New York', 'hash_d4e5f6', false, NULL),
    ('clk_003', 'ad_002', 'camp_001', 'adv_001', 'user_103', NOW() - INTERVAL '22 hours', 'desktop', 'Windows', 'Chrome', 'CAN', 'Ontario', 'hash_g7h8i9', false, NULL),
    ('clk_004', 'ad_003', 'camp_002', 'adv_001', 'user_104', NOW() - INTERVAL '22 hours', 'mobile', 'iOS', 'Safari', 'GBR', 'London', 'hash_j0k1l2', false, NULL),
    ('clk_005', 'ad_004', 'camp_003', 'adv_002', 'user_105', NOW() - INTERVAL '21 hours', 'tablet', 'iOS', 'Safari', 'USA', 'Texas', 'hash_m3n4o5', false, NULL),

    -- Midday clicks (mix of devices)
    ('clk_006', 'ad_006', 'camp_005', 'adv_004', 'user_106', NOW() - INTERVAL '18 hours', 'mobile', 'Android', 'Chrome', 'USA', 'Florida', 'hash_p6q7r8', false, NULL),
    ('clk_007', 'ad_007', 'camp_005', 'adv_004', 'user_107', NOW() - INTERVAL '17 hours', 'desktop', 'macOS', 'Safari', 'USA', 'California', 'hash_s9t0u1', false, NULL),
    ('clk_008', 'ad_011', 'camp_009', 'adv_006', 'user_108', NOW() - INTERVAL '16 hours', 'mobile', 'iOS', 'Safari', 'AUS', 'Sydney', 'hash_v2w3x4', false, NULL),
    ('clk_009', 'ad_012', 'camp_009', 'adv_006', 'user_109', NOW() - INTERVAL '15 hours', 'desktop', 'Windows', 'Edge', 'DEU', 'Berlin', 'hash_y5z6a7', false, NULL),
    ('clk_010', 'ad_014', 'camp_011', 'adv_007', 'user_110', NOW() - INTERVAL '14 hours', 'desktop', 'Windows', 'Chrome', 'USA', 'Washington', 'hash_b8c9d0', false, NULL),

    -- Evening clicks (desktop-heavy)
    ('clk_011', 'ad_009', 'camp_007', 'adv_005', 'user_111', NOW() - INTERVAL '10 hours', 'desktop', 'macOS', 'Chrome', 'USA', 'New York', 'hash_e1f2g3', false, NULL),
    ('clk_012', 'ad_016', 'camp_013', 'adv_008', 'user_112', NOW() - INTERVAL '9 hours', 'mobile', 'iOS', 'Safari', 'USA', 'Colorado', 'hash_h4i5j6', false, NULL),
    ('clk_013', 'ad_017', 'camp_014', 'adv_008', 'user_113', NOW() - INTERVAL '8 hours', 'tablet', 'Android', 'Chrome', 'CAN', 'British Columbia', 'hash_k7l8m9', false, NULL),
    ('clk_014', 'ad_015', 'camp_012', 'adv_007', 'user_114', NOW() - INTERVAL '7 hours', 'desktop', 'Windows', 'Firefox', 'GBR', 'Manchester', 'hash_n0o1p2', false, NULL),
    ('clk_015', 'ad_005', 'camp_004', 'adv_003', 'user_115', NOW() - INTERVAL '6 hours', 'mobile', 'Android', 'Chrome', 'BRA', 'Sao Paulo', 'hash_q3r4s5', false, NULL),

    -- Recent clicks (last few hours)
    ('clk_016', 'ad_001', 'camp_001', 'adv_001', 'user_116', NOW() - INTERVAL '5 hours', 'mobile', 'iOS', 'Safari', 'USA', 'Illinois', 'hash_t6u7v8', false, NULL),
    ('clk_017', 'ad_008', 'camp_006', 'adv_004', 'user_117', NOW() - INTERVAL '4 hours', 'desktop', 'Windows', 'Chrome', 'USA', 'Arizona', 'hash_w9x0y1', false, NULL),
    ('clk_018', 'ad_013', 'camp_010', 'adv_006', 'user_118', NOW() - INTERVAL '3 hours', 'mobile', 'Android', 'Chrome', 'MEX', 'Mexico City', 'hash_z2a3b4', false, NULL),
    ('clk_019', 'ad_006', 'camp_005', 'adv_004', 'user_119', NOW() - INTERVAL '2 hours', 'desktop', 'macOS', 'Safari', 'JPN', 'Tokyo', 'hash_c5d6e7', false, NULL),
    ('clk_020', 'ad_011', 'camp_009', 'adv_006', 'user_120', NOW() - INTERVAL '1 hour', 'mobile', 'iOS', 'Safari', 'FRA', 'Paris', 'hash_f8g9h0', false, NULL),

    -- Some fraudulent clicks for testing fraud detection
    ('clk_021', 'ad_001', 'camp_001', 'adv_001', 'user_999', NOW() - INTERVAL '12 hours', 'mobile', 'iOS', 'Safari', 'USA', 'Unknown', 'hash_fraud1', true, 'High velocity clicks'),
    ('clk_022', 'ad_002', 'camp_001', 'adv_001', 'user_999', NOW() - INTERVAL '12 hours', 'mobile', 'iOS', 'Safari', 'USA', 'Unknown', 'hash_fraud1', true, 'Same user multiple ads'),
    ('clk_023', 'ad_003', 'camp_002', 'adv_001', NULL, NOW() - INTERVAL '11 hours', 'unknown', 'unknown', 'unknown', 'unknown', NULL, 'hash_fraud2', true, 'Missing device info'),
    ('clk_024', 'ad_004', 'camp_003', 'adv_002', 'bot_001', NOW() - INTERVAL '10 hours', 'desktop', 'Linux', 'wget', 'RUS', NULL, 'hash_fraud3', true, 'Bot user agent'),
    ('clk_025', 'ad_005', 'camp_004', 'adv_003', 'user_998', NOW() - INTERVAL '9 hours', 'mobile', 'Android', 'Chrome', 'CHN', NULL, 'hash_fraud4', true, 'Suspicious IP pattern')
ON CONFLICT (click_id) DO NOTHING;

-- ============================================================================
-- AGGREGATED DATA (for immediate dashboard display)
-- ============================================================================

-- Pre-populate hourly aggregates for the past 24 hours
INSERT INTO click_aggregates_hour (time_bucket, ad_id, campaign_id, advertiser_id, country, device_type, click_count, unique_users, fraud_count)
SELECT
    date_trunc('hour', ce.timestamp) as time_bucket,
    ce.ad_id,
    ce.campaign_id,
    ce.advertiser_id,
    ce.country,
    ce.device_type,
    COUNT(*) as click_count,
    COUNT(DISTINCT ce.user_id) as unique_users,
    COUNT(*) FILTER (WHERE ce.is_fraudulent) as fraud_count
FROM click_events ce
WHERE ce.timestamp > NOW() - INTERVAL '24 hours'
GROUP BY date_trunc('hour', ce.timestamp), ce.ad_id, ce.campaign_id, ce.advertiser_id, ce.country, ce.device_type
ON CONFLICT (time_bucket, ad_id, country, device_type) DO UPDATE SET
    click_count = EXCLUDED.click_count,
    unique_users = EXCLUDED.unique_users,
    fraud_count = EXCLUDED.fraud_count,
    updated_at = NOW();

-- Pre-populate daily aggregates
INSERT INTO click_aggregates_day (time_bucket, ad_id, campaign_id, advertiser_id, country, device_type, click_count, unique_users, fraud_count)
SELECT
    date_trunc('day', ce.timestamp)::date as time_bucket,
    ce.ad_id,
    ce.campaign_id,
    ce.advertiser_id,
    ce.country,
    ce.device_type,
    COUNT(*) as click_count,
    COUNT(DISTINCT ce.user_id) as unique_users,
    COUNT(*) FILTER (WHERE ce.is_fraudulent) as fraud_count
FROM click_events ce
WHERE ce.timestamp > NOW() - INTERVAL '7 days'
GROUP BY date_trunc('day', ce.timestamp)::date, ce.ad_id, ce.campaign_id, ce.advertiser_id, ce.country, ce.device_type
ON CONFLICT (time_bucket, ad_id, country, device_type) DO UPDATE SET
    click_count = EXCLUDED.click_count,
    unique_users = EXCLUDED.unique_users,
    fraud_count = EXCLUDED.fraud_count,
    updated_at = NOW();
