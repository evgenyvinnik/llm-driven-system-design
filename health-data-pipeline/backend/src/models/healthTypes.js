// Health data type configurations
export const HealthDataTypes = {
  // Activity types (sum aggregation)
  STEPS: { unit: 'count', aggregation: 'sum', category: 'activity' },
  DISTANCE: { unit: 'meters', aggregation: 'sum', category: 'activity' },
  ACTIVE_ENERGY: { unit: 'kcal', aggregation: 'sum', category: 'activity' },
  FLOORS_CLIMBED: { unit: 'count', aggregation: 'sum', category: 'activity' },
  STAND_HOURS: { unit: 'count', aggregation: 'sum', category: 'activity' },
  EXERCISE_MINUTES: { unit: 'minutes', aggregation: 'sum', category: 'activity' },

  // Vitals (average aggregation)
  HEART_RATE: { unit: 'bpm', aggregation: 'average', category: 'vitals' },
  RESTING_HEART_RATE: { unit: 'bpm', aggregation: 'average', category: 'vitals' },
  BLOOD_PRESSURE_SYSTOLIC: { unit: 'mmHg', aggregation: 'average', category: 'vitals' },
  BLOOD_PRESSURE_DIASTOLIC: { unit: 'mmHg', aggregation: 'average', category: 'vitals' },
  BLOOD_GLUCOSE: { unit: 'mg/dL', aggregation: 'average', category: 'vitals' },
  OXYGEN_SATURATION: { unit: 'percent', aggregation: 'average', category: 'vitals' },
  HRV: { unit: 'ms', aggregation: 'average', category: 'vitals' },

  // Body measurements (latest aggregation)
  WEIGHT: { unit: 'kg', aggregation: 'latest', category: 'body' },
  BODY_FAT: { unit: 'percent', aggregation: 'latest', category: 'body' },

  // Sleep (sum aggregation)
  SLEEP_ANALYSIS: { unit: 'minutes', aggregation: 'sum', category: 'sleep' }
};

// Device priority for deduplication (higher = preferred)
export const DevicePriority = {
  apple_watch: 100,
  iphone: 80,
  ipad: 70,
  third_party_wearable: 50,
  third_party_scale: 40,
  manual_entry: 10
};

// Unit conversion helpers
export const UnitConversions = {
  // Distance
  miles_to_meters: (val) => val * 1609.344,
  km_to_meters: (val) => val * 1000,
  feet_to_meters: (val) => val * 0.3048,

  // Weight
  lbs_to_kg: (val) => val * 0.453592,
  stones_to_kg: (val) => val * 6.35029,

  // Temperature
  fahrenheit_to_celsius: (val) => (val - 32) * 5 / 9
};

export function normalizeUnit(value, fromUnit, toUnit) {
  const conversionKey = `${fromUnit}_to_${toUnit}`;
  const converter = UnitConversions[conversionKey];

  if (converter) {
    return converter(value);
  }

  return value;
}

export function validateHealthType(type) {
  return HealthDataTypes[type] !== undefined;
}

export function getAggregationType(type) {
  const config = HealthDataTypes[type];
  return config ? config.aggregation : 'average';
}
