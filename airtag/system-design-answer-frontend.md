# AirTag Find My - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 1. Introduction

Design the frontend experience for Apple's Find My app for AirTag, enabling users to locate their items through a privacy-preserving crowd-sourced network.

**Core Frontend Challenges:**
- Interactive map with real-time location updates
- Privacy-preserving decryption in the browser/app
- Anti-stalking detection UI and notifications
- Precision finding with UWB directional guidance
- Offline-capable device management

---

## 2. Requirements

### Functional Requirements
1. **Device Map**: Display all registered devices on an interactive map
2. **Location History**: Show location trail with timestamps
3. **Lost Mode**: Enable/disable with custom contact message
4. **Precision Finding**: UWB-based directional guidance when nearby
5. **Anti-Stalking**: Alert users about unknown trackers with action options
6. **Notifications**: Real-time alerts for device found and safety warnings

### Non-Functional Requirements
1. **Performance**: Map loads in < 2 seconds, smooth 60fps interactions
2. **Privacy**: Client-side decryption of location data
3. **Offline**: View last known locations without network
4. **Accessibility**: Screen reader support, high contrast mode
5. **Cross-Platform**: iOS, Android, macOS, web

### User Experience Goals
- Minimal steps to find a lost item
- Clear visual feedback for precision finding
- Non-alarming anti-stalking notifications (avoid false panic)
- Simple device registration flow

---

## 3. High-Level Design

### App Shell Architecture

```
+------------------------------------------------------------------+
|                      Find My Application                          |
|                                                                   |
|  +-------------------------------------------------------------+  |
|  |                       App Shell                              |  |
|  |   +----------+  +---------+  +---------+  +--------+        |  |
|  |   | Devices  |  |   Map   |  | People  |  |   Me   |        |  |
|  |   +----------+  +---------+  +---------+  +--------+        |  |
|  +-------------------------------------------------------------+  |
|                               |                                   |
|  +----------------------------v--------------------------------+  |
|  |                      Main View                               |  |
|  |  +-------------------------------------------------------+  |  |
|  |  |                 Interactive Map                        |  |  |
|  |  |                                                        |  |  |
|  |  |    +------+       +------+       +--------+           |  |  |
|  |  |    | Keys |       | Bag  |       | Wallet |           |  |  |
|  |  |    +------+       +------+       +--------+           |  |  |
|  |  |                                                        |  |  |
|  |  +-------------------------------------------------------+  |  |
|  |                                                              |  |
|  |  +-------------------------------------------------------+  |  |
|  |  |            Device Card (Selected)                      |  |  |
|  |  |   Name  |  Last Seen  |  Play Sound  |  Directions    |  |  |
|  |  +-------------------------------------------------------+  |  |
|  +--------------------------------------------------------------+  |
+--------------------------------------------------------------------+
```

### Component Tree

```
+-- App Shell
    |
    +-- Navigation Bar
    |   +-- Devices Tab
    |   +-- Map Tab
    |   +-- People Tab
    |   +-- Settings Tab
    |
    +-- Main Content Area
    |   |
    |   +-- Map View
    |   |   +-- Map Container (Leaflet)
    |   |   +-- Device Markers (clustered)
    |   |   +-- Accuracy Circles
    |   |   +-- Location History Trail
    |   |
    |   +-- Device List Overlay
    |   |   +-- Device Cards
    |   |   +-- Search/Filter
    |   |
    |   +-- Device Detail Panel
    |       +-- Location Info
    |       +-- Actions (Sound, Lost Mode)
    |       +-- Precision Find Button
    |
    +-- Notification Center
    |   +-- Tracker Alerts
    |   +-- Found Notifications
    |
    +-- Offline Indicator
```

---

## 4. Deep Dive: Key Components

### 4.1 Map Component Design

**User Interaction Flow:**

```
User Opens App
      |
      v
+------------------+
| Load Device List |-----> Fetch from cache if offline
+------------------+
      |
      v
+----------------------+
| Decrypt Locations    |-----> Client-side WebCrypto
| (locally)            |
+----------------------+
      |
      v
+------------------+
| Render Map with  |
| Device Markers   |
+------------------+
      |
      v
User Taps Marker
      |
      v
+------------------+
| Show Device Card |
| with Actions     |
+------------------+
      |
      +-----> Play Sound
      |
      +-----> Get Directions
      |
      +-----> Enable Lost Mode
      |
      +-----> Start Precision Find (if nearby)
```

