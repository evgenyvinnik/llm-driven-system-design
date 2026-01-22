# FaceTime - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## Opening Statement (1 minute)

"I'll design FaceTime's frontend, focusing on the real-time video calling experience with WebRTC integration. The key UI challenges are managing call states (ringing, connecting, active, ended), rendering local and remote video streams with proper aspect ratios, and building responsive call controls that work across Apple devices. The frontend must handle WebRTC peer connection lifecycle, ICE candidate exchange, and provide visual feedback for connection quality."

---

## Requirements Clarification (3 minutes)

### Frontend-Specific Requirements
- **Call UI**: Incoming call overlay, active call view, call ended screen
- **Video Rendering**: Local preview, remote video(s), picture-in-picture
- **Controls**: Mute, video toggle, speaker, end call, effects
- **Multi-Device**: Ring on all devices, transfer between devices
- **Group Calls**: Grid/spotlight layouts, dominant speaker highlight
- **Accessibility**: VoiceOver support, reduce motion, high contrast

### Component Breakdown
- Login/contact list for initiating calls
- Incoming call overlay with caller info
- Active call view with video elements
- Call controls bar
- Connection status indicator
- Group call participant grid

### Scale Considerations
- Handle up to 32 participants in group calls
- Smooth transitions between call states
- Real-time video rendering at 30fps
- Responsive to network quality changes

---

## High-Level Frontend Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           React Application                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────┐   ┌───────────────┐   ┌─────────────────────────────┐   │
│  │    Router     │   │    Zustand    │   │      WebRTC Context         │   │
│  │   (TanStack)  │   │    Stores     │   │   (Peer Connections)        │   │
│  └───────────────┘   └───────────────┘   └─────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                              Views                                    │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │  │
│  │  │   Login    │  │  Contacts  │  │   Active   │  │     Group      │  │  │
│  │  │   Screen   │  │    List    │  │    Call    │  │   Call Grid    │  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                           Components                                  │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │  │
│  │  │  Incoming  │  │   Video    │  │    Call    │  │   Connection   │  │  │
│  │  │   Overlay  │  │   Player   │  │  Controls  │  │     Status     │  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                             Hooks                                     │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │  │
│  │  │ useWebRTC  │  │  useMedia  │  │ useSignal  │  │  useNetwork    │  │  │
│  │  │            │  │   Stream   │  │    ing     │  │    Stats       │  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                         WebSocket Connection                                 │
│                        (Signaling Protocol)                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: WebRTC Hook (8 minutes)

### Peer Connection Management

The core of the frontend is managing WebRTC peer connections. The `useWebRTC` hook encapsulates:

**Hook Interface:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          useWebRTC Hook                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Inputs:                          Outputs:                                  │
│  ┌──────────────────────┐        ┌──────────────────────────────────────┐  │
│  │ callId               │        │ peerConnection: RTCPeerConnection    │  │
│  │ isInitiator          │        │ localStream: MediaStream             │  │
│  │ onRemoteStream()     │ ──▶    │ createOffer()                        │  │
│  │ onConnectionChange() │        │ handleAnswer()                       │  │
│  │ onIceCandidate()     │        │ createAnswer()                       │  │
│  └──────────────────────┘        │ addIceCandidate()                    │  │
│                                   │ toggleMute() / toggleVideo()         │  │
│                                   │ hangup()                             │  │
│                                   └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Initialization Flow:**
```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ Fetch ICE    │───▶│ Create Peer  │───▶│ Get Local    │───▶│ Add Tracks   │
│ Servers      │    │ Connection   │    │ Media Stream │    │ to PC        │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                                                                    │
                                         ┌──────────────────────────┘
                                         ▼
                            ┌────────────────────────┐
                            │ Set Event Handlers:    │
                            │ - ontrack (remote)     │
                            │ - onicecandidate       │
                            │ - onconnectionchange   │
                            └────────────────────────┘
```

**ICE Candidate Queuing:**

"ICE candidates may arrive before remote description is set. I queue pending candidates and process them once the remote description is established. This handles trickle ICE race conditions."

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      ICE Candidate Handling                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Candidate Arrives ──▶ Remote Description Set? ──▶ Add to Peer Connection  │
│         │                        │                                           │
│         │                        │ No                                        │
│         │                        ▼                                           │
│         │               Queue in pendingCandidates[]                         │
│         │                        │                                           │
│         │                        │ On setRemoteDescription()                 │
│         │                        ▼                                           │
│         └────────────── Process All Queued Candidates                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### ICE Server Configuration

