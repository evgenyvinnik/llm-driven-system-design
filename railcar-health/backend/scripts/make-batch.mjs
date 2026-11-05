// Prints a gateway batch for the curl demo train (consist in scripts/consist-demo.json).
// Usage: node scripts/make-batch.mjs <detectorId> <minutesAgo> [hotCarIndex] [nowIso]
//   node scripts/make-batch.mjs HBD-085 0          > /tmp/fresh.json
//   node scripts/make-batch.mjs HBD-070 90 2       > /tmp/late.json   (measured 90 min ago, car 2 hot)
const [detectorId = 'HBD-085', minutesAgo = '0', hotCar = '0', nowIso] = process.argv.slice(2)
const now = nowIso ? new Date(nowIso).getTime() : Date.now()
const passedAt = new Date(now - Number(minutesAgo) * 60_000)
const axles = []
let seq = 0
for (let unit = 0; unit < 7; unit++) {
  const count = unit === 0 ? 6 : 4 // one locomotive, six cars
  for (let i = 1; i <= count; i++) {
    seq += 1
    for (const rail of ['N', 'S']) {
      const hot = unit === Number(hotCar) && unit > 0 && rail === 'N' && i === 1
      axles.push({ seq, rail, bearingF: 98 + (seq % 4) + (hot ? 55 : 0), wheelF: 72 })
    }
  }
}
const pass = {
  passId: `${detectorId}-${passedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}`,
  detectorId, tripId: 'DEMO-CURL-1', passedAt: passedAt.toISOString(), direction: 'EB', speedMph: 44, ambientF: 60, axleCount: seq, axles,
}
process.stdout.write(JSON.stringify({ gatewayId: `GW-${detectorId.slice(4)}`, sentAt: new Date(now).toISOString(), passes: [pass] }))
