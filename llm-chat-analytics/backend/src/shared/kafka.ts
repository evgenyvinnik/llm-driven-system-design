/**
 * Kafka client and topic bootstrap. Events are keyed by org_id, so one org's
 * events stay in order within a partition.
 * @module shared/kafka
 */
import { Kafka, logLevel } from 'kafkajs'
import { config } from './config.js'

// The default partitioner (murmur2 on the key) is what we want; silence the v2 migration notice.
process.env.KAFKAJS_NO_PARTITIONER_WARNING ??= '1'

export const kafka = new Kafka({
  clientId: process.env.SERVICE_NAME || 'llm-chat-analytics',
  brokers: config.kafka.brokers,
  logLevel: logLevel.WARN,
  retry: { retries: 8, initialRetryTime: 300 },
})

export async function ensureTopic(): Promise<void> {
  const admin = kafka.admin()
  await admin.connect()
  try {
    const topics = await admin.listTopics()
    if (!topics.includes(config.kafka.topic)) {
      await admin.createTopics({
        topics: [{ topic: config.kafka.topic, numPartitions: config.kafka.partitions, replicationFactor: 1 }],
        waitForLeaders: true,
      })
    }
  } finally {
    await admin.disconnect()
  }
}
