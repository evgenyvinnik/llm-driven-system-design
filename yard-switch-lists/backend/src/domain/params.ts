/**
 * Default yard rules and objective weights. All illustrative: they set the
 * shape of the problem, they aren't taken from any railroad's standards.
 * Hazmat rules are SIMPLIFIED FROM real position-in-train rules (in the US,
 * 49 CFR Part 174), which vary with hazard class, train length and movement.
 * Never read these as the regulation.
 * @module domain/params
 */
import type { YardRules } from './types.js'

export const DEFAULT_RULES: YardRules = {
  receiveMin: 15,
  inspectMin: 30,
  classifyFixedMin: 4,
  classifyPerCarMin: 1,
  assembleFixedMin: 6,
  assemblePerCarMin: 0.5,
  setoutMin: 12,
  brakeTestMin: 30,
  assembleWindowMin: 300,
  frozenHorizonMin: 30,
  hazmatBufferCars: 5,
  hazmatIncompatible: [
    ['1.1', '3'],
    ['1.1', '2.1'],
  ],
}

export const WEIGHTS = {
  annulledTrain: 500,
  unassignedCar: 100,
  dwellPerCarHour: 1,
  move: 3,
  alternateCut: 8,
  changedMove: 40,
}

export const MIN = 60_000

export const moveDurationMin = (rules: YardRules, kind: 'receive' | 'classify' | 'assemble' | 'setout', cars: number): number => {
  if (kind === 'receive') return rules.receiveMin
  if (kind === 'classify') return rules.classifyFixedMin + rules.classifyPerCarMin * cars
  if (kind === 'assemble') return rules.assembleFixedMin + rules.assemblePerCarMin * cars
  return rules.setoutMin
}
