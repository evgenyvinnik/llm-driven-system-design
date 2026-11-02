import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';

/**
 * Simulated SFU (Selective Forwarding Unit) Service
 *
 * This models the correct mediasoup architecture without requiring
 * native C++ compilation. In production, each concept maps to:
 * - Worker: OS-level process handling media routing (1 per CPU core)
 * - Router: Media routing context for a meeting room (RTP capabilities)
 * - WebRtcTransport: ICE+DTLS connection for sending or receiving media
 * - Producer: An endpoint producing (sending) audio/video
 * - Consumer: An endpoint consuming (receiving) a producer's media
 *
 * The signaling protocol is implemented correctly; only the actual
 * media packet forwarding is simulated.
 */

export interface SfuParticipant {
  userId: string;
  transportIds: { send: string; recv: string };
  producerIds: string[];
  consumerIds: string[];
}

export interface SfuRoom {
  routerId: string;
  rtpCapabilities: SimulatedRtpCapabilities;
  participants: Map<string, SfuParticipant>;
}

interface SimulatedRtpCapabilities {
  codecs: Array<{
    mimeType: string;
    kind: 'audio' | 'video';
    clockRate: number;
    channels?: number;
  }>;
}

export interface ProducerInfo {
  id: string;
  kind: 'audio' | 'video' | 'screen';
  userId: string;
  meetingId: string;
  rtpParameters: unknown;
}

interface ConsumerInfo {
  id: string;
  producerId: string;
  userId: string;
  kind: 'audio' | 'video' | 'screen';
  rtpParameters: unknown;
}

const DEFAULT_RTP_CAPABILITIES: SimulatedRtpCapabilities = {
  codecs: [
    { mimeType: 'audio/opus', kind: 'audio', clockRate: 48000, channels: 2 },
    { mimeType: 'video/VP8', kind: 'video', clockRate: 90000 },
    { mimeType: 'video/H264', kind: 'video', clockRate: 90000 },
  ],
};

function generateSimulatedTransportOptions() {
  return {
    id: uuidv4(),
    iceParameters: {
      usernameFragment: uuidv4().substring(0, 8),
      password: uuidv4().replace(/-/g, '').substring(0, 24),
      iceLite: true,
    },
    iceCandidates: [
      {
        foundation: 'udpcandidate',
        ip: '127.0.0.1',
        port: 40000 + Math.floor(Math.random() * 10000),
        priority: 1078862079,
        protocol: 'udp',
        type: 'host',
      },
    ],
    dtlsParameters: {
      role: 'auto',
      fingerprints: [
        {
          algorithm: 'sha-256',
          value: Array.from({ length: 32 }, () =>
            Math.floor(Math.random() * 256)
              .toString(16)
              .padStart(2, '0')
          ).join(':'),
        },
      ],
    },
  };
}

class SfuService {
  private rooms: Map<string, SfuRoom> = new Map();
  private producers: Map<string, ProducerInfo> = new Map();
  private consumers: Map<string, ConsumerInfo> = new Map();

  createRoom(meetingId: string): string {
    if (this.rooms.has(meetingId)) {
      logger.debug({ meetingId }, 'SFU room already exists');
      return this.rooms.get(meetingId)!.routerId;
    }

    const routerId = uuidv4();
    const room: SfuRoom = {
      routerId,
      rtpCapabilities: DEFAULT_RTP_CAPABILITIES,
      participants: new Map(),
    };
    this.rooms.set(meetingId, room);

    logger.info({ meetingId, routerId }, 'SFU: Created Router for meeting (simulated Worker allocation)');
    return routerId;
  }