**Marker State Visualization:**

```
+-------------+     +-------------+     +-------------+
|   Recent    |     |    Stale    |     |   Offline   |
|  (< 15 min) |     |  (> 15 min) |     |  (no data)  |
+-------------+     +-------------+     +-------------+
      |                   |                   |
      v                   v                   v
  Green ring         Gray ring           Dashed ring
  + Pulse animation  + Time label        + "?" icon
```

### Why Leaflet Over Native MapKit?

| Approach | Pros | Cons |
|----------|------|------|
| Leaflet | Cross-platform, open source, extensive plugins, one codebase | Not native look, bundle size (~40KB) |
| Native MapKit | Native iOS experience, system integration, best performance | iOS only, need separate Android/web implementations |
| Google Maps | Rich features, familiar UI, Street View | Licensing costs, privacy concerns, vendor lock-in |

**Decision: Leaflet**

"I'm choosing Leaflet because Find My needs to work across iOS, macOS, and web. While MapKit provides the best native iOS experience, we'd need three different map implementations. Leaflet gives us one codebase with consistent behavior. The react-leaflet wrapper integrates well with our React stack, and the plugin ecosystem (marker clustering, gesture handling) covers our needs."

---

### 4.2 Client-Side Decryption Architecture

**Privacy Flow:**

```
+-------------------+      +-------------------+      +-------------------+
|    AirTag         |      |   Finder iPhone   |      |   Apple Servers   |
| (broadcasts keys) |----->| (encrypts loc)    |----->| (stores blobs)    |
+-------------------+      +-------------------+      +-------------------+
                                                               |
                                                               | Encrypted
                                                               | location
                                                               | reports
                                                               v
                           +-------------------+      +-------------------+
                           |   Owner Device    |<-----|   Query by hash   |
                           | (decrypts local)  |      +-------------------+
                           +-------------------+
                                    |
                                    v
                           +-------------------+
                           |   Display on Map  |
                           +-------------------+
```

**Decryption Sequence:**

```
1. Generate period keys
   |
   +---> Master Secret + Period Number
         |
         +---> HKDF Derivation
               |
               +---> Private Key (per 15-min period)

2. Query encrypted reports
   |
   +---> Hash(Public Key) --> Server
         |
         +---> Encrypted blobs returned

3. Decrypt each report
   |
   +---> ECDH shared secret
         |
         +---> AES-GCM decrypt
               |
               +---> Latitude, Longitude, Timestamp
```

### Why Client-Side Decryption with WebCrypto?

| Approach | Pros | Cons |
|----------|------|------|
| WebCrypto client-side | Privacy preserved, server never sees locations, user controls keys | Slower decryption, complex key management, limited browser support |
| Server-side decryption | Faster, simpler client, easier debugging | Privacy violation, single point of failure, regulatory concerns |
| Hybrid (server assists) | Balance of speed and privacy | Still exposes keys to server, complex trust model |

**Decision: Client-Side WebCrypto**

"I'm choosing client-side decryption because privacy is the core value proposition. Users trust Find My because Apple cannot see their locations. WebCrypto API provides hardware-backed cryptography on modern devices. Yes, decryption is slower, but we can show progress UI and batch operations. The privacy guarantee is non-negotiable for this product."

---

### 4.3 Precision Finding UI (UWB)

**Directional Interface:**

```
+------------------------------------------+
|                                          |
|              Direction Arrow             |
|                                          |
|                   ^                      |
|                  /|\                     |
|                 / | \                    |
|                /  |  \                   |
|               /___|___\                  |
|                                          |
|           Distance: 2.3m                 |
|                                          |
|    [|||||||||||||.........]  Signal      |
|                                          |
|         "Move forward"                   |
|                                          |
|         [ Play Sound ]                   |
|                                          |
+------------------------------------------+
```

**Distance-Based Feedback:**

```
Distance        Visual              Haptic              Audio
--------        ------              ------              -----
> 10m           Blue arrow          None                None
5-10m           Blue arrow          Light pulse         None
3-5m            Yellow arrow        Medium pulse        Optional
1-3m            Yellow, larger      Strong pulse        Chirp
< 1m            Green, pulsing      Continuous          Found!
```

