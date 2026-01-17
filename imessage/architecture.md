# Design iMessage - Architecture

## System Overview

iMessage is an encrypted messaging platform with multi-device sync. Core challenges involve E2E encryption across devices, message sync, and offline support.

**Learning Goals:**
- Build E2E encrypted messaging
- Design multi-device key management
- Implement message sync protocols
- Handle offline-first messaging

---

## Requirements

### Functional Requirements

1. **Send**: Send encrypted messages
2. **Sync**: Messages available on all devices
3. **Groups**: Create and manage group chats
4. **Media**: Share photos, videos, files
5. **Offline**: Work without connectivity

### Non-Functional Requirements

- **Security**: End-to-end encryption
- **Latency**: < 500ms message delivery
- **Reliability**: No message loss
- **Scale**: Billions of messages daily

---

## High-Level Architecture

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
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Core Components

### 1. Key Management

**Multi-Device Key Architecture:**
```javascript
class KeyManager {
  constructor(userId) {
    this.userId = userId
    this.identityKey = null // Long-term identity key
    this.preKeys = [] // One-time prekeys
    this.devices = new Map() // deviceId -> keys
  }

  async initializeDevice(deviceId) {
    // Generate identity key pair (long-term)
    const identityKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )

    // Generate device signing key
    const signingKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )

    // Generate prekeys for forward secrecy
    const preKeys = await this.generatePreKeys(100)

    // Register with key directory
    await this.registerDevice(deviceId, {
      identityPublicKey: identityKey.publicKey,
      signingPublicKey: signingKey.publicKey,
      preKeys: preKeys.map(pk => pk.publicKey)
    })

    return {
      identityKey,
      signingKey,
      preKeys
    }
  }

  async generatePreKeys(count) {
    const preKeys = []

    for (let i = 0; i < count; i++) {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      )

      preKeys.push({
        id: i,
        ...keyPair
      })
    }

    return preKeys
  }

  async getRecipientKeys(recipientId) {
    // Fetch all device keys for recipient
    const devices = await this.keyDirectory.getDeviceKeys(recipientId)

    return devices.map(device => ({
      deviceId: device.deviceId,
      identityKey: device.identityPublicKey,
      preKey: device.preKeys[0] // Server removes used prekeys
    }))
  }
}
```

### 2. Message Encryption

**Per-Device Encryption:**
```javascript
class MessageEncryptor {
  async encryptMessage(senderId, recipientId, message) {
    // Get all recipient devices
    const recipientDevices = await this.keyManager.getRecipientKeys(recipientId)

    // Get all sender devices (for sync)
    const senderDevices = await this.keyManager.getRecipientKeys(senderId)

    const allDevices = [...recipientDevices, ...senderDevices]

    // Generate message key
    const messageKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )

    // Encrypt message content
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encryptedContent = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      messageKey,
      new TextEncoder().encode(JSON.stringify(message))
    )

    // Encrypt message key for each device
    const encryptedKeys = []

    for (const device of allDevices) {
      const encryptedKey = await this.encryptKeyForDevice(
        messageKey,
        device
      )

      encryptedKeys.push({
        deviceId: device.deviceId,
        encryptedKey
      })
    }

    return {
      iv,
      encryptedContent,
      encryptedKeys
    }
  }

  async encryptKeyForDevice(messageKey, device) {
    // X3DH key agreement
    // Generate ephemeral key
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    )

    // Compute shared secret: DH(ephemeral, identityKey) || DH(ephemeral, preKey)
    const dh1 = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: device.identityKey },
      ephemeral.privateKey,
      256
    )

    const dh2 = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: device.preKey },
      ephemeral.privateKey,
      256
    )

    // Combine and derive encryption key
    const combined = new Uint8Array([...new Uint8Array(dh1), ...new Uint8Array(dh2)])
    const kdf = await crypto.subtle.digest('SHA-256', combined)

    const wrappingKey = await crypto.subtle.importKey(
      'raw',
      kdf,
      { name: 'AES-KW' },
      false,
      ['wrapKey']
    )

    // Wrap message key
    const wrappedKey = await crypto.subtle.wrapKey(
      'raw',
      messageKey,
      wrappingKey,
      { name: 'AES-KW' }
    )

    return {
      ephemeralPublicKey: await crypto.subtle.exportKey('raw', ephemeral.publicKey),
      wrappedKey
    }
  }
}
```

