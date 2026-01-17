import bcrypt from 'bcrypt';
import db from './index.js';

const categories = [
  { name: 'Jewelry & Accessories', slug: 'jewelry-accessories' },
  { name: 'Clothing & Shoes', slug: 'clothing-shoes' },
  { name: 'Home & Living', slug: 'home-living' },
  { name: 'Art & Collectibles', slug: 'art-collectibles' },
  { name: 'Craft Supplies', slug: 'craft-supplies' },
  { name: 'Vintage', slug: 'vintage' },
  { name: 'Weddings', slug: 'weddings' },
  { name: 'Toys & Games', slug: 'toys-games' },
];

const users = [
  {
    email: 'alice@example.com',
    password: 'password123',
    username: 'alicecraft',
    full_name: 'Alice Johnson',
    role: 'user',
  },
  {
    email: 'bob@example.com',
    password: 'password123',
    username: 'bobsworkshop',
    full_name: 'Bob Smith',
    role: 'user',
  },
  {
    email: 'carol@example.com',
    password: 'password123',
    username: 'carolcreates',
    full_name: 'Carol Williams',
    role: 'user',
  },
  {
    email: 'buyer@example.com',
    password: 'password123',
    username: 'happybuyer',
    full_name: 'Happy Buyer',
    role: 'user',
  },
  {
    email: 'admin@example.com',
    password: 'admin123',
    username: 'admin',
    full_name: 'Admin User',
    role: 'admin',
  },
];

const shops = [
  {
    ownerEmail: 'alice@example.com',
    name: 'Alice\'s Handmade Jewelry',
    slug: 'alices-handmade-jewelry',
    description: 'Beautiful handcrafted jewelry made with love. Each piece is unique and made with high-quality materials.',
    location: 'Portland, Oregon',
    shipping_policy: { processing_days: 3, ships_from: 'USA' },
    return_policy: 'Returns accepted within 14 days',
  },
  {
    ownerEmail: 'bob@example.com',
    name: 'Bob\'s Woodwork Studio',
    slug: 'bobs-woodwork-studio',
    description: 'Handcrafted wooden items for your home. Made from sustainably sourced wood with traditional techniques.',
    location: 'Austin, Texas',
    shipping_policy: { processing_days: 5, ships_from: 'USA' },
    return_policy: 'Returns accepted within 30 days',
  },
  {
    ownerEmail: 'carol@example.com',
    name: 'Carol\'s Vintage Finds',
    slug: 'carols-vintage-finds',
    description: 'Curated collection of vintage and antique items. Each piece has a story to tell.',
    location: 'Brooklyn, New York',
    shipping_policy: { processing_days: 2, ships_from: 'USA' },
    return_policy: 'All sales final for vintage items',
  },
];

