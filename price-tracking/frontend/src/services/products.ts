/**
 * Product service functions for CRUD operations and price history.
 * All operations require authentication.
 * @module services/products
 */
import api from './api';
import { Product, ProductsResponse, ProductResponse, PriceHistoryResponse, DailyPricesResponse } from '../types';

/**
 * Retrieves all products the current user is tracking.
 * @returns Array of tracked products with user settings
 */
export async function getProducts(): Promise<Product[]> {
  const response = await api.get<ProductsResponse>('/products');
  return response.data.products;
}

/**
 * Retrieves a single product by ID.
 * @param productId - The product UUID
 * @returns Product data
 */
export async function getProduct(productId: string): Promise<Product> {
  const response = await api.get<ProductResponse>(`/products/${productId}`);
  return response.data.product;
}

/**
 * Adds a new product to track.
 * @param url - The product URL to track
 * @param targetPrice - Optional target price for alerts
 * @param notifyAnyDrop - Whether to notify on any price drop
 * @returns The created product
 */
export async function addProduct(
  url: string,
  targetPrice?: number,
  notifyAnyDrop?: boolean
): Promise<Product> {
  const response = await api.post<ProductResponse>('/products', {
    url,
    target_price: targetPrice,
    notify_any_drop: notifyAnyDrop,
  });
  return response.data.product;
}

/**
 * Updates tracking settings for a product.
 * @param productId - The product UUID
 * @param updates - Object with target_price and/or notify_any_drop
 */
export async function updateProduct(
  productId: string,
  updates: { target_price?: number | null; notify_any_drop?: boolean }
): Promise<void> {
  await api.patch(`/products/${productId}`, updates);
}

/**
 * Stops tracking a product.
 * @param productId - The product UUID to remove
 */
export async function deleteProduct(productId: string): Promise<void> {
  await api.delete(`/products/${productId}`);
}

/**
 * Retrieves raw price history for a product.
 * @param productId - The product UUID
 * @param days - Number of days of history (default: 90)
 * @returns Array of price history records
 */
export async function getPriceHistory(productId: string, days: number = 90): Promise<PriceHistoryResponse['history']> {
  const response = await api.get<PriceHistoryResponse>(`/products/${productId}/history`, {
    params: { days },
  });
  return response.data.history;
}

/**
 * Retrieves aggregated daily price statistics for charting.
 * @param productId - The product UUID
 * @param days - Number of days of history (default: 90)
 * @returns Array of daily price summaries with min/max/avg
 */
export async function getDailyPrices(productId: string, days: number = 90): Promise<DailyPricesResponse['daily']> {
  const response = await api.get<DailyPricesResponse>(`/products/${productId}/daily`, {
    params: { days },
  });
  return response.data.daily;
}