### 3. Message Sync

**Cross-Device Synchronization:**
```javascript
class MessageSyncService {
  constructor(userId, deviceId) {
    this.userId = userId
    this.deviceId = deviceId
    this.syncCursor = null
  }

  async syncMessages() {
    // Get messages since last sync
    const response = await this.fetchMessages(this.syncCursor)

    for (const encryptedMessage of response.messages) {
      // Find our device's encrypted key
      const ourKey = encryptedMessage.encryptedKeys.find(
        k => k.deviceId === this.deviceId
      )

      if (!ourKey) {
        // Message wasn't encrypted for this device
        // (sent before device was registered)
        continue
      }

      // Decrypt message
      const message = await this.decryptMessage(encryptedMessage, ourKey)

      // Store locally
      await this.storeMessage(message)
    }

    // Update sync cursor
    this.syncCursor = response.cursor

    // Sync read receipts
    await this.syncReadReceipts()

    return response.messages.length
  }

  async syncReadReceipts() {
    // Get read state changes from other devices
    const readUpdates = await this.fetchReadUpdates(this.lastReadSync)

    for (const update of readUpdates) {
      await this.markAsRead(update.conversationId, update.lastReadMessageId)
    }

    // Upload our read state
    const localReadState = await this.getLocalReadState()
    await this.uploadReadState(localReadState)
  }

  // Real-time message delivery
  async handleIncomingMessage(encryptedMessage) {
    const ourKey = encryptedMessage.encryptedKeys.find(
      k => k.deviceId === this.deviceId
    )

    if (!ourKey) return

    const message = await this.decryptMessage(encryptedMessage, ourKey)
    await this.storeMessage(message)

    // Notify UI
    this.emit('newMessage', message)

    // Send delivery receipt
    await this.sendDeliveryReceipt(message.id)
  }
}
```

### 4. Group Messaging

**Sender Keys for Groups:**
```javascript
class GroupMessageService {
  async createGroup(creatorId, memberIds, groupName) {
    const groupId = uuid()

    // Generate group sender key for creator
    const senderKey = await this.generateSenderKey()

    // Distribute sender key to all members
    for (const memberId of memberIds) {
      await this.distributeSenderKey(groupId, creatorId, memberId, senderKey)
    }

    // Create group record
    const group = {
      id: groupId,
      name: groupName,
      creator: creatorId,
      members: memberIds,
      admins: [creatorId],
      createdAt: Date.now()
    }

    await this.storeGroup(group)

    return group
  }

  async sendGroupMessage(groupId, senderId, message) {
    // Get our sender key for this group
    const senderKey = await this.getSenderKey(groupId, senderId)

    // Derive message key using sender key chain
    const chainKey = this.advanceChain(senderKey)
    const messageKey = await this.deriveMessageKey(chainKey)

    // Encrypt message
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      messageKey,
      new TextEncoder().encode(JSON.stringify(message))
    )

    // Store sender chain state
    await this.updateChainState(groupId, senderId, chainKey)

    return {
      groupId,
      senderId,
      chainIndex: chainKey.index,
      iv,
      encrypted
    }
  }

  async distributeSenderKey(groupId, fromId, toId, senderKey) {
    // Encrypt sender key for each of recipient's devices
    const devices = await this.keyManager.getRecipientKeys(toId)

    for (const device of devices) {
      const encrypted = await this.encryptSenderKey(senderKey, device)

      await this.sendSenderKeyMessage(toId, device.deviceId, {
        type: 'sender_key',
        groupId,
        fromId,
        encrypted
      })
    }
  }

  async addMember(groupId, newMemberId, addedBy) {
    // Get all existing members' sender keys
    const group = await this.getGroup(groupId)

    // Distribute existing sender keys to new member
    for (const existingMember of group.members) {
      const senderKey = await this.getSenderKey(groupId, existingMember)
      await this.distributeSenderKey(groupId, existingMember, newMemberId, senderKey)
    }

    // Generate sender key for new member
    const newMemberKey = await this.generateSenderKey()

    // Distribute new member's key to all existing members
    for (const existingMember of group.members) {
      await this.distributeSenderKey(groupId, newMemberId, existingMember, newMemberKey)
    }

    // Update group membership
    await this.updateGroupMembers(groupId, [...group.members, newMemberId])
  }
}
```