The frontend fetches TURN credentials from the backend before establishing connections:

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Frontend   │ ──▶     │   Backend    │ ──▶     │   Coturn     │
│ /api/turn    │         │ credentials  │         │   Server     │
└──────────────┘         └──────────────┘         └──────────────┘
        │
        ▼
┌───────────────────────────────────┐
│ ICE Servers Array:                │
│ - STUN: stun.example.com:3478     │
│ - TURN: urls + username + cred    │
└───────────────────────────────────┘
```

---

## Deep Dive: Call State Management (7 minutes)

### Call Store with Zustand

**State Machine:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Call State Machine                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                              ┌─────────┐                                     │
│                              │  IDLE   │◀────────────────────────────┐      │
│                              └────┬────┘                              │      │
│           initiateCall()          │          receiveIncomingCall()    │      │
│                    ┌──────────────┴──────────────┐                    │      │
│                    ▼                              ▼                    │      │
│             ┌───────────┐                  ┌───────────┐              │      │
│             │ OUTGOING  │                  │  RINGING  │              │      │
│             └─────┬─────┘                  └─────┬─────┘              │      │
│                   │ answered                     │ answerCall()       │      │
│                   │                              │                    │      │
│                   └──────────────┬───────────────┘                    │      │
│                                  ▼                                    │      │
│                           ┌────────────┐                              │      │
│                           │ CONNECTING │                              │      │
│                           └──────┬─────┘                              │      │
│                                  │ ICE complete                       │      │
│                                  ▼                                    │      │
│                           ┌────────────┐                              │      │
│                           │ CONNECTED  │                              │      │
│                           └──────┬─────┘                              │      │
│                                  │ endCall()                          │      │
│                                  ▼                                    │      │
│                           ┌────────────┐                              │      │
│                           │   ENDED    │──── 2s timeout ──────────────┘      │
│                           └────────────┘                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Store Structure:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CallStore                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  State                            Actions                                    │
│  ┌──────────────────────────┐    ┌──────────────────────────────────────┐   │
│  │ callState: CallState     │    │ initiateCall(userId, type)           │   │
│  │ currentCallId: string    │    │ receiveIncomingCall(call)            │   │
│  │ callType: 'video'|'audio'│    │ answerCall()                         │   │
│  │ participants: Map        │    │ declineCall()                        │   │
│  │ localStream: MediaStream │    │ setCallConnected()                   │   │
│  │ incomingCall: Object     │    │ endCall()                            │   │
│  │ isMuted: boolean         │    │ setLocalStream(stream)               │   │
│  │ isVideoOff: boolean      │    │ addRemoteStream(id, stream)          │   │
│  │ connectionQuality        │    │ toggleMute() / toggleVideo()         │   │
│  │ callStartTime: number    │    │ updateConnectionQuality(quality)     │   │
│  └──────────────────────────┘    │ setDominantSpeaker(participantId)    │   │
│                                   └──────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Participant Data Model:**
```
┌────────────────────────────────────┐
│        CallParticipant             │
├────────────────────────────────────┤
│ id: string                         │
│ name: string                       │
│ avatarUrl: string                  │
│ stream: MediaStream | null         │
│ isMuted: boolean                   │
│ isVideoOff: boolean                │
│ isSpeaking: boolean                │
└────────────────────────────────────┘
```

---

## Deep Dive: Video Components (5 minutes)

### VideoPlayer Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         VideoPlayer Component                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Props:                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ stream: MediaStream | null    muted: boolean    isLocal: boolean    │    │
│  │ objectFit: 'cover'|'contain'  showPlaceholder: boolean              │    │
│  │ participantName: string       isSpeaking: boolean                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────────┐   │    │
│  │   │                   Video Element                              │   │    │
│  │   │  - srcObject bound to stream                                 │   │    │
│  │   │  - Mirror transform for local video (scale-x-[-1])          │   │    │
│  │   │  - autoPlay + playsInline for mobile                        │   │    │
│  │   └─────────────────────────────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  │   ┌─────────────────────────────────────────────────────────────┐   │    │
│  │   │              Placeholder (when video off)                    │   │    │
│  │   │  - Avatar initial in circle                                  │   │    │
│  │   │  - Participant name below                                    │   │    │
│  │   └─────────────────────────────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  │   ┌──────────────────┐   ┌──────────────────────────────────────┐   │    │
│  │   │ Name Overlay     │   │ Speaking Indicator (animated bars)   │   │    │
│  │   │ (bottom-left)    │   │ (top-right, green, 3 bars pulsing)   │   │    │
│  │   └──────────────────┘   └──────────────────────────────────────┘   │    │
│  │                                                                      │    │
│  │   Speaking border: 0 0 0 3px #22c55e                                │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Active Call View Layout

**1:1 Call Layout:**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Connection Status Bar          [Signal Bars]              [00:05]           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                                                                              │
│                        Remote Video (Full Screen)                            │
│                                                                              │
│                                                                              │
│                                                        ┌──────────────────┐ │
│                                                        │   Local Video    │ │
│                                                        │   (PiP 32x48)    │ │
│                                                        └──────────────────┘ │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                           Call Controls Bar                                  │
│    [Mute]     [Video]     [Flip]     [Effects]     [End Call - Red]         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Connection Quality Indicator:**
```
┌────────────────────────────────────────┐
│  Quality Level    Bars    Color        │
├────────────────────────────────────────┤
│  excellent        4/4     green        │
│  good             3/4     green        │
│  poor             2/4     yellow       │
│  disconnected     1/4     red          │
└────────────────────────────────────────┘
```

---

## Deep Dive: Incoming Call Overlay (5 minutes)

### Incoming Call UI

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Fixed Full-Screen Overlay (z-50)                          │
│                    bg-black/80 + backdrop-blur                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                                                                              │
│                         ┌────────────────────┐                               │
│                         │  ╭──────────────╮  │ ◀── Ping animation           │
│                         │  │              │  │     (green/30 opacity)        │
│                         │  │   Avatar     │  │                               │
│                         │  │   132x132    │  │ ◀── Pulse animation          │
│                         │  │              │  │     (green/20, delayed 0.5s)  │
│                         │  ╰──────────────╯  │                               │
│                         └────────────────────┘                               │
│                                                                              │
│                           Caller Name (24px, bold)                           │
│                         Incoming video call... (gray)                        │
│                                                                              │
│                                                                              │
│             ┌──────────────┐              ┌──────────────┐                   │
│             │   DECLINE    │              │    ACCEPT    │                   │
│             │  (Red 64px)  │              │ (Green 64px) │                   │
│             │    [X]       │              │   [Phone]    │ ◀── Pulse        │
│             │   Decline    │              │    Accept    │                   │
│             └──────────────┘              └──────────────┘                   │
│                                                                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Call Controls Component

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Call Controls Bar                                      │
│                    bg-black/50, py-6, centered                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐│
│  │            │ │            │ │            │ │            │ │            ││
│  │   [Mic]    │ │  [Camera]  │ │   [Flip]   │ │ [Effects]  │ │  [End X]   ││
│  │            │ │            │ │            │ │            │ │            ││
│  │   Mute     │ │ Stop Video │ │    Flip    │ │  Effects   │ │  bg-red    ││
│  │  12x12 bg  │ │  12x12 bg  │ │  12x12 bg  │ │  12x12 bg  │ │  16x16 btn ││
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘│
│                                                                              │
│  ControlButton:                                                              │
│  - 48px circle (w-12 h-12)                                                   │
│  - bg-gray-700 when active, bg-gray-800 when inactive                        │
│  - Icon 24px centered                                                        │
│  - Label below (text-xs)                                                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Group Call Grid (5 minutes)

### Responsive Grid Layout

**Grid Configuration by Participant Count:**
```
┌────────────────────────────────────────────────────────────────┐
│  Participants    Grid Class              Layout               │
├────────────────────────────────────────────────────────────────┤
│      1           grid-cols-1             1x1                  │
│      2           grid-cols-2             2x1                  │
│     3-4          grid-cols-2 rows-2      2x2                  │
│     5-6          grid-cols-3 rows-2      3x2                  │
│     7-9          grid-cols-3 rows-3      3x3                  │
│    10-12         grid-cols-4 rows-3      4x3 (max visible)    │
└────────────────────────────────────────────────────────────────┘
```

**Spotlight Mode (when > 4 participants and dominant speaker exists):**
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │                      Dominant Speaker Video                            │  │
│  │                        (flex-1, full width)                            │  │
│  │                                                                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ Thumb 1  │ │ Thumb 2  │ │ Thumb 3  │ │ Thumb 4  │ │   ...    │ ◀── h-24 │
│  │  w-32    │ │  w-32    │ │  w-32    │ │  w-32    │ │ overflow │    strip │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                       Filmstrip (flex, gap-2, overflow-x-auto)              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Signaling Integration (5 minutes)

### WebSocket Signaling Protocol

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Signaling Message Flow                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Caller                    Server                    Callee                  │
│    │                         │                         │                     │
│    │── initiate_call ───────▶│                         │                     │
│    │                         │──────── ring ──────────▶│                     │
│    │                         │                         │                     │
│    │                         │◀─────── accept ─────────│                     │
│    │◀── call_answered ───────│                         │                     │
│    │                         │                         │                     │
│    │── offer ───────────────▶│──────── offer ─────────▶│                     │
│    │                         │                         │                     │
│    │◀──────── answer ────────│◀─────── answer ─────────│                     │
│    │                         │                         │                     │
│    │── ice_candidate ───────▶│◀── ice_candidate ──────▶│                     │
│    │◀── ice_candidate ───────│─── ice_candidate ──────▶│                     │
│    │                         │                         │                     │
│    │                    (Media flows peer-to-peer)                           │
│    │                         │                         │                     │
│    │── call_ended ──────────▶│────── call_ended ──────▶│                     │
│    │                         │                         │                     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Message Types:**

| Message Type     | Direction       | Payload                           |
|------------------|-----------------|-----------------------------------|
| ring             | Server → Client | callId, caller info, callType     |
| offer            | Peer → Peer     | RTCSessionDescriptionInit         |
| answer           | Peer → Peer     | RTCSessionDescriptionInit         |
| ice_candidate    | Peer → Peer     | RTCIceCandidateInit               |
| call_answered    | Server → Client | (other device answered)           |
| call_ended       | Server → Client | (remote party ended call)         |

---

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| State Management | Zustand | Redux | Simpler API, less boilerplate for real-time state |
| Video Rendering | Native `<video>` | Canvas | Better performance, hardware acceleration |
| Grid Layout | CSS Grid | Flexbox | Cleaner responsive layouts for variable participant counts |
| Local Preview | Mirrored | Normal | User expects mirror behavior like real mirror |
| Connection State | Single Store | Separate Contexts | Easier to coordinate call state across components |
| ICE Handling | Queue pending | Wait for setup | Avoids race conditions with trickle ICE |

### Accessibility Considerations

1. **Screen Reader**: Announce call state changes, participant joins/leaves
2. **Keyboard Navigation**: Full control access via keyboard shortcuts
3. **Reduce Motion**: Disable pulse animations for incoming calls
4. **High Contrast**: Ensure control buttons are visible

### Performance Optimizations

1. **Video Element Reuse**: Avoid recreating video elements on stream changes
2. **Lazy Track Initialization**: Only start local video after user action
3. **Memoized Callbacks**: Prevent unnecessary re-renders in call controls
4. **Hardware Acceleration**: Use `will-change` on video containers

---

## Closing Summary (1 minute)

"The FaceTime frontend is built around three key patterns:

1. **WebRTC Hook Architecture** - The `useWebRTC` hook encapsulates peer connection lifecycle, handling offer/answer exchange, ICE candidate queuing, and media track management. This abstraction makes call logic testable and reusable.

2. **Call State Machine** - Zustand manages the call state (idle, ringing, connecting, connected, ended) with clear transitions. The store coordinates between signaling events and UI updates.

3. **Composable Video Components** - The VideoPlayer component handles stream rendering, placeholders when video is off, speaking indicators, and mirror transforms. The GroupCallGrid adapts between grid and spotlight layouts based on participant count.

The main trade-off is between simplicity and flexibility. Using native video elements with CSS Grid provides excellent performance and browser support, though a canvas-based approach would offer more control for effects like background blur."
