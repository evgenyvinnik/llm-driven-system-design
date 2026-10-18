// Usage records are one row per (date, model): requests, tokens, cost, 429s and errors.
import { MODELS } from './catalog.js';
import { isoDate } from '../seed.js';

const DAY_MS = 86_400_000;

export function recordUsage(state, { model, inputTokens, outputTokens, costCents, requests = 1, now = new Date() }) {
  const date = isoDate(now);
  let record = state.usage.find((row) => row.date === date && row.model === model);
  if (!record) {
    record = { date, model, requests: 0, inputTokens: 0, outputTokens: 0, costCents: 0, rateLimited: 0, errors: 0 };
    state.usage.push(record);
  }
  record.requests += requests;
  record.inputTokens += inputTokens;
  record.outputTokens += outputTokens;
  record.costCents = Math.round((record.costCents + costCents) * 10_000) / 10_000;
  return record;
}

// The last `days` calendar days, oldest first, today included. Days without traffic are zeros.
export function dailyUsage(state, { days = 7, now = new Date() } = {}) {
  const result = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = isoDate(new Date(now.getTime() - offset * DAY_MS));
    const rows = state.usage.filter((row) => row.date === date);
    const day = { date, requests: 0, inputTokens: 0, outputTokens: 0, costCents: 0, rateLimited: 0, errors: 0, byModel: {} };
    for (const row of rows) {
      day.requests += row.requests;
      day.inputTokens += row.inputTokens;
      day.outputTokens += row.outputTokens;
      day.costCents += row.costCents;
      day.rateLimited += row.rateLimited;
      day.errors += row.errors;
      day.byModel[row.model] = row.costCents;
    }
    day.costCents = Math.round(day.costCents * 10_000) / 10_000;
    result.push(day);
  }
  return result;
}

export function summarizeUsage(state, { days = 7, now = new Date() } = {}) {
  const daily = dailyUsage(state, { days, now });
  const dates = new Set(daily.map((day) => day.date));
  const inRange = state.usage.filter((row) => dates.has(row.date));

  const byModel = MODELS.map((model) => {
    const rows = inRange.filter((row) => row.model === model.id);
    return {
      model: model.id,
      name: model.name,
      requests: rows.reduce((sum, row) => sum + row.requests, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      costCents: Math.round(rows.reduce((sum, row) => sum + row.costCents, 0) * 10_000) / 10_000,
      rateLimited: rows.reduce((sum, row) => sum + row.rateLimited, 0),
    };
  });

  const totals = daily.reduce(
    (acc, day) => ({
      requests: acc.requests + day.requests,
      inputTokens: acc.inputTokens + day.inputTokens,
      outputTokens: acc.outputTokens + day.outputTokens,
      costCents: acc.costCents + day.costCents,
      rateLimited: acc.rateLimited + day.rateLimited,
      errors: acc.errors + day.errors,
    }),
    { requests: 0, inputTokens: 0, outputTokens: 0, costCents: 0, rateLimited: 0, errors: 0 },
  );
  totals.costCents = Math.round(totals.costCents * 10_000) / 10_000;

  return { days, daily, byModel, totals };
}

// Spend so far in the current calendar month, for the monthly spend limit.
export function monthToDateSpendCents(state, now = new Date()) {
  const month = isoDate(now).slice(0, 7);
  const total = state.usage.filter((row) => row.date.startsWith(month)).reduce((sum, row) => sum + row.costCents, 0);
  return Math.round(total * 10_000) / 10_000;
}

// 429s over the last 7 days, as a count and as a share of attempted requests.
export function rateLimitSummary(state, now = new Date()) {
  const { totals } = summarizeUsage(state, { days: 7, now });
  const attempted = totals.requests + totals.rateLimited;
  return {
    rateLimited7d: totals.rateLimited,
    attempted7d: attempted,
    sharePct: attempted > 0 ? Math.round((totals.rateLimited / attempted) * 1_000) / 10 : 0,
  };
}
