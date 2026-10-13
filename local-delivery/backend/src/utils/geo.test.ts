import { describe, it, expect } from 'vitest';
import { estimateDeliveryEtaSeconds, calculateETA, haversineDistance, ROAD_DETOUR_FACTOR } from './geo.js';

const merchant = { lat: 37.7749, lng: -122.4194 };
const customer = { lat: 37.7949, lng: -122.4194 }; // ~2.2 km north
const courierNearMerchant = { lat: 37.7649, lng: -122.4194 }; // ~1.1 km south of the merchant

describe('estimateDeliveryEtaSeconds', () => {
  const now = Date.UTC(2026, 9, 10, 18, 0, 0);

  it('before pickup, includes the ride to the merchant and the ride to the customer', () => {
    const eta = estimateDeliveryEtaSeconds({
      status: 'driver_assigned',
      courier: courierNearMerchant,
      pickup: merchant,
      dropoff: customer,
      vehicleType: 'car',
      now,
    });
    const toMerchant = calculateETA(haversineDistance(courierNearMerchant, merchant) * ROAD_DETOUR_FACTOR, 'car');
    const toCustomer = calculateETA(haversineDistance(merchant, customer) * ROAD_DETOUR_FACTOR, 'car');
    expect(eta).toBe(toMerchant + toCustomer);
  });

  it('waits for the food when the courier would arrive before it is ready', () => {
    const base = { status: 'driver_assigned', courier: courierNearMerchant, pickup: merchant, dropoff: customer, now };
    const noWait = estimateDeliveryEtaSeconds(base);
    const withWait = estimateDeliveryEtaSeconds({ ...base, foodReadyAt: now + 20 * 60_000 });
    expect(withWait).toBeGreaterThan(noWait);
    expect(withWait).toBeGreaterThanOrEqual(20 * 60);
  });

  it('after pickup, only the last leg counts', () => {
    const courier = { lat: 37.7849, lng: -122.4194 };
    const eta = estimateDeliveryEtaSeconds({ status: 'in_transit', courier, pickup: merchant, dropoff: customer });
    expect(eta).toBe(calculateETA(haversineDistance(courier, customer) * ROAD_DETOUR_FACTOR));
  });

  it('a bicycle is slower than a motorcycle over the same route', () => {
    const base = { status: 'picked_up', courier: merchant, pickup: merchant, dropoff: customer };
    expect(estimateDeliveryEtaSeconds({ ...base, vehicleType: 'bicycle' })).toBeGreaterThan(
      estimateDeliveryEtaSeconds({ ...base, vehicleType: 'motorcycle' })
    );
  });
});
