-- Seed data for development/testing

-- Insert sample users
INSERT INTO users (email, password_hash, name, role) VALUES
('admin@shopify-demo.local', '$2b$10$mMsTwOsDJ8Ej10Y0ExeI1uN6pm0WGfN4QqZwB0Bu6kU2DPL7UIHqm', 'Platform Admin', 'admin'),
('merchant@example.com', '$2b$10$mMsTwOsDJ8Ej10Y0ExeI1uN6pm0WGfN4QqZwB0Bu6kU2DPL7UIHqm', 'Demo Merchant', 'merchant');

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

-- Product imagery. The storefront renders a gray placeholder icon when a
-- product has no images, so without these the shop reads as broken rather than
-- empty. Inline SVG data URIs keep the fixture self-contained (no MinIO round
-- trip) while still exercising the JSONB images column end to end.
UPDATE products SET images = '[{"url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MDAiIGhlaWdodD0iNjAwIiB2aWV3Qm94PSIwIDAgNjAwIDYwMCI+CjxyZWN0IHdpZHRoPSI2MDAiIGhlaWdodD0iNjAwIiBmaWxsPSIjRUVGMkZGIi8+CjxjaXJjbGUgY3g9IjMwMCIgY3k9IjI5MCIgcj0iMjE1IiBmaWxsPSIjZmZmZmZmIiBvcGFjaXR5PSIwLjY1Ii8+CjxwYXRoIGQ9Ik0xNTAgMTcwIEwyMTUgMTMwIFEzMDAgMTg1IDM4NSAxMzAgTDQ1MCAxNzAgTDQxMCAyNDAgTDM4NSAyMjAgTDM4NSA0NzAgUTMwMCA0ODUgMjE1IDQ3MCBMMjE1IDIyMCBMMTkwIDI0MCBaIiBmaWxsPSIjNEY0NkU1Ii8+CjxwYXRoIGQ9Ik0xNTAgMTcwIEwyMTUgMTMwIFEzMDAgMTg1IDM4NSAxMzAgTDQ1MCAxNzAgTDQxMCAyNDAgTDM4NSAyMjAgTDM4NSA0NzAgUTMwMCA0ODUgMjE1IDQ3MCBMMjE1IDIyMCBMMTkwIDI0MCBaIiBmaWxsPSIjNDMzOENBIiBvcGFjaXR5PSIwLjI1IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg4LDEwKSIvPgo8dGV4dCB4PSIzMDAiIHk9IjU1MiIgZm9udC1mYW1pbHk9IkludGVyLEhlbHZldGljYSxBcmlhbCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjMwIiBmb250LXdlaWdodD0iNjAwIiBmaWxsPSIjMUYyOTM3IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5DbGFzc2ljIFQtU2hpcnQ8L3RleHQ+Cjwvc3ZnPg=="}]'::jsonb WHERE handle = 'classic-t-shirt' AND store_id = 1;
UPDATE products SET images = '[{"url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MDAiIGhlaWdodD0iNjAwIiB2aWV3Qm94PSIwIDAgNjAwIDYwMCI+CjxyZWN0IHdpZHRoPSI2MDAiIGhlaWdodD0iNjAwIiBmaWxsPSIjRjVGM0ZGIi8+CjxjaXJjbGUgY3g9IjMwMCIgY3k9IjI5MCIgcj0iMjE1IiBmaWxsPSIjZmZmZmZmIiBvcGFjaXR5PSIwLjY1Ii8+CjxwYXRoIGQ9Ik0xNTAgMTkwIEwyMjAgMTQwIFEzMDAgMjEwIDM4MCAxNDAgTDQ1MCAxOTAgTDQxNSAyNjUgTDM5MCAyNDUgTDM5MCA0ODAgUTMwMCA0OTUgMjEwIDQ4MCBMMjEwIDI0NSBMMTg1IDI2NSBaIiBmaWxsPSIjNkQyOEQ5Ii8+CjxwYXRoIGQ9Ik0xNTAgMTkwIEwyMjAgMTQwIFEzMDAgMjEwIDM4MCAxNDAgTDQ1MCAxOTAgTDQxNSAyNjUgTDM5MCAyNDUgTDM5MCA0ODAgUTMwMCA0OTUgMjEwIDQ4MCBMMjEwIDI0NSBMMTg1IDI2NSBaIiBmaWxsPSIjNUIyMUI2IiBvcGFjaXR5PSIwLjI1IiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg4LDEwKSIvPgo8dGV4dCB4PSIzMDAiIHk9IjU1MiIgZm9udC1mYW1pbHk9IkludGVyLEhlbHZldGljYSxBcmlhbCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjMwIiBmb250LXdlaWdodD0iNjAwIiBmaWxsPSIjMUYyOTM3IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5QcmVtaXVtIEhvb2RpZTwvdGV4dD4KPC9zdmc+"}]'::jsonb WHERE handle = 'premium-hoodie' AND store_id = 1;
UPDATE products SET images = '[{"url": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MDAiIGhlaWdodD0iNjAwIiB2aWV3Qm94PSIwIDAgNjAwIDYwMCI+CjxyZWN0IHdpZHRoPSI2MDAiIGhlaWdodD0iNjAwIiBmaWxsPSIjRUNGRUZGIi8+CjxjaXJjbGUgY3g9IjMwMCIgY3k9IjI5MCIgcj0iMjE1IiBmaWxsPSIjZmZmZmZmIiBvcGFjaXR5PSIwLjY1Ii8+CjxwYXRoIGQ9Ik0xMjAgMzgwIFExNDAgMzAwIDIwMCAzMDAgTDI1MCAzMDAgTDMxMCAyNTAgTDM1MCAyNjUgTDM0NSAzMTAgUTQyMCAzMzAgNDcwIDM1NSBRNDkwIDM2OCA0ODggMzk1IEw0ODggNDIwIEwxMjAgNDIwIFoiIGZpbGw9IiMwRTc0OTAiLz4KPHBhdGggZD0iTTEyMCAzODAgUTE0MCAzMDAgMjAwIDMwMCBMMjUwIDMwMCBMMzEwIDI1MCBMMzUwIDI2NSBMMzQ1IDMxMCBRNDIwIDMzMCA0NzAgMzU1IFE0OTAgMzY4IDQ4OCAzOTUgTDQ4OCA0MjAgTDEyMCA0MjAgWiIgZmlsbD0iIzE1NUU3NSIgb3BhY2l0eT0iMC4yNSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoOCwxMCkiLz4KPHRleHQgeD0iMzAwIiB5PSI1NTIiIGZvbnQtZmFtaWx5PSJJbnRlcixIZWx2ZXRpY2EsQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIzMCIgZm9udC13ZWlnaHQ9IjYwMCIgZmlsbD0iIzFGMjkzNyIgdGV4dC1hbmNob3I9Im1pZGRsZSI+UnVubmluZyBTaG9lczwvdGV4dD4KPC9zdmc+"}]'::jsonb WHERE handle = 'running-shoes' AND store_id = 1;