const products = [
  // Alice's jewelry
  {
    shopSlug: 'alices-handmade-jewelry',
    categorySlug: 'jewelry-accessories',
    title: 'Handmade Silver Moon Necklace',
    description: 'A beautiful crescent moon pendant on a delicate sterling silver chain. Perfect for everyday wear or special occasions. Each necklace is handcrafted with care.',
    price: 45.00,
    quantity: 3,
    tags: ['necklace', 'silver', 'moon', 'handmade', 'pendant'],
    images: ['https://picsum.photos/seed/moon-necklace/400/400'],
    is_handmade: true,
    shipping_price: 5.00,
    processing_time: '3-5 business days',
  },
  {
    shopSlug: 'alices-handmade-jewelry',
    categorySlug: 'jewelry-accessories',
    title: 'Crystal Drop Earrings',
    description: 'Elegant crystal drop earrings that catch the light beautifully. Made with Swarovski crystals and sterling silver hooks.',
    price: 35.00,
    quantity: 5,
    tags: ['earrings', 'crystal', 'silver', 'handmade', 'elegant'],
    images: ['https://picsum.photos/seed/crystal-earrings/400/400'],
    is_handmade: true,
    shipping_price: 4.00,
    processing_time: '3-5 business days',
  },
  {
    shopSlug: 'alices-handmade-jewelry',
    categorySlug: 'jewelry-accessories',
    title: 'Gemstone Stacking Rings Set',
    description: 'Set of three delicate stacking rings with semi-precious gemstones. Mix and match for your own unique look.',
    price: 68.00,
    quantity: 2,
    tags: ['rings', 'gemstone', 'stacking', 'handmade', 'set'],
    images: ['https://picsum.photos/seed/stacking-rings/400/400'],
    is_handmade: true,
    shipping_price: 4.00,
    processing_time: '5-7 business days',
  },
  // Bob's woodwork
  {
    shopSlug: 'bobs-woodwork-studio',
    categorySlug: 'home-living',
    title: 'Handcrafted Walnut Cutting Board',
    description: 'Beautiful walnut cutting board with natural edge. Food-safe finish. A perfect addition to any kitchen.',
    price: 85.00,
    quantity: 4,
    tags: ['cutting board', 'walnut', 'kitchen', 'handmade', 'wood'],
    images: ['https://picsum.photos/seed/cutting-board/400/400'],
    is_handmade: true,
    shipping_price: 12.00,
    processing_time: '5-7 business days',
  },
  {
    shopSlug: 'bobs-woodwork-studio',
    categorySlug: 'home-living',
    title: 'Oak Desk Organizer',
    description: 'Keep your workspace tidy with this handmade oak desk organizer. Features compartments for pens, cards, and small items.',
    price: 55.00,
    quantity: 6,
    tags: ['desk organizer', 'oak', 'office', 'handmade', 'wood'],
    images: ['https://picsum.photos/seed/desk-organizer/400/400'],
    is_handmade: true,
    shipping_price: 8.00,
    processing_time: '5-7 business days',
  },
  {
    shopSlug: 'bobs-woodwork-studio',
    categorySlug: 'home-living',
    title: 'Cherry Wood Jewelry Box',
    description: 'Elegant jewelry box crafted from cherry wood with velvet lining. Features multiple compartments and a mirror.',
    price: 120.00,
    quantity: 2,
    tags: ['jewelry box', 'cherry wood', 'handmade', 'gift'],
    images: ['https://picsum.photos/seed/jewelry-box/400/400'],
    is_handmade: true,
    shipping_price: 10.00,
    processing_time: '7-10 business days',
  },
  // Carol's vintage
  {
    shopSlug: 'carols-vintage-finds',
    categorySlug: 'vintage',
    title: 'Vintage 1960s Brass Lamp',
    description: 'Beautiful mid-century brass table lamp in excellent condition. Original wiring has been updated for safety.',
    price: 145.00,
    quantity: 1,
    tags: ['lamp', 'brass', 'vintage', '1960s', 'mid-century'],
    images: ['https://picsum.photos/seed/brass-lamp/400/400'],
    is_vintage: true,
    is_handmade: false,
    shipping_price: 20.00,
    processing_time: '2-3 business days',
  },
  {
    shopSlug: 'carols-vintage-finds',
    categorySlug: 'vintage',
    title: 'Antique Silver Tea Set',
    description: 'Gorgeous antique silver-plated tea set from the 1920s. Includes teapot, creamer, and sugar bowl.',
    price: 285.00,
    quantity: 1,
    tags: ['tea set', 'silver', 'antique', '1920s', 'vintage'],
    images: ['https://picsum.photos/seed/tea-set/400/400'],
    is_vintage: true,
    is_handmade: false,
    shipping_price: 25.00,
    processing_time: '2-3 business days',
  },
  {
    shopSlug: 'carols-vintage-finds',
    categorySlug: 'clothing-shoes',
    title: 'Vintage Leather Messenger Bag',
    description: 'Classic leather messenger bag from the 1970s. Well-worn patina adds character. Great for daily use.',
    price: 95.00,
    quantity: 1,
    tags: ['bag', 'leather', 'messenger', 'vintage', '1970s'],
    images: ['https://picsum.photos/seed/messenger-bag/400/400'],
    is_vintage: true,
    is_handmade: false,
    shipping_price: 12.00,
    processing_time: '2-3 business days',
  },
  {
    shopSlug: 'carols-vintage-finds',
    categorySlug: 'art-collectibles',
    title: 'Retro Ceramic Vase Collection',
    description: 'Set of three colorful ceramic vases from the 1950s. Perfect for displaying flowers or as standalone art pieces.',
    price: 175.00,
    quantity: 1,
    tags: ['vase', 'ceramic', 'retro', '1950s', 'vintage', 'collection'],
    images: ['https://picsum.photos/seed/ceramic-vases/400/400'],
    is_vintage: true,
    is_handmade: false,
    shipping_price: 18.00,
    processing_time: '2-3 business days',
  },
];

async function seed() {
  console.log('Seeding database...');

  try {
    // Insert categories
    console.log('Inserting categories...');
    for (const category of categories) {
      await db.query(
        'INSERT INTO categories (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING',
        [category.name, category.slug]
      );
    }

    // Insert users
    console.log('Inserting users...');
    for (const user of users) {
      const passwordHash = await bcrypt.hash(user.password, 10);
      await db.query(
        `INSERT INTO users (email, password_hash, username, full_name, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING`,
        [user.email, passwordHash, user.username, user.full_name, user.role]
      );
    }

    // Insert shops
    console.log('Inserting shops...');
    for (const shop of shops) {
      const userResult = await db.query('SELECT id FROM users WHERE email = $1', [shop.ownerEmail]);
      if (userResult.rows.length > 0) {
        await db.query(
          `INSERT INTO shops (owner_id, name, slug, description, location, shipping_policy, return_policy)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (slug) DO NOTHING`,
          [userResult.rows[0].id, shop.name, shop.slug, shop.description, shop.location, JSON.stringify(shop.shipping_policy), shop.return_policy]
        );
      }
    }

    // Insert products
    console.log('Inserting products...');
    for (const product of products) {
      const shopResult = await db.query('SELECT id FROM shops WHERE slug = $1', [product.shopSlug]);
      const categoryResult = await db.query('SELECT id FROM categories WHERE slug = $1', [product.categorySlug]);

      if (shopResult.rows.length > 0 && categoryResult.rows.length > 0) {
        await db.query(
          `INSERT INTO products (shop_id, category_id, title, description, price, quantity, tags, images, is_vintage, is_handmade, shipping_price, processing_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            shopResult.rows[0].id,
            categoryResult.rows[0].id,
            product.title,
            product.description,
            product.price,
            product.quantity,
            product.tags,
            product.images,
            product.is_vintage || false,
            product.is_handmade !== false,
            product.shipping_price,
            product.processing_time,
          ]
        );
      }
    }

    console.log('Seeding completed successfully!');
  } catch (error) {
    console.error('Seeding failed:', error);
    throw error;
  } finally {
    await db.pool.end();
  }
}

seed();
