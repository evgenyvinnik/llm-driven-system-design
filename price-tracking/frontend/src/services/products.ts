import api from './api';
import { Product, ProductsResponse, ProductResponse, PriceHistoryResponse, DailyPricesResponse } from '../types';

export async function getProducts(): Promise<Product[]> {
  const response = await api.get<ProductsResponse>('/products');
  return response.data.products;
}

export async function getProduct(productId: string): Promise<Product> {
  const response = await api.get<ProductResponse>(`/products/${productId}`);
  return response.data.product;
}

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

export async function updateProduct(
  productId: string,
  updates: { target_price?: number | null; notify_any_drop?: boolean }
): Promise<void> {
  await api.patch(`/products/${productId}`, updates);
}

export async function deleteProduct(productId: string): Promise<void> {
  await api.delete(`/products/${productId}`);
}

export async function getPriceHistory(productId: string, days: number = 90): Promise<PriceHistoryResponse['history']> {
  const response = await api.get<PriceHistoryResponse>(`/products/${productId}/history`, {
    params: { days },
  });
  return response.data.history;
}

export async function getDailyPrices(productId: string, days: number = 90): Promise<DailyPricesResponse['daily']> {
  const response = await api.get<DailyPricesResponse>(`/products/${productId}/daily`, {
    params: { days },
  });
  return response.data.daily;
}
