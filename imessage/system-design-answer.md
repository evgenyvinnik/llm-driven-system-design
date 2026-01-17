# iMessage - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design iMessage, Apple's end-to-end encrypted messaging platform that syncs across all user devices. The core challenge is building a system where messages are encrypted such that even Apple cannot read them, while still supporting multi-device sync, group messaging, and offline functionality.

This involves three key technical challenges: implementing the Signal-style encryption protocol with multi-device key management, designing efficient group messaging that scales beyond O(n) encryption per message, and building an offline-first architecture with reliable message delivery."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Send Messages**: Encrypted text, photos, videos, and files
- **Multi-Device Sync**: Messages appear on all user's devices (iPhone, iPad, Mac)
- **Group Chats**: Support for groups with admin controls
- **Offline Support**: Queue messages when offline, deliver when connected
- **Read Receipts**: Delivery and read status, typing indicators

### Non-Functional Requirements
- **Security**: End-to-end encryption where Apple cannot decrypt messages
- **Latency**: < 500ms message delivery for online recipients
- **Reliability**: Zero message loss guarantee
- **Scale**: Billions of messages daily

### Scale Estimates
- **Users**: 1.5 billion+ active iMessage users
- **Messages/day**: 10+ billion
- **Devices per user**: 3-5 average
- **Group size**: Average 5, max 100+ participants

### Key Questions I'd Ask
1. Should new devices get historical messages or only new ones?
2. What's the acceptable delay for message sync across devices?
3. How do we handle device revocation (lost/stolen phone)?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Devices                              │
│              iPhone │ iPad │ Mac │ Apple Watch                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    APNs / WebSocket                             │
│                  (Real-time delivery)                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Message Servers                               │
│    (Store encrypted blobs, route messages, key directory)       │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Key Directory │    │ Message Store │    │  iCloud Sync  │
│               │    │               │    │               │
│ - Device keys │    │ - Encrypted   │    │ - History     │
│ - Identity    │    │ - Attachments │    │ - Read state  │
│ - Prekeys     │    │ - Metadata    │    │ - Settings    │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Core Components

1. **Key Directory Service**: Stores public keys for each device
2. **Message Store**: Holds encrypted message blobs until delivered
3. **Push Service**: APNs/WebSocket for real-time message delivery
4. **iCloud Sync**: Synchronizes history and read state across devices

### Security Model

Apple's servers only see:
- Who is messaging whom (metadata)
- Encrypted message blobs
- Device public keys

Apple cannot see:
- Message content
- Attachments
- Private keys (stored only on device)

## Deep Dive: Multi-Device End-to-End Encryption (8 minutes)

This is the most critical and complex part of the system. Each user has multiple devices, and we need to encrypt messages for each one independently.

### Key Architecture

```javascript
class KeyManager {
  constructor(userId) {
    this.userId = userId;
    this.identityKey = null;      // Long-term identity key
    this.preKeys = [];            // One-time prekeys for forward secrecy
  }

  async initializeDevice(deviceId) {
    // Generate long-term identity key pair
    const identityKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    // Generate 100 one-time prekeys
    const preKeys = await this.generatePreKeys(100);

    // Register with key directory (only public keys!)
    await this.registerDevice(deviceId, {
      identityPublicKey: identityKey.publicKey,
      preKeys: preKeys.map(pk => pk.publicKey)
    });

    // Store private keys in device secure enclave
    await secureEnclave.store('identity', identityKey.privateKey);
    await secureEnclave.store('prekeys', preKeys);
  }
}
```

### Message Encryption Flow

When Alice sends a message to Bob:

1. **Fetch Bob's device keys** from Key Directory
2. **Generate message key** (random AES-256 key)
3. **Encrypt message content** with message key
4. **For each of Bob's devices**:
   - Perform X3DH key agreement to derive shared secret
   - Wrap message key with shared secret
