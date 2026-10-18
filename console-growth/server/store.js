// All state lives in memory. Reset (Dev toolbar → Data) or a restart restores the seed.
import { buildSeed } from './seed.js';

let state = buildSeed();

export function getState() {
  return state;
}

export function resetState(now = new Date()) {
  state = buildSeed(now);
  return state;
}