### Why UWB for Precision Finding Over Bluetooth RSSI?

| Approach | Pros | Cons |
|----------|------|------|
| UWB (Ultra-Wideband) | Centimeter accuracy, directional (azimuth + elevation), works through walls | Requires UWB hardware, higher power, shorter range |
| Bluetooth RSSI | All devices support it, lower power, longer range | Meter-level accuracy, no direction, multipath issues |
| Bluetooth AoA/AoD | Better than RSSI, direction capable | Complex antenna arrays, not widely deployed |

**Decision: UWB with Bluetooth Fallback**

"I'm choosing UWB as the primary precision finding technology because it provides actual direction, not just proximity. Users can see an arrow pointing exactly where to go. For devices without UWB support, we fall back to Bluetooth RSSI with a simpler 'warmer/colder' interface. The dual approach covers all devices while giving the best experience on newer hardware."

### Why Haptic Feedback Patterns Based on Distance?

| Approach | Pros | Cons |
|----------|------|------|
| Haptic feedback | Multi-sensory, works without looking at screen, intuitive | Battery drain, may be disabled, not all devices support |
| Audio only | Everyone hears it, simple to implement | Social situations, noisy environments, accessibility |
| Visual only | Clear, precise information | Requires screen focus, accessibility concerns |

**Decision: Multi-Sensory (Haptic + Visual + Optional Audio)**

"I'm choosing a multi-sensory approach because users search in different contexts - a quiet office vs a loud concert venue. Haptic feedback lets you keep the phone in your pocket while walking toward the item. Visual provides precise information when you can look. Audio is optional for those who want it. This combination is most reliable across scenarios."

---

### 4.4 Anti-Stalking Detection UI

**Alert Flow with Progressive Disclosure:**

```
Initial Alert (non-alarming)
      |
      v
+--------------------------------------+
| "Unknown AirTag Found"               |
| Traveling with you for 2 hours       |
|                                      |
| [View Locations]  [Play Sound]       |
+--------------------------------------+
      |
      | User taps "Learn More"
      v
+--------------------------------------+
| What This Means                      |
|                                      |
| - May be in borrowed item            |
| - May be placed by someone           |
| - Tap Play Sound to locate           |
|                                      |
| [How to Disable]  [Report to Police] |
+--------------------------------------+
      |
      | User taps "How to Disable"
      v
+--------------------------------------+
| Disable Unknown AirTag               |
|                                      |
| 1. Play sound to locate              |
| 2. Remove battery (twist bottom)     |
| 3. Scan with NFC for owner info      |
|                                      |
| [I Found It]  [Can't Find It]        |
+--------------------------------------+
```

**Tracker Path Visualization:**

```
+------------------------------------------------+
|                    Map                          |
|                                                 |
|        Home *-----------------------+           |
|             \                       |           |
|              \                      |           |
|               * Cafe                |           |
|                \                    |           |
|                 \                   |           |
|                  * Grocery          |           |
|                   \                 |           |
|                    *----------------+ Work      |
|                                                 |
| Legend:  * = Tracker sighting                   |
|          --- = Your path with tracker           |
+------------------------------------------------+
```

### Why Progressive Disclosure in Anti-Stalking UI?

| Approach | Pros | Cons |
|----------|------|------|
| Progressive disclosure | Reduces panic, user-controlled depth, cleaner initial UI | May delay critical information, extra taps |
| Full information upfront | Immediate awareness, no hidden content | Can cause unnecessary alarm, overwhelming |
| Dismissable minimal alert | Least intrusive, user choice | May be ignored, safety risk |

**Decision: Progressive Disclosure**

"I'm choosing progressive disclosure because anti-stalking alerts have a high false positive rate - borrowed items, family members' AirTags, etc. Showing 'STALKER DETECTED' causes panic when it's often a false alarm. By starting with neutral language and letting users drill down, we give control without causing unnecessary fear. Users who need the full information can access it immediately."

---

### 4.5 State Management

**Store Structure:**