### 5. Offline Support

**Offline-First Architecture:**
```javascript
class OfflineManager {
  constructor() {
    this.pendingMessages = []
    this.localDb = new IndexedDB('imessage')
  }

  async sendMessage(conversationId, content) {
    // Create message locally
    const message = {
      id: uuid(),
      conversationId,
      content,
      senderId: this.userId,
      timestamp: Date.now(),
      status: 'pending'
    }

    // Store locally immediately
    await this.localDb.put('messages', message)

    // Try to send
    if (this.isOnline()) {
      await this.transmitMessage(message)
    } else {
      // Queue for later
      this.pendingMessages.push(message)
    }

    return message
  }

  async onOnline() {
    // Flush pending messages
    for (const message of this.pendingMessages) {
      try {
        await this.transmitMessage(message)
        await this.updateMessageStatus(message.id, 'sent')
      } catch (error) {
        console.error('Failed to send message', error)
      }
    }

    this.pendingMessages = []

    // Sync with server
    await this.syncService.syncMessages()
  }

  async getConversation(conversationId) {
    // Always read from local database
    const messages = await this.localDb.getAll('messages', {
      index: 'conversationId',
      query: conversationId
    })

    return messages.sort((a, b) => a.timestamp - b.timestamp)
  }
}
```

---

## Database Schema

```sql
-- Conversations
CREATE TABLE conversations (
  id UUID PRIMARY KEY,
  type VARCHAR(20), -- 'direct', 'group'
  name VARCHAR(200),
  participants UUID[],
  created_at TIMESTAMP DEFAULT NOW()
);

-- Messages (encrypted)
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  sender_id UUID NOT NULL,
  encrypted_content BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Per-device message keys
CREATE TABLE message_keys (
  message_id UUID REFERENCES messages(id),
  device_id UUID NOT NULL,
  encrypted_key BYTEA NOT NULL,
  ephemeral_public_key BYTEA NOT NULL,
  PRIMARY KEY (message_id, device_id)
);

-- Device Keys (public)
CREATE TABLE device_keys (
  device_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  identity_public_key BYTEA NOT NULL,
  signing_public_key BYTEA NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Prekeys (one-time use)
CREATE TABLE prekeys (
  id BIGSERIAL PRIMARY KEY,
  device_id UUID REFERENCES device_keys(device_id),
  prekey_id INTEGER NOT NULL,
  public_key BYTEA NOT NULL,
  used BOOLEAN DEFAULT FALSE
);

-- Read Receipts
CREATE TABLE read_receipts (
  user_id UUID NOT NULL,
  conversation_id UUID REFERENCES conversations(id),
  last_read_message_id UUID,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);
```

---

## Key Design Decisions

### 1. Per-Device Encryption

**Decision**: Encrypt message key for each device separately

**Rationale**:
- No shared device key to compromise
- New devices get new messages only
- Per-device revocation

### 2. Sender Keys for Groups

**Decision**: Use Signal's sender keys protocol

**Rationale**:
- O(1) encryption per message (not O(n))
- Forward secrecy via key ratchet
- Efficient for large groups

### 3. Offline-First Storage

**Decision**: Store messages locally before sending

**Rationale**:
- Instant perceived send
- Works without network
- Sync when online

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Device encryption | Per-device | Shared key | Security, revocation |
| Group encryption | Sender keys | Per-message | Efficiency |
| Storage | Offline-first | Server-first | UX, reliability |
| Sync | Full history | Last N days | User expectation |
