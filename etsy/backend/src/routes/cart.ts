import { Router, Request, Response } from 'express';
import db from '../db/index.js';
import { isAuthenticated } from '../middleware/auth.js';

// Shared modules
import { cartOperations } from '../shared/metrics.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('cart');

const router = Router();

interface CartItemRow {
  id: number;
  user_id: number;
  product_id: number;
  quantity: number;
  reserved_until: Date | null;
  created_at: Date;
  updated_at: Date;
  title?: string;
  price?: string;
  available?: number;
  images?: string[];
  shipping_price?: string;
  shop_id?: number;
  shop_name?: string;
  shop_slug?: string;
}

interface ProductRow {
  id: number;
  quantity: number;
  title: string;
}

interface CartItemBody {
  productId: number | string;
  quantity?: number | string;
}

interface UpdateCartItemBody {
  quantity: number | string;
}

interface ShopGroup {
  shopId: number;
  shopName: string;
  shopSlug: string;
  items: {
    id: number;
    productId: number;
    title: string;
    price: number;
    quantity: number;
    available: number;
    images: string[];
    shippingPrice: number;
    itemTotal: number;
  }[];
  subtotal: number;
  shippingTotal: number;
}

// Get user's cart (grouped by shop)
router.get('/', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const result = await db.query<CartItemRow>(
      `SELECT ci.*, p.title, p.price, p.quantity as available, p.images, p.shipping_price,
              s.id as shop_id, s.name as shop_name, s.slug as shop_slug
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       JOIN shops s ON p.shop_id = s.id
       WHERE ci.user_id = $1 AND p.is_active = true
       ORDER BY s.name, ci.created_at`,
      [req.session.userId]
    );

    // Group by shop
    const byShop = result.rows.reduce<Record<number, ShopGroup>>((acc, item) => {
      const shopId = item.shop_id!;
      if (!acc[shopId]) {
        acc[shopId] = {
          shopId: shopId,
          shopName: item.shop_name!,
          shopSlug: item.shop_slug!,
          items: [],
          subtotal: 0,
          shippingTotal: 0,
        };
      }

      const itemTotal = parseFloat(item.price!) * item.quantity;
      acc[shopId].items.push({
        id: item.id,
        productId: item.product_id,
        title: item.title!,
        price: parseFloat(item.price!),
        quantity: item.quantity,
        available: item.available!,
        images: item.images || [],
        shippingPrice: parseFloat(item.shipping_price!),
        itemTotal,
      });
      acc[shopId].subtotal += itemTotal;
      acc[shopId].shippingTotal += parseFloat(item.shipping_price!);
      return acc;
    }, {});

    const shops = Object.values(byShop);
    const itemTotal = shops.reduce((sum: number, shop: ShopGroup) => sum + shop.subtotal, 0);
    const shippingTotal = shops.reduce((sum: number, shop: ShopGroup) => sum + shop.shippingTotal, 0);
    const grandTotal = itemTotal + shippingTotal;

    res.json({
      shops,
      summary: {
        itemTotal,
        shippingTotal,
        grandTotal,
        itemCount: result.rows.reduce((sum: number, item: CartItemRow) => sum + item.quantity, 0),
      },
    });
  } catch (error) {
    logger.error({ error }, 'Get cart error');
    res.status(500).json({ error: 'Failed to get cart' });
  }
});