-- Customers and order history. The merchant dashboard's whole purpose is
-- revenue, order volume and fulfillment state; without these it renders $0.00
-- and three empty tabs, which says nothing about whether checkout works.
-- Spread over recent days so the dashboard's time-series has shape, and left
-- deliberately mixed (one refunded, one payment_pending, some unfulfilled) so
-- the status badges and the circuit-breaker's `payment_pending` path are both
-- visible rather than a uniform wall of "paid / fulfilled".
INSERT INTO customers (store_id, email, first_name, last_name, phone, accepts_marketing, created_at) VALUES
(1, 'sarah.chen@example.com',   'Sarah',  'Chen',     '+1-415-555-0142', true,  NOW() - INTERVAL '26 days'),
(1, 'marcus.reed@example.com',  'Marcus', 'Reed',     '+1-206-555-0188', false, NOW() - INTERVAL '19 days'),
(1, 'priya.nair@example.com',   'Priya',  'Nair',     '+1-312-555-0119', true,  NOW() - INTERVAL '12 days'),
(1, 'tom.becker@example.com',   'Tom',    'Becker',   '+1-718-555-0173', false, NOW() - INTERVAL '6 days'),
(1, 'ana.silva@example.com',    'Ana',    'Silva',    '+1-305-555-0164', true,  NOW() - INTERVAL '2 days');