5. **Also encrypt for Alice's other devices** (so they see sent messages)
6. **Send to server**: encrypted content + wrapped keys per device

```javascript
class MessageEncryptor {
  async encryptMessage(senderId, recipientId, message) {
    // Get all recipient AND sender devices
    const recipientDevices = await this.keyManager.getDeviceKeys(recipientId);
    const senderDevices = await this.keyManager.getDeviceKeys(senderId);
    const allDevices = [...recipientDevices, ...senderDevices];

    // Generate message key
    const messageKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // Encrypt message content
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedContent = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      messageKey,
      new TextEncoder().encode(JSON.stringify(message))
    );

    // Encrypt message key for each device (X3DH)
    const encryptedKeys = [];
    for (const device of allDevices) {
      const encryptedKey = await this.encryptKeyForDevice(messageKey, device);
      encryptedKeys.push({
        deviceId: device.deviceId,
        encryptedKey
      });
    }

    return { iv, encryptedContent, encryptedKeys };
  }
}
```

### X3DH Key Agreement

Extended Triple Diffie-Hellman creates a shared secret between sender and recipient:

```javascript
async encryptKeyForDevice(messageKey, device) {
  // Generate ephemeral key pair
  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  // DH1: ephemeral private + identity public
  const dh1 = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: device.identityKey },
    ephemeral.privateKey,
    256
  );

  // DH2: ephemeral private + prekey public
  const dh2 = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: device.preKey },
    ephemeral.privateKey,
    256
  );

  // Combine and derive wrapping key
  const combined = new Uint8Array([...new Uint8Array(dh1), ...new Uint8Array(dh2)]);
  const wrappingKey = await crypto.subtle.digest('SHA-256', combined);

  // Wrap message key
  const wrappedKey = await crypto.subtle.wrapKey('raw', messageKey, wrappingKey);

  return { ephemeralPublicKey: ephemeral.publicKey, wrappedKey };
}
```

### Why Per-Device Encryption?

| Approach | Pros | Cons |
|----------|------|------|
| Shared device key | Simple | Compromise one = all compromised |
| Per-device keys | Isolated compromise | O(devices) encryption |
| Prekeys | Forward secrecy | Key management complexity |

We chose per-device because security is paramount. If one device is compromised, others remain secure.

## Deep Dive: Group Messaging with Sender Keys (7 minutes)

The challenge: With N group members, naive encryption requires O(N) encryptions per message. For a 100-person group, that's 100 key wrapping operations per message.

### Sender Keys Protocol

Instead of encrypting for each recipient, each sender has a "sender key" known to all group members:

```javascript
class GroupMessageService {
  async createGroup(creatorId, memberIds) {
    const groupId = uuid();

    // Generate sender key for creator
    const senderKey = await this.generateSenderKey();

    // Distribute to all members (one-time O(N) cost)
    for (const memberId of memberIds) {
      await this.distributeSenderKey(groupId, creatorId, memberId, senderKey);
    }

    return groupId;
  }

  async sendGroupMessage(groupId, senderId, message) {
    // Get our sender key
    const senderKey = await this.getSenderKey(groupId, senderId);

    // Advance the ratchet (forward secrecy)
    const chainKey = this.advanceChain(senderKey);
    const messageKey = await this.deriveMessageKey(chainKey);

    // Encrypt once (O(1) instead of O(N))
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      messageKey,
      new TextEncoder().encode(JSON.stringify(message))
    );

    return {
      groupId,
      senderId,
      chainIndex: chainKey.index,  // So recipients know which key
      iv,
      encrypted
    };
  }
}
```

### Key Ratcheting

Each message advances a chain, deriving a new key:

```
Message 1: Key = HKDF(ChainKey, 1)
Message 2: Key = HKDF(ChainKey, 2)
...
```

This provides forward secrecy: if key 5 is compromised, messages 1-4 remain secure.

### Member Changes

