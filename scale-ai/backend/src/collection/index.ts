import { app } from './app.js'
import { ensureBuckets } from '../shared/storage.js'

const PORT = parseInt(process.env.PORT || '3001')

// Start server
async function start() {
  try {
    // Ensure MinIO buckets exist
    await ensureBuckets()

    app.listen(PORT, () => {
      console.log(`Collection service running on http://localhost:${PORT}`)
    })
  } catch (error) {
    console.error('Failed to start collection service:', error)
    process.exit(1)
  }
}

start()