INSERT INTO orders (store_id, order_number, customer_id, customer_email, subtotal, shipping_cost, tax, total, payment_status, fulfillment_status, shipping_address, created_at) VALUES
(1, '#1001', 1, 'sarah.chen@example.com',   109.98, 8.00, 9.35, 127.33, 'paid',            'fulfilled',   '{"first_name":"Sarah","last_name":"Chen","address1":"1420 Fell St","city":"San Francisco","province":"CA","zip":"94117","country":"US"}', NOW() - INTERVAL '24 days'),
(1, '#1002', 2, 'marcus.reed@example.com',  129.99, 0.00,  11.05, 141.04, 'paid',            'fulfilled',   '{"first_name":"Marcus","last_name":"Reed","address1":"88 Pike St","city":"Seattle","province":"WA","zip":"98101","country":"US"}',      NOW() - INTERVAL '18 days'),
(1, '#1003', 3, 'priya.nair@example.com',    79.99, 8.00,  6.80,  94.79, 'refunded',        'unfulfilled', '{"first_name":"Priya","last_name":"Nair","address1":"310 W Erie St","city":"Chicago","province":"IL","zip":"60654","country":"US"}',    NOW() - INTERVAL '11 days'),
(1, '#1004', 4, 'tom.becker@example.com',   239.97, 0.00,  20.40, 260.37, 'paid',            'partial',     '{"first_name":"Tom","last_name":"Becker","address1":"55 Bedford Ave","city":"Brooklyn","province":"NY","zip":"11211","country":"US"}',  NOW() - INTERVAL '5 days'),
(1, '#1005', 5, 'ana.silva@example.com',     59.98, 8.00,  5.10,  73.08, 'paid',            'unfulfilled', '{"first_name":"Ana","last_name":"Silva","address1":"720 Ocean Dr","city":"Miami","province":"FL","zip":"33139","country":"US"}',       NOW() - INTERVAL '2 days'),
(1, '#1006', 3, 'priya.nair@example.com',   129.99, 8.00,  11.05, 149.04, 'payment_pending', 'unfulfilled', '{"first_name":"Priya","last_name":"Nair","address1":"310 W Erie St","city":"Chicago","province":"IL","zip":"60654","country":"US"}',    NOW() - INTERVAL '9 hours');

INSERT INTO order_items (order_id, store_id, variant_id, title, variant_title, sku, quantity, price, total) VALUES
(1, 1, 2,  'Classic T-Shirt', 'Medium / Black',  'TS-M-BLACK',  2, 29.99,  59.98),
(1, 1, 6,  'Premium Hoodie',  'Small / Gray',    'HO-S-GRAY',   1, 79.99,  79.99),
(2, 1, 9,  'Running Shoes',   'Size 9 / Black',  'RS-9-BLACK',  1, 129.99, 129.99),
(3, 1, 7,  'Premium Hoodie',  'Medium / Gray',   'HO-M-GRAY',   1, 79.99,  79.99),
(4, 1, 10, 'Running Shoes',   'Size 10 / Black', 'RS-10-BLACK', 1, 129.99, 129.99),
(4, 1, 8,  'Premium Hoodie',  'Large / Gray',    'HO-L-GRAY',   1, 79.99,  79.99),
(4, 1, 3,  'Classic T-Shirt', 'Large / Black',   'TS-L-BLACK',  1, 29.99,  29.99),
(5, 1, 5,  'Classic T-Shirt', 'Medium / White',  'TS-M-WHITE',  2, 29.99,  59.98),
(6, 1, 11, 'Running Shoes',   'Size 11 / Black', 'RS-11-BLACK', 1, 129.99, 129.99);