**Adding a member**:
1. Distribute all existing sender keys to new member
2. Generate new sender key for new member
3. Distribute new member's key to existing members

**Removing a member**:
1. All remaining members generate NEW sender keys
2. Redistribute new keys to remaining members
3. Old keys become useless to removed member

## Deep Dive: Offline-First Architecture (5 minutes)

### Local-First Message Storage

```javascript
class OfflineManager {
  constructor() {
    this.localDb = new IndexedDB('imessage');
    this.pendingMessages = [];
  }

  async sendMessage(conversationId, content) {
    // Create message locally FIRST
    const message = {
      id: uuid(),
      conversationId,
      content,
      senderId: this.userId,
      timestamp: Date.now(),
      status: 'pending'
    };

    // Store locally immediately (user sees it)
    await this.localDb.put('messages', message);

    // Try to send
    if (this.isOnline()) {
      await this.transmitMessage(message);
    } else {
      this.pendingMessages.push(message);
    }

    return message;
  }

  async onOnline() {
    // Flush pending messages in order
    for (const message of this.pendingMessages) {
      await this.transmitMessage(message);
      await this.updateMessageStatus(message.id, 'sent');
    }
    this.pendingMessages = [];

    // Sync any missed messages from server
    await this.syncService.syncMessages();
  }
}
```

### Sync Cursors

Each device tracks a sync cursor - the last message it received:

```javascript
async syncMessages() {
  const response = await this.fetchMessages(this.syncCursor);

  for (const encryptedMessage of response.messages) {
    // Find our device's key
    const ourKey = encryptedMessage.encryptedKeys.find(
      k => k.deviceId === this.deviceId
    );

    if (!ourKey) continue; // Sent before we registered

    const message = await this.decryptMessage(encryptedMessage, ourKey);
    await this.storeMessage(message);
  }

  this.syncCursor = response.cursor;
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. Per-Device vs. Shared Encryption

**Chose: Per-device encryption**
- Pro: Device compromise is isolated
- Pro: Individual device revocation
- Con: O(devices) encryption per message
- Trade-off worth it for security

### 2. Sender Keys vs. Per-Message Encryption for Groups

**Chose: Sender keys**
- Pro: O(1) encryption per message
- Con: Complex key distribution on member changes
- Alternative: MLS (Messaging Layer Security) - more scalable for large groups

### 3. Full History Sync vs. Recent Only

**Chose: Full history (with encryption)**
- Pro: User expectation - see all messages on new device
- Con: Increased storage and sync time
- Trade-off: Optional - user can choose "Messages in iCloud"

### 4. Storage Location

**Chose: Server holds encrypted blobs until delivered**
- Pro: Offline delivery works
- Con: Server must store messages
- Alternative: P2P (no server storage, but requires both online)

### 5. Read Receipt Sync

**Chose: Sync read state across devices**
- Pro: Consistent experience
- Con: Privacy implications (receipts are metadata)
- User control: Can disable read receipts

### Security Considerations

**What Apple can see (metadata)**:
- Sender and recipient Apple IDs
- Timestamps
- Message sizes
- Device identifiers

**What Apple cannot see**:
- Message content
- Attachments
- Who is messaging in groups (if group ID obfuscation used)

## Closing Summary (1 minute)

"The iMessage system is built on three cryptographic pillars:

1. **Per-device end-to-end encryption** using X3DH key agreement - ensuring that even if one device is compromised, others remain secure, and Apple cannot read messages.

2. **Sender keys for groups** - solving the O(N) encryption problem by distributing sender keys upfront, enabling O(1) encryption per message.

3. **Offline-first with sync cursors** - messages are stored locally first for instant UX, then synchronized reliably when connectivity is available.

The main trade-off is complexity vs. security. We chose per-device encryption despite its complexity because messaging is deeply personal and security cannot be compromised. Future improvements would include implementing MLS (Messaging Layer Security) for better large-group scalability and adding metadata protection through techniques like sealed sender."