  joinRoom(meetingId: string, userId: string): {
    sendTransportOptions: ReturnType<typeof generateSimulatedTransportOptions>;
    recvTransportOptions: ReturnType<typeof generateSimulatedTransportOptions>;
    routerRtpCapabilities: SimulatedRtpCapabilities;
  } {
    let room = this.rooms.get(meetingId);
    if (!room) {
      this.createRoom(meetingId);
      room = this.rooms.get(meetingId)!;
    }

    // Re-joining replaces the previous transports; their producers must go with
    // them or they stay advertised to everyone as live tracks forever.
    if (room.participants.has(userId)) {
      this.leaveRoom(meetingId, userId);
      room = this.rooms.get(meetingId);
      if (!room) {
        this.createRoom(meetingId);
        room = this.rooms.get(meetingId)!;
      }
    }

    const sendTransportOptions = generateSimulatedTransportOptions();
    const recvTransportOptions = generateSimulatedTransportOptions();

    const participant: SfuParticipant = {
      userId,
      transportIds: {
        send: sendTransportOptions.id,
        recv: recvTransportOptions.id,
      },
      producerIds: [],
      consumerIds: [],
    };

    room.participants.set(userId, participant);

    logger.info(
      { meetingId, userId, sendTransportId: sendTransportOptions.id, recvTransportId: recvTransportOptions.id },
      'SFU: Created WebRtcTransports for participant (send + recv)'
    );

    return {
      sendTransportOptions,
      recvTransportOptions,
      routerRtpCapabilities: room.rtpCapabilities,
    };
  }

  createProducer(
    meetingId: string,
    userId: string,
    kind: 'audio' | 'video' | 'screen',
    rtpParameters: unknown
  ): string {
    const room = this.rooms.get(meetingId);
    if (!room) throw new Error(`SFU room not found for meeting ${meetingId}`);

    const participant = room.participants.get(userId);
    if (!participant) throw new Error(`Participant ${userId} not in SFU room ${meetingId}`);

    // One track per kind per participant, as a real client sends. Unbounded
    // produce calls would otherwise grow the producer map without limit.
    if (this.findProducer(meetingId, userId, kind)) {
      throw new Error(`Participant ${userId} is already producing ${kind}`);
    }

    const producerId = uuidv4();
    participant.producerIds.push(producerId);

    this.producers.set(producerId, {
      id: producerId,
      kind,
      userId,
      meetingId,
      rtpParameters,
    });

    logger.info(
      { meetingId, userId, producerId, kind },
      'SFU: Producer created — media track registered on Router'
    );

    return producerId;
  }

  createConsumer(
    meetingId: string,
    userId: string,
    producerId: string
  ): { consumerId: string; kind: 'audio' | 'video' | 'screen'; rtpParameters: unknown } {
    const room = this.rooms.get(meetingId);
    if (!room) throw new Error(`SFU room not found for meeting ${meetingId}`);

    const participant = room.participants.get(userId);
    if (!participant) throw new Error(`Participant ${userId} not in SFU room ${meetingId}`);

    // A Router only forwards tracks within its own room: consuming a producer from
    // another meeting would hand that meeting's media to an outsider.
    const producer = this.producers.get(producerId);
    if (!producer || producer.meetingId !== meetingId) throw new Error(`Producer ${producerId} not found`);
    if (producer.userId === userId) throw new Error('Cannot consume your own producer');

    // Idempotent per (subscriber, producer): a retried consume returns the same
    // Consumer instead of stacking duplicates that are never closed.
    for (const consumerId of participant.consumerIds) {
      const existing = this.consumers.get(consumerId);
      if (existing && existing.producerId === producerId) {
        return { consumerId, kind: existing.kind, rtpParameters: existing.rtpParameters };
      }
    }

    const consumerId = uuidv4();
    participant.consumerIds.push(consumerId);

    const consumer: ConsumerInfo = {
      id: consumerId,
      producerId,
      userId,
      kind: producer.kind,
      rtpParameters: producer.rtpParameters,
    };
    this.consumers.set(consumerId, consumer);

    logger.info(
      { meetingId, userId, consumerId, producerId, kind: producer.kind },
      'SFU: Consumer created — Router will forward media from Producer to Consumer'
    );

    return {
      consumerId,
      kind: producer.kind,
      rtpParameters: producer.rtpParameters,
    };
  }

