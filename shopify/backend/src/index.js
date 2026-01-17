import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config/index.js';

// Auth
import {
  authMiddleware,
  storeOwnerMiddleware,
  login,
  register,
  logout,
  me,
} from './middleware/auth.js';

// Routes
import {
  resolveStore,
  requireStore,
  getStore,
  getStoreBySubdomain,
  listStores,
  createStore,
  updateStore,
  getStoreAnalytics,
} from './routes/stores.js';

import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  updateVariant,
  addVariant,
  deleteVariant,
  listStorefrontProducts,
  getStorefrontProduct,
} from './routes/products.js';

import {
  listOrders,
  getOrder,
  updateOrder,
  getCart,
  addToCart,
  updateCartItem,
  checkout,
  listCustomers,
  getCustomer,
} from './routes/orders.js';

import {
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  listStorefrontCollections,
  getStorefrontCollection,
} from './routes/collections.js';

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== Auth Routes =====
app.post('/api/auth/login', login);
app.post('/api/auth/register', register);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', me);

// ===== Admin API Routes (authenticated) =====

// Stores
app.get('/api/stores', authMiddleware, listStores);
app.post('/api/stores', authMiddleware, createStore);
app.get('/api/stores/:storeId', authMiddleware, getStore);
app.put('/api/stores/:storeId', storeOwnerMiddleware, updateStore);
app.get('/api/stores/:storeId/analytics', storeOwnerMiddleware, getStoreAnalytics);

// Products (admin)
app.get('/api/stores/:storeId/products', storeOwnerMiddleware, listProducts);
app.post('/api/stores/:storeId/products', storeOwnerMiddleware, createProduct);
app.get('/api/stores/:storeId/products/:productId', storeOwnerMiddleware, getProduct);
app.put('/api/stores/:storeId/products/:productId', storeOwnerMiddleware, updateProduct);
app.delete('/api/stores/:storeId/products/:productId', storeOwnerMiddleware, deleteProduct);

// Variants (admin)
app.post('/api/stores/:storeId/products/:productId/variants', storeOwnerMiddleware, addVariant);
app.put('/api/stores/:storeId/variants/:variantId', storeOwnerMiddleware, updateVariant);
app.delete('/api/stores/:storeId/variants/:variantId', storeOwnerMiddleware, deleteVariant);

// Collections (admin)
app.get('/api/stores/:storeId/collections', storeOwnerMiddleware, listCollections);
app.post('/api/stores/:storeId/collections', storeOwnerMiddleware, createCollection);
app.get('/api/stores/:storeId/collections/:collectionId', storeOwnerMiddleware, getCollection);
app.put('/api/stores/:storeId/collections/:collectionId', storeOwnerMiddleware, updateCollection);
app.delete('/api/stores/:storeId/collections/:collectionId', storeOwnerMiddleware, deleteCollection);

// Orders (admin)
app.get('/api/stores/:storeId/orders', storeOwnerMiddleware, listOrders);
app.get('/api/stores/:storeId/orders/:orderId', storeOwnerMiddleware, getOrder);
app.put('/api/stores/:storeId/orders/:orderId', storeOwnerMiddleware, updateOrder);

// Customers (admin)
app.get('/api/stores/:storeId/customers', storeOwnerMiddleware, listCustomers);
app.get('/api/stores/:storeId/customers/:customerId', storeOwnerMiddleware, getCustomer);

// ===== Storefront API Routes (public) =====

// Store info
app.get('/api/storefront/:subdomain', getStoreBySubdomain);

// Products (storefront)
app.get('/api/storefront/:subdomain/products', resolveStore, listStorefrontProducts);
app.get('/api/storefront/:subdomain/products/:handle', resolveStore, getStorefrontProduct);

// Collections (storefront)
app.get('/api/storefront/:subdomain/collections', resolveStore, listStorefrontCollections);
app.get('/api/storefront/:subdomain/collections/:handle', resolveStore, getStorefrontCollection);

// Cart (storefront)
app.get('/api/storefront/:subdomain/cart', resolveStore, getCart);
app.post('/api/storefront/:subdomain/cart/add', resolveStore, addToCart);
app.put('/api/storefront/:subdomain/cart/update', resolveStore, updateCartItem);

// Checkout (storefront)
app.post('/api/storefront/:subdomain/checkout', resolveStore, checkout);

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = config.server.port;
app.listen(PORT, () => {
  console.log(`Shopify backend running on http://localhost:${PORT}`);
  console.log(`API docs: http://localhost:${PORT}/health`);
});
