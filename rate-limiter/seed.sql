-- Seed data for development/testing

-- Insert default rate limit rules
INSERT INTO rate_limit_rules (name, endpoint_pattern, identifier_type, user_tier, algorithm, limit_value, window_seconds, priority, enabled)
VALUES
    ('Free tier global', NULL, 'api_key', 'free', 'sliding_window', 100, 60, 0, true),
    ('Pro tier global', NULL, 'api_key', 'pro', 'sliding_window', 1000, 60, 0, true),
    ('Enterprise global', NULL, 'api_key', 'enterprise', 'token_bucket', 10000, 60, 0, true)
ON CONFLICT DO NOTHING;
