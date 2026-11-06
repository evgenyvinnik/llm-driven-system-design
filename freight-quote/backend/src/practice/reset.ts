/**
 * npm run practice:reset: overwrites practice/attempt/quote-service.ts with the stub.
 */
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
copyFileSync(join(here, 'starter', 'quote-service.ts'), join(here, 'attempt', 'quote-service.ts'))
console.log('Restored src/practice/attempt/quote-service.ts to the stub. Run `npm run practice` to see the suite fail, then make it pass.')
