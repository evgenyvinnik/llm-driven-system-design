-- 002_seed_data.sql
-- Insert sample data for testing

-- Insert sample advertisers
INSERT INTO advertisers (id, name) VALUES
    ('adv_001', 'Acme Corporation'),
    ('adv_002', 'TechStart Inc'),
    ('adv_003', 'Global Retail Co')
ON CONFLICT (id) DO NOTHING;

-- Insert sample campaigns
INSERT INTO campaigns (id, advertiser_id, name, status) VALUES
    ('camp_001', 'adv_001', 'Summer Sale 2024', 'active'),
    ('camp_002', 'adv_001', 'Brand Awareness', 'active'),
    ('camp_003', 'adv_002', 'Product Launch', 'active'),
    ('camp_004', 'adv_003', 'Holiday Special', 'active')
ON CONFLICT (id) DO NOTHING;

-- Insert sample ads
INSERT INTO ads (id, campaign_id, name, creative_url, status) VALUES
    ('ad_001', 'camp_001', 'Summer Banner 300x250', 'https://example.com/ads/summer-300x250.jpg', 'active'),
    ('ad_002', 'camp_001', 'Summer Banner 728x90', 'https://example.com/ads/summer-728x90.jpg', 'active'),
    ('ad_003', 'camp_002', 'Brand Video 30s', 'https://example.com/ads/brand-video.mp4', 'active'),
    ('ad_004', 'camp_003', 'Product Hero', 'https://example.com/ads/product-hero.jpg', 'active'),
    ('ad_005', 'camp_004', 'Holiday Promo', 'https://example.com/ads/holiday-promo.jpg', 'active')
ON CONFLICT (id) DO NOTHING;
