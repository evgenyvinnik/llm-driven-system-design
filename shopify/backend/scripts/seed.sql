-- Seed data for development/testing

-- Insert sample users
INSERT INTO users (email, password_hash, name, role) VALUES
('admin@shopify-demo.local', crypt('admin123', gen_salt('bf')), 'Platform Admin', 'admin'),
('merchant@example.com', crypt('merchant123', gen_salt('bf')), 'Demo Merchant', 'merchant');

-- Insert sample store
INSERT INTO stores (owner_id, name, subdomain, description, theme) VALUES
(2, 'Demo Store', 'demo', 'A demonstration store for testing',
 '{"primaryColor": "#4F46E5", "secondaryColor": "#10B981", "fontFamily": "Inter"}');

-- Insert sample products
INSERT INTO products (store_id, handle, title, description, status) VALUES
(1, 'classic-t-shirt', 'Classic T-Shirt', 'A comfortable everyday t-shirt made from 100% organic cotton.', 'active'),
(1, 'premium-hoodie', 'Premium Hoodie', 'Stay warm and stylish with our premium hoodie.', 'active'),
(1, 'running-shoes', 'Running Shoes', 'Lightweight and responsive running shoes for all distances.', 'active');

-- Insert variants for products
INSERT INTO variants (product_id, store_id, sku, title, price, compare_at_price, inventory_quantity, options) VALUES
(1, 1, 'TS-S-BLACK', 'Small / Black', 29.99, 39.99, 50, '{"size": "S", "color": "Black"}'),
(1, 1, 'TS-M-BLACK', 'Medium / Black', 29.99, 39.99, 75, '{"size": "M", "color": "Black"}'),
(1, 1, 'TS-L-BLACK', 'Large / Black', 29.99, 39.99, 60, '{"size": "L", "color": "Black"}'),
(1, 1, 'TS-S-WHITE', 'Small / White', 29.99, 39.99, 40, '{"size": "S", "color": "White"}'),
(1, 1, 'TS-M-WHITE', 'Medium / White', 29.99, 39.99, 55, '{"size": "M", "color": "White"}'),
(2, 1, 'HO-S-GRAY', 'Small / Gray', 79.99, 99.99, 30, '{"size": "S", "color": "Gray"}'),
(2, 1, 'HO-M-GRAY', 'Medium / Gray', 79.99, 99.99, 45, '{"size": "M", "color": "Gray"}'),
(2, 1, 'HO-L-GRAY', 'Large / Gray', 79.99, 99.99, 35, '{"size": "L", "color": "Gray"}'),
(3, 1, 'RS-9-BLACK', 'Size 9 / Black', 129.99, 159.99, 20, '{"size": "9", "color": "Black"}'),
(3, 1, 'RS-10-BLACK', 'Size 10 / Black', 129.99, 159.99, 25, '{"size": "10", "color": "Black"}'),
(3, 1, 'RS-11-BLACK', 'Size 11 / Black', 129.99, 159.99, 15, '{"size": "11", "color": "Black"}');

-- Insert sample collection
INSERT INTO collections (store_id, handle, title, description) VALUES
(1, 'summer-essentials', 'Summer Essentials', 'Stay cool with our summer collection');

INSERT INTO collection_products (collection_id, product_id, position) VALUES
(1, 1, 0),
(1, 2, 1);