```
FindMyStore
|
+-- devices: Map<deviceId, Device>
|   +-- id, name, emoji, lostMode
|
+-- locations: Map<deviceId, Location[]>
|   +-- latitude, longitude, timestamp, accuracy
|
+-- selectedDeviceId: string | null
|
+-- notifications: Notification[]
|   +-- type: "found" | "tracker_alert" | "low_battery"
|   +-- isRead: boolean
|
+-- ui
|   +-- isDecrypting: boolean
|   +-- decryptionProgress: number (0-100)
|   +-- isOffline: boolean
|
+-- actions
    +-- selectDevice(id)
    +-- refreshDevices()
    +-- fetchLocations(deviceId, timeRange)
    +-- markNotificationRead(id)
```

### Why Zustand Over Redux for State Management?

| Approach | Pros | Cons |
|----------|------|------|
| Zustand | Simple API, less boilerplate, built-in devtools, small bundle | Less ecosystem, fewer patterns for complex apps |
| Redux + RTK | Mature ecosystem, middleware, time-travel debugging | Verbose, steeper learning curve, larger bundle |
| React Context | No dependencies, built-in | Performance issues with frequent updates, no middleware |
| Jotai/Recoil | Atomic state, fine-grained reactivity | Newer, less ecosystem, learning curve |

**Decision: Zustand**

"I'm choosing Zustand because Find My has moderate state complexity - a dozen devices, their locations, and UI state. Redux would add boilerplate without proportional benefit. Zustand's simple API means less code to maintain. The store is easy to test and the devtools integration helps debugging. If we grow to hundreds of devices or add complex async workflows, we can migrate."

---

### 4.6 Offline Support

**Caching Strategy:**

```
+-------------------+     +-------------------+     +-------------------+
|   App Launches    |---->| Check Network     |---->| Online?           |
+-------------------+     +-------------------+     +-------------------+
                                                           |
                          +--------------------------------+
                          |                                |
                          v                                v
                   +-------------+                  +-------------+
                   |   ONLINE    |                  |   OFFLINE   |
                   +-------------+                  +-------------+
                          |                                |
                          v                                v
                   +-------------+                  +-------------+
                   | Fetch fresh |                  | Load cache  |
                   | from API    |                  | from SW     |
                   +-------------+                  +-------------+
                          |                                |
                          v                                v
                   +-------------+                  +-------------+
                   | Update      |                  | Show stale  |
                   | cache       |                  | indicator   |
                   +-------------+                  +-------------+
                          |                                |
                          +--------------------------------+
                                         |
                                         v
                                  +-------------+
                                  | Render map  |
                                  | with data   |
                                  +-------------+
```

**Cached Assets:**

```
Service Worker Cache
|
+-- Static assets (shell, icons, fonts)
|
+-- Map tiles (frequently viewed areas)
|
+-- Device list (names, emojis, last known location)
|
+-- Recent location history (last 7 days)
|
+-- Offline fallback page
```

### Why Service Worker Caching for Offline?

| Approach | Pros | Cons |
|----------|------|------|
| Service Worker cache | Works offline, fine-grained control, background sync | Complex to debug, cache invalidation, browser differences |
| localStorage only | Simple, synchronous, widely supported | 5MB limit, no asset caching, blocks main thread |
| IndexedDB only | Large storage, async, structured data | No asset caching, more complex API |
| No offline support | Simpler implementation | Useless when you need it most (lost device) |

**Decision: Service Worker with IndexedDB**

"I'm choosing Service Worker caching because offline support is critical for Find My. Users often search for lost items in areas with poor connectivity - basement, rural area, airplane mode. The cache-then-network strategy ensures the app works immediately. We cache map tiles for frequently viewed areas and store decrypted locations in IndexedDB. This is exactly the scenario where offline matters most."

---

### 4.7 Auto-Refresh Strategy

**Polling Approach:**

```
+------------------+
| App in Foreground|
+------------------+
        |
        v
+------------------+
| Start 60s Timer  |
+------------------+
        |
        | (60 seconds)
        v
+------------------+       +------------------+
| Fetch New        |------>| Decrypt New      |
| Reports          |       | Locations        |
+------------------+       +------------------+
        |                          |
        v                          v
+------------------+       +------------------+
| Merge with       |       | Update Map       |
| Existing         |       | Markers          |
+------------------+       +------------------+
        |
        | (repeat)
        v
+------------------+
| Wait 60s         |
+------------------+
```

### Why 60-Second Auto-Refresh Interval?

