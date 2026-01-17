// Haversine formula to calculate distance between two coordinates in km
export function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

// Estimate drive time in minutes based on distance
// Using average speed based on traffic conditions
export function estimateDriveTime(distanceKm, vehicleType = 'car') {
  // Average speeds in km/h
  const speeds = {
    car: 25, // City driving with traffic
    bike: 15,
    scooter: 20,
    walk: 5,
  };

  const speed = speeds[vehicleType] || speeds.car;
  const timeHours = distanceKm / speed;
  return timeHours * 60; // Return minutes
}

// Get traffic multiplier based on time of day
export function getTrafficMultiplier(date = new Date()) {
  const hour = date.getHours();
  const day = date.getDay();

  // Weekend
  if (day === 0 || day === 6) {
    return 1.1;
  }

  // Rush hours: 7-9 AM and 5-7 PM
  if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19)) {
    return 1.5;
  }

  // Lunch rush: 11 AM - 1 PM
  if (hour >= 11 && hour <= 13) {
    return 1.3;
  }

  // Normal hours
  return 1.0;
}

// Calculate route time with traffic
export function calculateRouteTime(distanceKm, vehicleType = 'car') {
  const baseTime = estimateDriveTime(distanceKm, vehicleType);
  const multiplier = getTrafficMultiplier();
  return baseTime * multiplier;
}

// Calculate ETA breakdown for an order
export function calculateETA(order, driver, restaurant) {
  const now = Date.now();

  // Time for driver to reach restaurant
  let timeToRestaurant = 0;
  if (driver && order.status !== 'PICKED_UP' && order.status !== 'DELIVERED') {
    const distanceToRestaurant = haversineDistance(
      driver.current_lat,
      driver.current_lon,
      restaurant.lat,
      restaurant.lon
    );
    timeToRestaurant = calculateRouteTime(distanceToRestaurant, driver.vehicle_type) * 60 * 1000; // ms
  }

  // Remaining prep time
  let prepTime = 0;
  if (order.status === 'PREPARING' || order.status === 'CONFIRMED') {
    const prepStarted = order.preparing_at || order.confirmed_at || order.placed_at;
    const elapsed = now - new Date(prepStarted).getTime();
    const totalPrepTime = (restaurant.prep_time_minutes || 20) * 60 * 1000;
    prepTime = Math.max(0, totalPrepTime - elapsed);
  }

  // Time from restaurant to customer
  const deliveryAddress = order.delivery_address;
  const distanceToCustomer = haversineDistance(
    restaurant.lat,
    restaurant.lon,
    deliveryAddress.lat,
    deliveryAddress.lon
  );
  const deliveryTime =
    calculateRouteTime(distanceToCustomer, driver?.vehicle_type || 'car') * 60 * 1000;

  // Buffers
  const pickupBuffer = 3 * 60 * 1000; // 3 minutes for pickup
  const dropoffBuffer = 2 * 60 * 1000; // 2 minutes for handoff

  // Calculate total
  // Driver arriving and food prep can happen in parallel
  const waitTime = Math.max(timeToRestaurant, prepTime);
  const totalMs = waitTime + pickupBuffer + deliveryTime + dropoffBuffer;

  return {
    eta: new Date(now + totalMs),
    breakdown: {
      toRestaurantMinutes: Math.round(timeToRestaurant / 60000),
      prepTimeMinutes: Math.round(prepTime / 60000),
      deliveryMinutes: Math.round(deliveryTime / 60000),
      bufferMinutes: Math.round((pickupBuffer + dropoffBuffer) / 60000),
      totalMinutes: Math.round(totalMs / 60000),
    },
  };
}