  closeProducer(meetingId: string, producerId: string): string | null {
    const producer = this.producers.get(producerId);
    if (!producer) return null;

    const room = this.rooms.get(meetingId);
    if (room) {
      const participant = room.participants.get(producer.userId);
      if (participant) {
        participant.producerIds = participant.producerIds.filter((id) => id !== producerId);
      }
    }

    // Close all consumers of this producer, including the ids each subscriber holds
    const consumersToRemove: string[] = [];
    for (const [consumerId, consumer] of this.consumers) {
      if (consumer.producerId === producerId) {
        consumersToRemove.push(consumerId);
      }
    }
    for (const consumerId of consumersToRemove) {
      const consumer = this.consumers.get(consumerId);
      const subscriber = consumer && room?.participants.get(consumer.userId);
      if (subscriber) {
        subscriber.consumerIds = subscriber.consumerIds.filter((id) => id !== consumerId);
      }
      this.consumers.delete(consumerId);
    }

    this.producers.delete(producerId);

    logger.info(
      { meetingId, producerId, closedConsumers: consumersToRemove.length },
      'SFU: Producer closed — all downstream Consumers removed'
    );

    return producer.userId;
  }

  /** Removes a participant and everything they produced or consumed. Returns the closed producer ids. */
  leaveRoom(meetingId: string, userId: string): string[] {
    const room = this.rooms.get(meetingId);
    if (!room) return [];

    const participant = room.participants.get(userId);
    if (!participant) return [];

    // Close all producers for this participant
    const closedProducerIds = [...participant.producerIds];
    for (const producerId of closedProducerIds) {
      this.closeProducer(meetingId, producerId);
    }

    // Remove all consumers for this participant
    for (const consumerId of participant.consumerIds) {
      this.consumers.delete(consumerId);
    }

    room.participants.delete(userId);

    logger.info(
      { meetingId, userId },
      'SFU: Participant left — Transports closed, Producers/Consumers cleaned up'
    );

    // If room is empty, clean it up
    if (room.participants.size === 0) {
      this.rooms.delete(meetingId);
      logger.info({ meetingId }, 'SFU: Room empty — Router closed');
    }
    return closedProducerIds;
  }

  /** Closes a meeting's Router with every participant in it (meeting ended). */
  closeRoom(meetingId: string): void {
    const room = this.rooms.get(meetingId);
    if (!room) return;
    for (const userId of [...room.participants.keys()]) {
      this.leaveRoom(meetingId, userId);
    }
    this.rooms.delete(meetingId);
  }

  getProducer(producerId: string): ProducerInfo | undefined {
    return this.producers.get(producerId);
  }

  findProducer(meetingId: string, userId: string, kind: ProducerInfo['kind']): ProducerInfo | undefined {
    for (const producer of this.producers.values()) {
      if (producer.meetingId === meetingId && producer.userId === userId && producer.kind === kind) {
        return producer;
      }
    }
    return undefined;
  }

  getRoom(meetingId: string): SfuRoom | undefined {
    return this.rooms.get(meetingId);
  }

  getProducersForRoom(meetingId: string, excludeUserId?: string): ProducerInfo[] {
    const result: ProducerInfo[] = [];
    for (const producer of this.producers.values()) {
      if (producer.meetingId === meetingId && producer.userId !== excludeUserId) {
        result.push(producer);
      }
    }
    return result;
  }

  getRoomStats(): { totalRooms: number; totalParticipants: number; totalProducers: number; totalConsumers: number } {
    let totalParticipants = 0;
    for (const room of this.rooms.values()) {
      totalParticipants += room.participants.size;
    }
    return {
      totalRooms: this.rooms.size,
      totalParticipants,
      totalProducers: this.producers.size,
      totalConsumers: this.consumers.size,
    };
  }
}

/** Singleton simulated SFU service modeling mediasoup architecture for signaling. */
export const sfuService = new SfuService();