| Interval | Pros | Cons |
|----------|------|------|
| 10 seconds | Near real-time, responsive | Battery drain, excessive API calls, decryption overhead |
| 30 seconds | Reasonably fresh, moderate resources | Still battery concern, may miss brief sightings |
| 60 seconds | Balanced freshness, reasonable battery, matches AirTag broadcast | May feel slow, 1-minute delay acceptable? |
| 5 minutes | Low battery/network use | Frustrating when actively searching |

**Decision: 60 Seconds**

"I'm choosing 60 seconds because it matches AirTag's broadcast cycle. The tracker rotates keys every 15 minutes and broadcasts continuously, but finder devices batch reports. Refreshing faster than 60 seconds rarely yields new data. When actively precision finding, we switch to continuous UWB ranging which is real-time. For map view, 60 seconds balances freshness with battery life."

---

## 5. Data Flow

### Location Update Flow

```
[AirTag]                [Finder iPhone]           [Apple Servers]          [Owner Device]
    |                         |                          |                       |
    |  BLE Advertisement      |                          |                       |
    |------------------------>|                          |                       |
    |                         |                          |                       |
    |                         |  Encrypt(location)       |                       |
    |                         |------------------------->|                       |
    |                         |                          |                       |
    |                         |                          |  Query(hash)          |
    |                         |                          |<----------------------|
    |                         |                          |                       |
    |                         |                          |  Encrypted blobs      |
    |                         |                          |---------------------->|
    |                         |                          |                       |
    |                         |                          |    Local decrypt      |
    |                         |                          |        |              |
    |                         |                          |        v              |
    |                         |                          |    Display on map     |
```

### Anti-Stalking Detection Flow

```
[Unknown Tracker]         [User's iPhone]          [Frontend]
       |                        |                      |
       |  BLE detected          |                      |
       |----------------------->|                      |
       |                        |                      |
       |  (tracks sightings)    |                      |
       |----------------------->|                      |
       |                        |                      |
       |  3+ sightings          |                      |
       |  >500m distance        |                      |
       |  >1 hour duration      |                      |
       |----------------------->|                      |
       |                        |                      |
       |                        |  Push notification   |
       |                        |--------------------->|
       |                        |                      |
       |                        |                      |  Show alert UI
       |                        |                      |  (progressive)
       |                        |                      |
       |                        |  User: Play Sound    |
       |                        |<---------------------|
       |                        |                      |
       |  *BEEP*                |                      |
       |<-----------------------|                      |
```

---

## 6. Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Map library | Leaflet | Native MapKit | Cross-platform, single codebase |
| Decryption | WebCrypto client-side | Server-side | Privacy preservation is core |
| State management | Zustand | Redux | Simpler for moderate complexity |
| Precision finding | UWB primary | Bluetooth only | Directional guidance matters |
| Anti-stalking UI | Progressive disclosure | Full info upfront | Reduce false alarm panic |
| Offline support | Service Worker | None | Critical for lost device scenarios |
| Refresh interval | 60 seconds | 10 seconds | Matches broadcast cycle, battery |
| Haptic feedback | Distance-based patterns | None | Multi-sensory guidance |

---

## 7. Future Enhancements

1. **AR Precision Finding**: Camera overlay with augmented reality arrow
2. **Home Screen Widgets**: Quick device status without opening app
3. **Family Sharing UI**: View shared devices with permission controls
4. **History Playback**: Timeline scrubber to replay device movement
5. **Accessibility Audit**: Full WCAG 2.1 AA compliance
6. **Dark Mode**: System-aware theme with map style switching
7. **Voice Control**: "Hey Siri, find my keys" integration
8. **Predictive Locations**: ML-based "likely at home/work" suggestions

---

## 8. Summary

The Find My frontend for AirTag balances three core concerns:

1. **Privacy**: Client-side decryption ensures Apple never sees locations
2. **Usability**: Progressive disclosure and multi-sensory feedback guide users
3. **Reliability**: Offline support works when you need it most

Key architectural decisions:
- Leaflet for cross-platform map consistency
- WebCrypto for hardware-backed client decryption
- Zustand for pragmatic state management
- Service Worker for offline-first experience
- UWB with Bluetooth fallback for precision finding

The anti-stalking UI demonstrates thoughtful design - alerting users to potential threats without causing panic over false positives. Progressive disclosure lets users access information at their own pace while keeping the initial experience calm.