// Add item to cart
router.post('/items', isAuthenticated, async (req: Request<object, object, CartItemBody>, res: Response) => {
  try {
    const { productId, quantity = 1 } = req.body;

    if (!productId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }

    const parsedProductId = parseInt(String(productId));
    const parsedQuantity = parseInt(String(quantity));

    // Check product exists and is available
    const productResult = await db.query<ProductRow>(
      'SELECT id, quantity, title FROM products WHERE id = $1 AND is_active = true',
      [parsedProductId]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productResult.rows[0];

    if (product.quantity < parsedQuantity) {
      return res.status(400).json({ error: 'Not enough stock available' });
    }

    // Check if product already in cart
    const existingResult = await db.query<{ id: number; quantity: number }>(
      'SELECT id, quantity FROM cart_items WHERE user_id = $1 AND product_id = $2',
      [req.session.userId, parsedProductId]
    );

    if (existingResult.rows.length > 0) {
      // Update quantity
      const newQuantity = existingResult.rows[0].quantity + parsedQuantity;

      if (newQuantity > product.quantity) {
        return res.status(400).json({ error: 'Not enough stock available' });
      }

      await db.query(
        'UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2',
        [newQuantity, existingResult.rows[0].id]
      );

      cartOperations.labels('update').inc();
      logger.debug({ userId: req.session.userId, productId: parsedProductId, newQuantity }, 'Cart item quantity updated');
    } else {
      // Add new item with reservation for unique items
      const reservedUntil = product.quantity === 1
        ? new Date(Date.now() + 15 * 60 * 1000) // 15 min reservation for unique items
        : null;

      await db.query(
        'INSERT INTO cart_items (user_id, product_id, quantity, reserved_until) VALUES ($1, $2, $3, $4)',
        [req.session.userId, parsedProductId, parsedQuantity, reservedUntil]
      );

      cartOperations.labels('add').inc();
      logger.debug({ userId: req.session.userId, productId: parsedProductId, quantity: parsedQuantity }, 'Item added to cart');
    }

    res.json({ message: 'Item added to cart' });
  } catch (error) {
    logger.error({ error }, 'Add to cart error');
    res.status(500).json({ error: 'Failed to add item to cart' });
  }
});

// Update cart item quantity
router.put('/items/:itemId', isAuthenticated, async (req: Request<{ itemId: string }, object, UpdateCartItemBody>, res: Response) => {
  try {
    const { itemId } = req.params;
    const { quantity } = req.body;

    const parsedQuantity = parseInt(String(quantity));

    if (!parsedQuantity || parsedQuantity < 1) {
      return res.status(400).json({ error: 'Valid quantity is required' });
    }

    // Get cart item and check ownership
    const cartItemResult = await db.query<CartItemRow & { available: number }>(
      `SELECT ci.*, p.quantity as available
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.id = $1 AND ci.user_id = $2`,
      [parseInt(itemId), req.session.userId]
    );

    if (cartItemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cart item not found' });
    }

    const cartItem = cartItemResult.rows[0];

    if (parsedQuantity > cartItem.available) {
      return res.status(400).json({ error: 'Not enough stock available' });
    }

    await db.query(
      'UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2',
      [parsedQuantity, parseInt(itemId)]
    );

    cartOperations.labels('update').inc();
    logger.debug({ userId: req.session.userId, itemId, quantity: parsedQuantity }, 'Cart item updated');

    res.json({ message: 'Cart updated' });
  } catch (error) {
    logger.error({ error }, 'Update cart error');
    res.status(500).json({ error: 'Failed to update cart' });
  }
});

// Remove item from cart
router.delete('/items/:itemId', isAuthenticated, async (req: Request<{ itemId: string }>, res: Response) => {
  try {
    const { itemId } = req.params;

    const result = await db.query<{ id: number }>(
      'DELETE FROM cart_items WHERE id = $1 AND user_id = $2 RETURNING id',
      [parseInt(itemId), req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cart item not found' });
    }

    cartOperations.labels('remove').inc();
    logger.debug({ userId: req.session.userId, itemId }, 'Item removed from cart');

    res.json({ message: 'Item removed from cart' });
  } catch (error) {
    logger.error({ error }, 'Remove from cart error');
    res.status(500).json({ error: 'Failed to remove item from cart' });
  }
});

// Clear cart
router.delete('/', isAuthenticated, async (req: Request, res: Response) => {
  try {
    const result = await db.query<{ id: number }>(
      'DELETE FROM cart_items WHERE user_id = $1 RETURNING id',
      [req.session.userId]
    );

    if (result.rows.length > 0) {
      cartOperations.labels('clear').inc();
      logger.debug({ userId: req.session.userId, itemsCleared: result.rows.length }, 'Cart cleared');
    }

    res.json({ message: 'Cart cleared' });
  } catch (error) {
    logger.error({ error }, 'Clear cart error');
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

export default router;
