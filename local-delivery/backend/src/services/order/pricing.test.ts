import { describe, it, expect } from 'vitest';
import {
  parseOrderBody,
  createOrderSchema,
  priceOrder,
  OrderValidationError,
  toCents,
  fromCents,
} from './pricing.js';

const merchant = { id: '00000000-0000-0000-0000-000000000100', lat: 37.7749, lng: -122.4194, is_open: true };
const pizza = {
  id: '00000000-0000-0000-0000-000000001001',
  merchant_id: merchant.id,
  name: 'Margherita Pizza',
  price: '14.99' as unknown as number, // pg returns DECIMAL as a string
  is_available: true,
};
const burger = { ...pizza, id: '00000000-0000-0000-0000-000000001101', merchant_id: 'other-merchant', name: 'Burger' };

const body = (overrides: Record<string, unknown> = {}) => ({
  merchant_id: merchant.id,
  delivery_address: '1 Market St',
  delivery_lat: 37.7749,
  delivery_lng: -122.4194,
  items: [{ menu_item_id: pizza.id, quantity: 3 }],
  ...overrides,
});

describe('order request validation', () => {
  it.each([
    ['a negative quantity', { items: [{ menu_item_id: pizza.id, quantity: -3 }] }],
    ['a fractional quantity', { items: [{ menu_item_id: pizza.id, quantity: 1.5 }] }],
    ['an empty cart', { items: [] }],
    ['a negative tip', { tip: -5 }],
    ['an out-of-range latitude', { delivery_lat: 123 }],
    ['a missing address', { delivery_address: '   ' }],
  ])('rejects %s with a 422', (_label, overrides) => {
    expect(() => parseOrderBody(createOrderSchema, body(overrides))).toThrow(OrderValidationError);
    try {
      parseOrderBody(createOrderSchema, body(overrides));
    } catch (error) {
      expect((error as OrderValidationError).statusCode).toBe(422);
    }
  });
});

describe('priceOrder', () => {
  it('prices from the menu in integer cents, so 3 x 14.99 is exactly 44.97', () => {
    const quote = priceOrder(merchant, [pizza], parseOrderBody(createOrderSchema, body({ tip: 2.5 })));

    expect(quote.subtotal_cents).toBe(4497);
    expect(quote.delivery_fee_cents).toBe(299); // base fee at zero distance
    expect(quote.tip_cents).toBe(250);
    expect(quote.total_cents).toBe(4497 + 299 + 250);
    expect(fromCents(quote.total_cents)).toBe('50.46');
  });

  it("rejects an item from another merchant's menu", () => {
    const request = parseOrderBody(createOrderSchema, body({ items: [{ menu_item_id: burger.id, quantity: 1 }] }));
    expect(() => priceOrder(merchant, [pizza, burger], request)).toThrow(/not on this merchant's menu/);
  });

  it('rejects unavailable items and closed merchants', () => {
    const request = parseOrderBody(createOrderSchema, body());
    expect(() => priceOrder(merchant, [{ ...pizza, is_available: false }], request)).toThrow(/not available/);
    expect(() => priceOrder({ ...merchant, is_open: false }, [pizza], request)).toThrow(/closed/);
  });

  it('rejects an address outside the delivery radius', () => {
    const request = parseOrderBody(createOrderSchema, body({ delivery_lat: 38.5, delivery_lng: -121.5 }));
    expect(() => priceOrder(merchant, [pizza], request)).toThrow(/delivers within/);
  });

  it('prices the same item on two lines separately (different instructions)', () => {
    const request = parseOrderBody(
      createOrderSchema,
      body({
        items: [
          { menu_item_id: pizza.id, quantity: 1, special_instructions: 'extra basil' },
          { menu_item_id: pizza.id, quantity: 2 },
        ],
      })
    );
    const quote = priceOrder(merchant, [pizza], request);
    expect(quote.lines).toHaveLength(2);
    expect(quote.subtotal_cents).toBe(4497);
  });

  it('converts amounts without floating-point drift', () => {
    expect(toCents('0.1') + toCents('0.2')).toBe(30);
    expect(fromCents(30)).toBe('0.30');
  });
});
