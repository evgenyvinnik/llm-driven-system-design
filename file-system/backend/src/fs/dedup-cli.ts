/**
 * `npm run dedup -- <dir>`: prints groups of identical files under <dir>, and
 * how much reading it took to find them.
 */
import { scanDuplicates } from './dedup.js'

const root = process.argv[2] ?? '.'
const { groups, stats } = await scanDuplicates(root)
for (const group of groups) console.log(`${group.join('\n')}\n`)
console.log(
  `${groups.length} duplicate groups among ${stats.files} files. ` +
    `${stats.sizeCandidates} shared a size; ${stats.headHashed} head hashes, ${stats.fullHashed} full hashes; ` +
    `${(stats.bytesRead / 1024 / 1024).toFixed(1)} MB read.`,
)
