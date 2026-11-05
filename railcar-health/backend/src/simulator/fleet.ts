/**
 * Fictional fleet: lessor- and shipper-owned cars (most North American cars are
 * not owned by the railroad that moves them) plus the railroad's own cars and
 * locomotives. Reporting marks are invented.
 */
import type { CarEnd } from '../shared/domain.js'
import { mulberry32, type Rng } from './rng.js'

export interface Owner {
  mark: string
  name: string
  carType: string
}

export const OWNERS: Owner[] = [
  { mark: 'NRLX', name: 'North Range Leasing', carType: 'covered hopper' },
  { mark: 'TCLX', name: 'Tidewater Car Leasing', carType: 'tank car' },
  { mark: 'SVTX', name: 'Summit Valley Transport', carType: 'intermodal flat' },
  { mark: 'HPRX', name: 'High Plains Railcar', carType: 'boxcar' },
  { mark: 'PLNR', name: 'Plains & Northern Railway', carType: 'gondola' },
]

export interface SimUnit {
  position: number
  unitId: string
  unitType: 'locomotive' | 'car'
  axleCount: number
  /** Physical truth: which end faces the head of the train. */
  leadingEnd: CarEnd
  /** What the consist from the yard system says (may be stale). */
  consistLeadingEnd: CarEnd
  loaded: boolean
  owner?: Owner
}

export function ownerOf(carId: string): Owner {
  return OWNERS.find((o) => carId.startsWith(o.mark)) ?? OWNERS[0]
}

export function buildConsist(opts: {
  seed: number
  locomotives: number
  cars: number
  usedIds: Set<string>
  special: Array<{ index: number; carId: string; leadingEnd: CarEnd; consistLeadingEnd?: CarEnd }>
}): SimUnit[] {
  const rng: Rng = mulberry32(opts.seed)
  const units: SimUnit[] = []
  for (let i = 0; i < opts.locomotives; i++) {
    const id = `PLNR ${4100 + Math.floor(rng() * 800)}`
    units.push({ position: units.length + 1, unitId: id, unitType: 'locomotive', axleCount: 6, leadingEnd: 'A', consistLeadingEnd: 'A', loaded: false })
  }
  const specials = new Map(opts.special.map((s) => [s.index, s]))
  for (let i = 1; i <= opts.cars; i++) {
    const special = specials.get(i)
    let carId: string
    let leadingEnd: CarEnd
    let consistLeadingEnd: CarEnd
    if (special) {
      carId = special.carId
      leadingEnd = special.leadingEnd
      consistLeadingEnd = special.consistLeadingEnd ?? special.leadingEnd
    } else {
      do {
        const owner = OWNERS[Math.floor(rng() * OWNERS.length)]
        carId = `${owner.mark} ${100000 + Math.floor(rng() * 899999)}`
      } while (opts.usedIds.has(carId))
      leadingEnd = rng() < 0.5 ? 'A' : 'B'
      consistLeadingEnd = leadingEnd
    }
    opts.usedIds.add(carId)
    units.push({ position: units.length + 1, unitId: carId, unitType: 'car', axleCount: 4, leadingEnd, consistLeadingEnd, loaded: rng() < 0.7, owner: ownerOf(carId) })
  }
  return units
}
