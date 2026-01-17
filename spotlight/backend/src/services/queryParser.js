import { create, all } from 'mathjs';

const math = create(all);

// Unit conversion mappings
const unitConversions = {
  // Length
  km: { category: 'length', si: 'm', factor: 1000 },
  m: { category: 'length', si: 'm', factor: 1 },
  cm: { category: 'length', si: 'm', factor: 0.01 },
  mm: { category: 'length', si: 'm', factor: 0.001 },
  mi: { category: 'length', si: 'm', factor: 1609.344 },
  mile: { category: 'length', si: 'm', factor: 1609.344 },
  miles: { category: 'length', si: 'm', factor: 1609.344 },
  yd: { category: 'length', si: 'm', factor: 0.9144 },
  yard: { category: 'length', si: 'm', factor: 0.9144 },
  yards: { category: 'length', si: 'm', factor: 0.9144 },
  ft: { category: 'length', si: 'm', factor: 0.3048 },
  feet: { category: 'length', si: 'm', factor: 0.3048 },
  foot: { category: 'length', si: 'm', factor: 0.3048 },
  in: { category: 'length', si: 'm', factor: 0.0254 },
  inch: { category: 'length', si: 'm', factor: 0.0254 },
  inches: { category: 'length', si: 'm', factor: 0.0254 },

  // Weight
  kg: { category: 'weight', si: 'kg', factor: 1 },
  g: { category: 'weight', si: 'kg', factor: 0.001 },
  mg: { category: 'weight', si: 'kg', factor: 0.000001 },
  lb: { category: 'weight', si: 'kg', factor: 0.453592 },
  lbs: { category: 'weight', si: 'kg', factor: 0.453592 },
  pound: { category: 'weight', si: 'kg', factor: 0.453592 },
  pounds: { category: 'weight', si: 'kg', factor: 0.453592 },
  oz: { category: 'weight', si: 'kg', factor: 0.0283495 },
  ounce: { category: 'weight', si: 'kg', factor: 0.0283495 },
  ounces: { category: 'weight', si: 'kg', factor: 0.0283495 },

  // Temperature (special handling)
  c: { category: 'temperature', si: 'c', factor: 1 },
  celsius: { category: 'temperature', si: 'c', factor: 1 },
  f: { category: 'temperature', si: 'f', factor: 1 },
  fahrenheit: { category: 'temperature', si: 'f', factor: 1 },
  k: { category: 'temperature', si: 'k', factor: 1 },
  kelvin: { category: 'temperature', si: 'k', factor: 1 },

  // Volume
  l: { category: 'volume', si: 'l', factor: 1 },
  liter: { category: 'volume', si: 'l', factor: 1 },
  liters: { category: 'volume', si: 'l', factor: 1 },
  ml: { category: 'volume', si: 'l', factor: 0.001 },
  gal: { category: 'volume', si: 'l', factor: 3.78541 },
  gallon: { category: 'volume', si: 'l', factor: 3.78541 },
  gallons: { category: 'volume', si: 'l', factor: 3.78541 },
  qt: { category: 'volume', si: 'l', factor: 0.946353 },
  quart: { category: 'volume', si: 'l', factor: 0.946353 },
  quarts: { category: 'volume', si: 'l', factor: 0.946353 },
  cup: { category: 'volume', si: 'l', factor: 0.236588 },
  cups: { category: 'volume', si: 'l', factor: 0.236588 },

  // Time
  s: { category: 'time', si: 's', factor: 1 },
  sec: { category: 'time', si: 's', factor: 1 },
  second: { category: 'time', si: 's', factor: 1 },
  seconds: { category: 'time', si: 's', factor: 1 },
  min: { category: 'time', si: 's', factor: 60 },
  minute: { category: 'time', si: 's', factor: 60 },
  minutes: { category: 'time', si: 's', factor: 60 },
  h: { category: 'time', si: 's', factor: 3600 },
  hr: { category: 'time', si: 's', factor: 3600 },
  hour: { category: 'time', si: 's', factor: 3600 },
  hours: { category: 'time', si: 's', factor: 3600 },
  day: { category: 'time', si: 's', factor: 86400 },
  days: { category: 'time', si: 's', factor: 86400 },
  week: { category: 'time', si: 's', factor: 604800 },
  weeks: { category: 'time', si: 's', factor: 604800 },

  // Data
  b: { category: 'data', si: 'b', factor: 1 },
  byte: { category: 'data', si: 'b', factor: 1 },
  bytes: { category: 'data', si: 'b', factor: 1 },
  kb: { category: 'data', si: 'b', factor: 1024 },
  mb: { category: 'data', si: 'b', factor: 1048576 },
  gb: { category: 'data', si: 'b', factor: 1073741824 },
  tb: { category: 'data', si: 'b', factor: 1099511627776 }
};

