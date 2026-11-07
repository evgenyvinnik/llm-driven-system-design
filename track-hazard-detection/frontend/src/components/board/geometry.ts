/** Shared geometry for the strip map: a fixed-width SVG, mileposts mapped linearly. */
export const W = 1000
export const PAD = 58
export const PAD_R = 16
export const ROW = { segment: 12, hazard: 34, restriction: 56, track: 70, trainLabel: 86, mp: 100, sensors: 116 }
export const SENSOR_ROW: Record<string, number> = { geophone: 0, slide_fence: 1, camera: 2, rail_temp: 3, water_level: 4 }
export const H = ROW.sensors + 5 * 10 + 8

export function scaleFor(startMp: number, endMp: number) {
  return (mp: number) => PAD + ((mp - startMp) / (endMp - startMp)) * (W - PAD - PAD_R)
}

export const SEV_COLOR: Record<string, string> = { CRITICAL: '#d03b3b', HIGH: '#ec835a', MEDIUM: '#fab219', LOW: '#94a3b8' }
