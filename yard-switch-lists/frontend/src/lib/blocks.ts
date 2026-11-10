/**
 * Fixed block colors, in the dataviz reference palette's order, so a block is the
 * same color on every screen. Identity is never color alone: lanes also print the
 * block name, and every car has a title.
 */
const SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const ORDER = ['KCK', 'GAL', 'DEN', 'BAR', 'TPL', 'MEM', 'CHI', 'PDX']

export function blockColor(blockId: string): string {
  const i = ORDER.indexOf(blockId)
  return i >= 0 ? SLOTS[i] : '#64748b'
}

export const BLOCK_ORDER = ORDER
