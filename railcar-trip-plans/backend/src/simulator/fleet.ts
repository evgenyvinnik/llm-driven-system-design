/**
 * The simulated fleet: 320 loaded cars across ten shippers and seven traffic flows, generated
 * deterministically so the seed (which registers the cars) and the simulator (which moves them) agree.
 * Reporting marks are invented.
 * @module simulator/fleet
 */
import { mulberry32 } from '../domain/rng.js'

export interface FlowSpec {
  flow: string
  originYard: string
  destinationYard: string
  via: string | null
  handoffRoad: string | null
  /** Received from the foreign road at the origin yard rather than pulled from a customer. */
  receivedFromForeign: boolean
  count: number
  shippers: string[]
  customers: string[]
  carType: string
  mark: string
}

export const FLOWS: FlowSpec[] = [
  { flow: 'NGT-PRT', originYard: 'NGT', destinationYard: 'PRT', via: null, handoffRoad: null, receivedFromForeign: false, count: 130, shippers: ['S01', 'S02', 'S05', 'S09', 'S03', 'S04'], customers: ['PRT-EXPORT-1', 'PRT-EXPORT-2', 'PRT-EXPORT-3'], carType: 'covered hopper', mark: 'HPSX' },
  { flow: 'NGT-SDV', originYard: 'NGT', destinationYard: 'SDV', via: null, handoffRoad: null, receivedFromForeign: false, count: 25, shippers: ['S02', 'S05'], customers: ['SDV-MILL-1', 'SDV-MILL-2'], carType: 'covered hopper', mark: 'HPSX' },
  { flow: 'MID-PRT', originYard: 'MID', destinationYard: 'PRT', via: null, handoffRoad: null, receivedFromForeign: false, count: 45, shippers: ['S07', 'S03', 'S04', 'S09'], customers: ['PRT-EXPORT-1', 'PRT-STEEL-1'], carType: 'gondola', mark: 'VWTX' },
  { flow: 'NGT-PRT-via-SDV', originYard: 'NGT', destinationYard: 'PRT', via: 'SDV', handoffRoad: null, receivedFromForeign: false, count: 30, shippers: ['S01', 'S09'], customers: ['PRT-EXPORT-2'], carType: 'covered hopper', mark: 'HPSX' },
  { flow: 'SDV-PRT', originYard: 'SDV', destinationYard: 'PRT', via: null, handoffRoad: null, receivedFromForeign: true, count: 40, shippers: ['S08', 'S10', 'S09'], customers: ['PRT-EXPORT-3', 'PRT-PAPER-1'], carType: 'boxcar', mark: 'ZNCX' },
  { flow: 'MID-SDV-LPS', originYard: 'MID', destinationYard: 'SDV', via: null, handoffRoad: 'LPS', receivedFromForeign: false, count: 30, shippers: ['S06', 'S07', 'S10'], customers: ['LPS-DEST-1', 'LPS-DEST-2'], carType: 'centerbeam', mark: 'KJBX' },
  { flow: 'SDV-MID', originYard: 'SDV', destinationYard: 'MID', via: null, handoffRoad: null, receivedFromForeign: false, count: 20, shippers: ['S08'], customers: ['MID-WHSE-1'], carType: 'tank car', mark: 'QRLX' },
]

export interface FleetCar {
  carId: string
  carType: string
  ownerMark: string
  shipperId: string
  flow: FlowSpec
  destinationCustomer: string
  /** 0..1 position of the release within the flow's release window. */
  releaseFraction: number
}

export function buildFleet(seed = 23): FleetCar[] {
  const rng = mulberry32(seed)
  const cars: FleetCar[] = []
  let serial = 104_200
  for (const flow of FLOWS) {
    for (let i = 0; i < flow.count; i++) {
      serial += 1 + Math.floor(rng() * 7)
      cars.push({
        carId: `${flow.mark}${serial}`,
        carType: flow.carType,
        ownerMark: flow.mark,
        shipperId: flow.shippers[Math.floor(rng() * flow.shippers.length)],
        flow,
        destinationCustomer: flow.customers[Math.floor(rng() * flow.customers.length)],
        releaseFraction: rng(),
      })
    }
  }
  return cars
}

/** A foreign-road car the registry does not know: its fact is the demo poison message. */
export const UNKNOWN_CAR = 'LPSX990001'
