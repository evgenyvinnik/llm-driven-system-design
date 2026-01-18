-- Seed data for development/testing
-- Price Tracking Sample Data

-- Insert some default scraper configurations
INSERT INTO scraper_configs (domain, price_selector, title_selector, image_selector, parser_type, requires_js)
VALUES
    ('amazon.com', '.a-price .a-offscreen', '#productTitle', '#landingImage', 'css', false),
    ('amazon.ca', '.a-price .a-offscreen', '#productTitle', '#landingImage', 'css', false),
    ('ebay.com', '.x-price-primary span', '.x-item-title__mainTitle', '.ux-image-carousel-item img', 'css', false),
    ('walmart.com', '[data-testid="price-wrap"] span', '[data-testid="product-title"]', '[data-testid="hero-image"] img', 'css', true),
    ('bestbuy.com', '.priceView-customer-price span', '.sku-title h1', '.shop-media-gallery img', 'css', true),
    ('target.com', '[data-test="product-price"]', '[data-test="product-title"]', '[data-test="product-hero"] img', 'css', true),
    ('newegg.com', '.price-current', '.product-title', '.product-view-img-original', 'css', false)
ON CONFLICT (domain) DO NOTHING;

-- Create a default admin user (password: admin123)
-- Note: In production, use proper password hashing
INSERT INTO users (email, password_hash, role)
VALUES ('admin@pricetracker.local', '$2b$10$rQEY1xN1K1vCxQz8s1Xn2Ov.QW7xQW7xQW7xQW7xQW7xQW7xQW7', 'admin')
ON CONFLICT (email) DO NOTHING;
