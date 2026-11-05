/**
 * Bearing geometry: turning what a detector sees (an axle number counted from
 * the head of the train and a rail) into a car-relative position that stays
 * the same no matter which way the car faces.
 *
 * Car-relative convention: axle 1 is at the B-end; sides L/R are named
 * standing at the B-end facing the A-end. A car turned on a wye swaps which
 * rail its R-side bearings pass over, and reverses the order its axles reach
 * the detector, but its "R1" bearing is still "R1".
 * @module shared/geometry
 */
import type { CarEnd, CarSide, Direction, Rail } from './domain.js'

/** Side of the train (facing the direction of travel) that a rail is on. */
export function trainSide(rail: Rail, direction: Direction): CarSide {
  // Eastbound, north is on your left; westbound, it is on your right.
  if (direction === 'EB') return rail === 'N' ? 'L' : 'R'
  return rail === 'N' ? 'R' : 'L'
}

export function railForTrainSide(side: CarSide, direction: Direction): Rail {
  if (direction === 'EB') return side === 'L' ? 'N' : 'S'
  return side === 'L' ? 'S' : 'N'
}

const flip = (side: CarSide): CarSide => (side === 'L' ? 'R' : 'L')

/**
 * Car-relative position of the bearing that passes over `rail` on the
 * `seqInCar`-th axle of a car to reach the detector (1 = first).
 */
export function carRelativePosition(
  rail: Rail,
  direction: Direction,
  leadingEnd: CarEnd,
  seqInCar: number,
  axleCount: number,
): { side: CarSide; axle: number } {
  const side = trainSide(rail, direction)
  if (leadingEnd === 'B') {
    // Facing forward means facing the B-end, the opposite of the naming convention.
    return { side: flip(side), axle: seqInCar }
  }
  // A-end leading: facing forward is facing the A-end from the B-end, matching the convention.
  return { side, axle: axleCount + 1 - seqInCar }
}

/** Inverse of carRelativePosition: where a given physical bearing shows up at a detector. */
export function detectorViewOf(
  side: CarSide,
  axle: number,
  direction: Direction,
  leadingEnd: CarEnd,
  axleCount: number,
): { rail: Rail; seqInCar: number } {
  if (leadingEnd === 'B') {
    return { rail: railForTrainSide(flip(side), direction), seqInCar: axle }
  }
  return { rail: railForTrainSide(side, direction), seqInCar: axleCount + 1 - axle }
}
