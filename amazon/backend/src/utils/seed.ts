import 'dotenv/config';
import { initializeDb, query, transaction } from '../services/database.js';
import bcrypt from 'bcrypt';

const sampleProducts = [
  {
    title: 'Apple MacBook Pro 14-inch M3',
    description: 'The most advanced Mac laptop for professionals. Powered by the M3 chip with 8-core CPU and 10-core GPU.',
    categorySlug: 'laptops',
    price: 1999.00,
    compareAtPrice: 2199.00,
    images: ['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=500'],
    attributes: { brand: 'Apple', processor: 'M3', ram: '16GB', storage: '512GB SSD' },
    stock: 50
  },
  {
    title: 'Sony WH-1000XM5 Wireless Headphones',
    description: 'Industry-leading noise cancellation with best-in-class sound quality and comfort.',
    categorySlug: 'electronics',
    price: 349.99,
    compareAtPrice: 399.99,
    images: ['https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500'],
    attributes: { brand: 'Sony', type: 'Over-ear', wireless: true, noiseCancelling: true },
    stock: 100
  },
  {
    title: 'iPhone 15 Pro Max 256GB',
    description: 'The ultimate iPhone with titanium design, A17 Pro chip, and Action button.',
    categorySlug: 'smartphones',
    price: 1199.00,
    images: ['https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=500'],
    attributes: { brand: 'Apple', storage: '256GB', color: 'Natural Titanium' },
    stock: 75
  },
  {
    title: 'Samsung Galaxy S24 Ultra',
    description: 'Galaxy AI is here. The most powerful Galaxy ever with built-in AI features.',
    categorySlug: 'smartphones',
    price: 1299.99,
    images: ['https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=500'],
    attributes: { brand: 'Samsung', storage: '256GB', color: 'Titanium Black' },
    stock: 60
  },
  {
    title: 'Kindle Paperwhite (16 GB)',
    description: 'The thinnest, lightest Kindle Paperwhite yet with 6.8" display and adjustable warm light.',
    categorySlug: 'electronics',
    price: 149.99,
    images: ['https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=500'],
    attributes: { brand: 'Amazon', storage: '16GB', waterproof: true },
    stock: 200
  },
  {
    title: 'The Psychology of Money',
    description: 'Timeless lessons on wealth, greed, and happiness by Morgan Housel.',
    categorySlug: 'fiction',
    price: 16.99,
    images: ['https://images.unsplash.com/photo-1544947950-fa07a98d237f?w=500'],
    attributes: { author: 'Morgan Housel', pages: 256, format: 'Paperback' },
    stock: 500
  },
  {
    title: 'Atomic Habits',
    description: 'An Easy & Proven Way to Build Good Habits & Break Bad Ones by James Clear.',
    categorySlug: 'fiction',
    price: 18.99,
    compareAtPrice: 24.99,
    images: ['https://images.unsplash.com/photo-1589829085413-56de8ae18c73?w=500'],
    attributes: { author: 'James Clear', pages: 320, format: 'Hardcover' },
    stock: 350
  },
  {
    title: 'Dell UltraSharp 27 4K Monitor',
    description: '27-inch 4K UHD monitor with USB-C hub and 100% sRGB coverage.',
    categorySlug: 'computers',
    price: 549.99,
    images: ['https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=500'],
    attributes: { brand: 'Dell', size: '27 inch', resolution: '4K UHD', panel: 'IPS' },
    stock: 40
  },
  {
    title: 'Logitech MX Master 3S Mouse',
    description: 'The most advanced Master Series mouse for productivity.',
    categorySlug: 'computers',
    price: 99.99,
    images: ['https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=500'],
    attributes: { brand: 'Logitech', wireless: true, dpi: 8000 },
    stock: 150
  },
  {
    title: 'Nike Air Max 270',
    description: "Nike's first lifestyle Air Max with the tallest Air unit yet for all-day comfort.",
    categorySlug: 'clothing',
    price: 150.00,
    images: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=500'],
    attributes: { brand: 'Nike', size: 'Multiple', color: 'Black/White' },
    stock: 80
  },
  {
    title: 'Instant Pot Duo 7-in-1',
    description: 'Electric pressure cooker, slow cooker, rice cooker, steamer, sauté pan, yogurt maker & warmer.',
    categorySlug: 'home-kitchen',
    price: 89.99,
    compareAtPrice: 119.99,
    images: ['https://images.unsplash.com/photo-1585515320310-259814833e62?w=500'],
    attributes: { brand: 'Instant Pot', capacity: '6 Quart', functions: 7 },
    stock: 120
  },
  {
    title: 'Dyson V15 Detect Vacuum',
    description: 'Reveals invisible dust. The most powerful, intelligent cordless vacuum.',
    categorySlug: 'home-kitchen',
    price: 749.99,
    images: ['https://images.unsplash.com/photo-1558317374-067fb5f30001?w=500'],
    attributes: { brand: 'Dyson', cordless: true, runtime: '60 minutes' },
    stock: 30
  }
];

async function seed() {
  try {
    console.log('Connecting to database...');
    await initializeDb();

    console.log('Seeding products...');

    // Get seller id
    const sellerResult = await query(
      "SELECT s.id FROM sellers s JOIN users u ON s.user_id = u.id WHERE u.email = 'seller@amazon.local'"
    );

    let sellerId = null;
    if (sellerResult.rows.length > 0) {
      sellerId = sellerResult.rows[0].id;
    }

    // Get category map
    const categoriesResult = await query('SELECT id, slug FROM categories');
    const categoryMap = new Map();
    categoriesResult.rows.forEach(cat => categoryMap.set(cat.slug, cat.id));

    for (const product of sampleProducts) {
      const categoryId = categoryMap.get(product.categorySlug) || null;

      // Generate slug
      const slug = product.title.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);

      await transaction(async (client) => {
        // Check if product already exists
        const existing = await client.query(
          'SELECT id FROM products WHERE title = $1',
          [product.title]
        );

        if (existing.rows.length > 0) {
          console.log(`Product already exists: ${product.title}`);
          return;
        }

        // Insert product
        const productResult = await client.query(
          `INSERT INTO products (seller_id, title, slug, description, category_id, price, compare_at_price, images, attributes, rating, review_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            sellerId,
            product.title,
            slug,
            product.description,
            categoryId,
            product.price,
            product.compareAtPrice || null,
            product.images,
            product.attributes,
            (3.5 + Math.random() * 1.5).toFixed(1), // Random rating 3.5-5.0
            Math.floor(Math.random() * 500) + 10 // Random review count 10-510
          ]
        );

        const productId = productResult.rows[0].id;

        // Add inventory
        await client.query(
          `INSERT INTO inventory (product_id, warehouse_id, quantity)
           SELECT $1, id, $2 FROM warehouses WHERE is_active = true LIMIT 1`,
          [productId, product.stock]
        );

        console.log(`Created: ${product.title}`);
      });

      // Small delay to ensure unique slugs
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    console.log('Seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding failed:', error);
    process.exit(1);
  }
}

seed();
