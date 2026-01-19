/**
 * @fileoverview Cassandra client for Instagram Direct Messages.
 * Provides connection management and prepared statements for DM operations.
 */

import cassandra from 'cassandra-driver';
import { logger } from './logger.js';

const { Client, types } = cassandra;

// Cassandra configuration
const CASSANDRA_CONFIG = {
  contactPoints: (process.env.CASSANDRA_HOSTS || 'localhost').split(','),
  localDataCenter: process.env.CASSANDRA_DC || 'datacenter1',
  keyspace: process.env.CASSANDRA_KEYSPACE || 'instagram_dm',
};

let client = null;
let isConnected = false;

/**
 * Initialize Cassandra client connection.
 * @returns {Promise<void>}
 */
export async function initCassandra() {
  try {
    client = new Client({
      contactPoints: CASSANDRA_CONFIG.contactPoints,
      localDataCenter: CASSANDRA_CONFIG.localDataCenter,
      keyspace: CASSANDRA_CONFIG.keyspace,
      pooling: {
        coreConnectionsPerHost: {
          [cassandra.types.distance.local]: 2,
          [cassandra.types.distance.remote]: 1,
        },
      },
    });

    await client.connect();
    isConnected = true;
    logger.info({ contactPoints: CASSANDRA_CONFIG.contactPoints }, 'Cassandra connected successfully');
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to connect to Cassandra');
    // Don't throw - DMs are not critical for core functionality
    isConnected = false;
  }
}

/**
 * Get Cassandra client instance.
 * @returns {cassandra.Client|null}
 */
export function getCassandraClient() {
  return client;
}

/**
 * Check if Cassandra is connected.
 * @returns {boolean}
 */
export function isCassandraConnected() {
  return isConnected;
}

/**
 * Close Cassandra connection.
 * @returns {Promise<void>}
 */
export async function closeCassandra() {
  if (client) {
    await client.shutdown();
    isConnected = false;
    logger.info('Cassandra connection closed');
  }
}

/**
 * Generate a TimeUUID for message ordering.
 * @returns {cassandra.types.TimeUuid}
 */
export function generateTimeUuid() {
  return types.TimeUuid.now();
}

/**
 * Convert a string UUID to Cassandra UUID type.
 * @param {string} uuid - UUID string
 * @returns {cassandra.types.Uuid}
 */
export function toUuid(uuid) {
  return types.Uuid.fromString(uuid);
}

/**
 * Generate a sorted user pair key for conversation lookup.
 * @param {string} userId1 - First user UUID
 * @param {string} userId2 - Second user UUID
 * @returns {string}
 */
export function generateUserPairKey(userId1, userId2) {
  return [userId1, userId2].sort().join(':');
}

export { types };