// Parse query to detect special queries
export function parseQuery(queryString) {
  const query = {
    raw: queryString,
    type: 'search'
  };

  // Check for math expression
  if (/^[\d\s+\-*/().%^]+$/.test(queryString.trim())) {
    query.type = 'math';
    query.expression = queryString.trim();
    return query;
  }

  // Check for unit conversion
  const conversionMatch = queryString.match(/^([\d.]+)\s*(\w+)\s+(?:to|in)\s+(\w+)$/i);
  if (conversionMatch) {
    const fromUnit = conversionMatch[2].toLowerCase();
    const toUnit = conversionMatch[3].toLowerCase();

    if (unitConversions[fromUnit] && unitConversions[toUnit]) {
      query.type = 'conversion';
      query.value = parseFloat(conversionMatch[1]);
      query.fromUnit = fromUnit;
      query.toUnit = toUnit;
      return query;
    }
  }

  // Check for date filter
  if (/(?:from|since|before|after|last|yesterday|today)/i.test(queryString)) {
    query.dateFilter = parseDateFilter(queryString);
    if (query.dateFilter) {
      query.type = 'date_filter';
    }
  }

  return query;
}

// Handle math calculation
export function evaluateMath(expression) {
  try {
    const result = math.evaluate(expression);
    if (typeof result === 'number') {
      // Format the result nicely
      if (Number.isInteger(result)) {
        return result.toString();
      }
      return parseFloat(result.toPrecision(10)).toString();
    }
    return result.toString();
  } catch {
    return null;
  }
}

// Handle unit conversion
export function convertUnits(value, fromUnit, toUnit) {
  const from = unitConversions[fromUnit.toLowerCase()];
  const to = unitConversions[toUnit.toLowerCase()];

  if (!from || !to) {
    return null;
  }

  if (from.category !== to.category) {
    return null;
  }

  // Special handling for temperature
  if (from.category === 'temperature') {
    return convertTemperature(value, fromUnit.toLowerCase(), toUnit.toLowerCase());
  }

  // Convert to SI, then to target unit
  const siValue = value * from.factor;
  const result = siValue / to.factor;

  return {
    value: parseFloat(result.toPrecision(10)),
    unit: toUnit
  };
}

function convertTemperature(value, from, to) {
  // Normalize unit names
  const fromNorm = from === 'celsius' ? 'c' : from === 'fahrenheit' ? 'f' : from === 'kelvin' ? 'k' : from;
  const toNorm = to === 'celsius' ? 'c' : to === 'fahrenheit' ? 'f' : to === 'kelvin' ? 'k' : to;

  let celsius;

  // Convert to Celsius first
  switch (fromNorm) {
    case 'c':
      celsius = value;
      break;
    case 'f':
      celsius = (value - 32) * 5 / 9;
      break;
    case 'k':
      celsius = value - 273.15;
      break;
    default:
      return null;
  }

  // Convert from Celsius to target
  let result;
  let unitName;

  switch (toNorm) {
    case 'c':
      result = celsius;
      unitName = 'C';
      break;
    case 'f':
      result = celsius * 9 / 5 + 32;
      unitName = 'F';
      break;
    case 'k':
      result = celsius + 273.15;
      unitName = 'K';
      break;
    default:
      return null;
  }

  return {
    value: parseFloat(result.toPrecision(10)),
    unit: unitName
  };
}

// Parse date filters from natural language
function parseDateFilter(queryString) {
  const now = new Date();
  let startDate = null;
  let endDate = null;

  // Today
  if (/\btoday\b/i.test(queryString)) {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    endDate = now;
  }

  // Yesterday
  if (/\byesterday\b/i.test(queryString)) {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  // Last week
  if (/\blast\s+week\b/i.test(queryString)) {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    endDate = now;
  }

  // Last month
  if (/\blast\s+month\b/i.test(queryString)) {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    endDate = now;
  }

  // Last N days
  const lastNDaysMatch = queryString.match(/\blast\s+(\d+)\s+days?\b/i);
  if (lastNDaysMatch) {
    const days = parseInt(lastNDaysMatch[1]);
    startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    endDate = now;
  }

  if (startDate && endDate) {
    return { startDate, endDate };
  }

  return null;
}

// Format result for display
export function formatSpecialResult(query) {
  if (query.type === 'math') {
    const result = evaluateMath(query.expression);
    if (result !== null) {
      return {
        type: 'calculation',
        name: `${query.expression} = ${result}`,
        value: result,
        icon: 'calculator',
        score: 100
      };
    }
  }

  if (query.type === 'conversion') {
    const result = convertUnits(query.value, query.fromUnit, query.toUnit);
    if (result) {
      return {
        type: 'conversion',
        name: `${query.value} ${query.fromUnit} = ${result.value} ${result.unit}`,
        value: result.value,
        unit: result.unit,
        icon: 'arrows-right-left',
        score: 100
      };
    }
  }

  return null;
}
