# FaceTime - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

## Opening Statement (1 minute)

"I'll design FaceTime's frontend, focusing on the real-time video calling experience with WebRTC integration. The key UI challenges are managing call states (ringing, connecting, active, ended), rendering local and remote video streams with proper aspect ratios, and building responsive call controls that work across Apple devices. The frontend must handle WebRTC peer connection lifecycle, ICE candidate exchange, and provide visual feedback for connection quality."

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

## High-Level Frontend Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Application                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Router    │  │   Zustand   │  │    WebRTC Context       │  │
│  │  (TanStack) │  │   Stores    │  │  (Peer Connections)     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     Views                                   │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │ │
│  │  │  Login   │  │ Contacts │  │  Active  │  │   Group    │  │ │
│  │  │  Screen  │  │   List   │  │   Call   │  │  Call Grid │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     Components                              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │ │
│  │  │ Incoming │  │  Video   │  │   Call   │  │ Connection │  │ │
│  │  │  Overlay │  │  Player  │  │ Controls │  │   Status   │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     Hooks                                   │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │ │
│  │  │useWebRTC │  │ useMedia │  │useSignal │  │ useNetwork │  │ │
│  │  │          │  │ Stream   │  │   ing    │  │   Stats    │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                     WebSocket Connection                         │
│                   (Signaling Protocol)                          │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: WebRTC Hook (8 minutes)

### Peer Connection Management

The core of the frontend is managing WebRTC peer connections:

```typescript
// hooks/useWebRTC.ts
interface UseWebRTCOptions {
  callId: string
  isInitiator: boolean
  onRemoteStream: (stream: MediaStream, participantId: string) => void
  onConnectionStateChange: (state: RTCPeerConnectionState) => void
  onIceCandidate: (candidate: RTCIceCandidate) => void
}

interface UseWebRTCReturn {
  peerConnection: RTCPeerConnection | null
  localStream: MediaStream | null
  createOffer: () => Promise<RTCSessionDescriptionInit>
  handleAnswer: (answer: RTCSessionDescriptionInit) => Promise<void>
  createAnswer: (offer: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>
  addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>
  toggleMute: () => void
  toggleVideo: () => void
  hangup: () => void
}

function useWebRTC(options: UseWebRTCOptions): UseWebRTCReturn {
  const { callId, isInitiator, onRemoteStream, onConnectionStateChange, onIceCandidate } = options

  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([])

  // Initialize peer connection and local media
  useEffect(() => {
    const init = async () => {
      // Get ICE server configuration from backend
      const iceServers = await fetchIceServers()

      const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 10
      })

      // Get local media stream
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, frameRate: 30 },
        audio: { echoCancellation: true, noiseSuppression: true }
      })

      // Add tracks to peer connection
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream)
      })

      // Handle remote tracks
      pc.ontrack = (event) => {
        if (event.streams[0]) {
          onRemoteStream(event.streams[0], 'remote')
        }
      }

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          onIceCandidate(event.candidate)
        }
      }

      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        onConnectionStateChange(pc.connectionState)
      }

      setLocalStream(stream)
      setPeerConnection(pc)
    }

    init()

    return () => {
      localStream?.getTracks().forEach(track => track.stop())
      peerConnection?.close()
    }
  }, [callId])

  const createOffer = async (): Promise<RTCSessionDescriptionInit> => {
    if (!peerConnection) throw new Error('Peer connection not initialized')

    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    })

    await peerConnection.setLocalDescription(offer)
    return offer
  }

  const handleAnswer = async (answer: RTCSessionDescriptionInit) => {
    if (!peerConnection) return

    await peerConnection.setRemoteDescription(answer)

    // Process any pending ICE candidates
    for (const candidate of pendingCandidates.current) {
      await peerConnection.addIceCandidate(candidate)
    }
    pendingCandidates.current = []
  }

  const createAnswer = async (offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> => {
    if (!peerConnection) throw new Error('Peer connection not initialized')

    await peerConnection.setRemoteDescription(offer)

    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)

    return answer
  }

  const addIceCandidate = async (candidate: RTCIceCandidateInit) => {
    if (!peerConnection) return

    // Queue if remote description not set yet
    if (!peerConnection.remoteDescription) {
      pendingCandidates.current.push(candidate)
      return
    }

    await peerConnection.addIceCandidate(candidate)
  }

  const toggleMute = () => {
    if (!localStream) return
    const audioTrack = localStream.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled
    }
  }

  const toggleVideo = () => {
    if (!localStream) return
    const videoTrack = localStream.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled
    }
  }

  const hangup = () => {
    localStream?.getTracks().forEach(track => track.stop())
    peerConnection?.close()
  }

  return {
    peerConnection,
    localStream,
    createOffer,
    handleAnswer,
    createAnswer,
    addIceCandidate,
    toggleMute,
    toggleVideo,
    hangup
  }
}
```

### ICE Server Configuration Fetching

```typescript
// services/iceServers.ts
async function fetchIceServers(): Promise<RTCIceServer[]> {
  const response = await fetch('/api/turn-credentials', {
    credentials: 'include'
  })

  const data = await response.json()

  return [
    { urls: 'stun:stun.example.com:3478' },
    {
      urls: data.urls,
      username: data.username,
      credential: data.credential
    }
  ]
}
```

## Deep Dive: Call State Management (7 minutes)

### Call Store with Zustand

```typescript
// stores/callStore.ts
type CallState = 'idle' | 'outgoing' | 'ringing' | 'connecting' | 'connected' | 'ended'

interface CallParticipant {
  id: string
  name: string
  avatarUrl: string
  stream: MediaStream | null
  isMuted: boolean
  isVideoOff: boolean
  isSpeaking: boolean
}

interface IncomingCall {
  callId: string
  caller: {
    id: string
    name: string
    avatarUrl: string
  }
  callType: 'video' | 'audio'
}

interface CallStore {
  // State
  callState: CallState
  currentCallId: string | null
  callType: 'video' | 'audio' | null
  participants: Map<string, CallParticipant>
  localStream: MediaStream | null
  incomingCall: IncomingCall | null
  isMuted: boolean
  isVideoOff: boolean
  connectionQuality: 'excellent' | 'good' | 'poor' | 'disconnected'
  callStartTime: number | null

  // Actions
  initiateCall: (userId: string, callType: 'video' | 'audio') => void
  receiveIncomingCall: (call: IncomingCall) => void
  answerCall: () => void
  declineCall: () => void
  setCallConnected: () => void
  endCall: () => void
  setLocalStream: (stream: MediaStream) => void
  addRemoteStream: (participantId: string, stream: MediaStream) => void
  toggleMute: () => void
  toggleVideo: () => void
  updateConnectionQuality: (quality: CallStore['connectionQuality']) => void
  setDominantSpeaker: (participantId: string) => void
}

export const useCallStore = create<CallStore>((set, get) => ({
  callState: 'idle',
  currentCallId: null,
  callType: null,
  participants: new Map(),
  localStream: null,
  incomingCall: null,
  isMuted: false,
  isVideoOff: false,
  connectionQuality: 'excellent',
  callStartTime: null,

  initiateCall: (userId, callType) => {
    set({
      callState: 'outgoing',
      callType,
      currentCallId: crypto.randomUUID()
    })
  },

  receiveIncomingCall: (call) => {
    // Don't interrupt an active call
    if (get().callState !== 'idle') return

    set({
      incomingCall: call,
      callState: 'ringing'
    })
  },

  answerCall: () => {
    const { incomingCall } = get()
    if (!incomingCall) return

    set({
      callState: 'connecting',
      currentCallId: incomingCall.callId,
      callType: incomingCall.callType,
      incomingCall: null
    })
  },

  declineCall: () => {
    set({
      incomingCall: null,
      callState: 'idle'
    })
  },

  setCallConnected: () => {
    set({
      callState: 'connected',
      callStartTime: Date.now()
    })
  },

  endCall: () => {
    const { localStream } = get()
    localStream?.getTracks().forEach(track => track.stop())

    set({
      callState: 'ended',
      localStream: null,
      participants: new Map(),
      isMuted: false,
      isVideoOff: false
    })

    // Reset to idle after showing end screen
    setTimeout(() => {
      set({ callState: 'idle', currentCallId: null, callStartTime: null })
    }, 2000)
  },

  setLocalStream: (stream) => set({ localStream: stream }),

  addRemoteStream: (participantId, stream) => {
    set((state) => {
      const participants = new Map(state.participants)
      const existing = participants.get(participantId)

      participants.set(participantId, {
        id: participantId,
        name: existing?.name || 'Unknown',
        avatarUrl: existing?.avatarUrl || '',
        stream,
        isMuted: false,
        isVideoOff: false,
        isSpeaking: false
      })

      return { participants }
    })
  },

  toggleMute: () => {
    const { localStream, isMuted } = get()
    const audioTrack = localStream?.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = isMuted  // Toggle
      set({ isMuted: !isMuted })
    }
  },

  toggleVideo: () => {
    const { localStream, isVideoOff } = get()
    const videoTrack = localStream?.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = isVideoOff  // Toggle
      set({ isVideoOff: !isVideoOff })
    }
  },

  updateConnectionQuality: (quality) => set({ connectionQuality: quality }),

  setDominantSpeaker: (participantId) => {
    set((state) => {
      const participants = new Map(state.participants)

      for (const [id, participant] of participants) {
        participants.set(id, {
          ...participant,
          isSpeaking: id === participantId
        })
      }

      return { participants }
    })
  }
}))
```

## Deep Dive: Video Components (5 minutes)

### Video Player Component

```typescript
// components/VideoPlayer.tsx
interface VideoPlayerProps {
  stream: MediaStream | null
  muted?: boolean
  isLocal?: boolean
  objectFit?: 'cover' | 'contain'
  showPlaceholder?: boolean
  participantName?: string
  isSpeaking?: boolean
  className?: string
}

function VideoPlayer({
  stream,
  muted = false,
  isLocal = false,
  objectFit = 'cover',
  showPlaceholder = true,
  participantName,
  isSpeaking = false,
  className = ''
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [hasVideo, setHasVideo] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !stream) return

    video.srcObject = stream

    // Check if stream has enabled video track
    const videoTrack = stream.getVideoTracks()[0]
    setHasVideo(videoTrack?.enabled ?? false)

    // Listen for track enable/disable
    const handleTrackChange = () => {
      setHasVideo(videoTrack?.enabled ?? false)
    }

    videoTrack?.addEventListener('ended', handleTrackChange)

    return () => {
      videoTrack?.removeEventListener('ended', handleTrackChange)
    }
  }, [stream])

  return (
    <div
      className={`relative overflow-hidden bg-gray-900 ${className}`}
      style={{
        boxShadow: isSpeaking ? '0 0 0 3px #22c55e' : 'none'
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`w-full h-full ${isLocal ? 'transform scale-x-[-1]' : ''}`}
        style={{
          objectFit,
          display: hasVideo ? 'block' : 'none'
        }}
      />

      {/* Placeholder when video is off */}
      {showPlaceholder && !hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
          <div className="flex flex-col items-center">
            <div className="w-20 h-20 rounded-full bg-gray-600 flex items-center justify-center text-3xl text-white">
              {participantName?.[0]?.toUpperCase() || '?'}
            </div>
            {participantName && (
              <span className="mt-2 text-white text-sm">{participantName}</span>
            )}
          </div>
        </div>
      )}

      {/* Participant name overlay */}
      {participantName && hasVideo && (
        <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/50 rounded text-white text-sm">
          {participantName}
        </div>
      )}

      {/* Speaking indicator */}
      {isSpeaking && (
        <div className="absolute top-2 right-2">
          <SpeakingIndicator />
        </div>
      )}
    </div>
  )
}

function SpeakingIndicator() {
  return (
    <div className="flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-1 bg-green-500 rounded-full animate-pulse"
          style={{
            height: `${8 + i * 4}px`,
            animationDelay: `${i * 100}ms`
          }}
        />
      ))}
    </div>
  )
}
```

### Active Call View

```typescript
// components/ActiveCallView.tsx
function ActiveCallView() {
  const {
    callState,
    localStream,
    participants,
    isMuted,
    isVideoOff,
    connectionQuality,
    callStartTime,
    toggleMute,
    toggleVideo,
    endCall
  } = useCallStore()

  const [callDuration, setCallDuration] = useState('00:00')

  // Update call duration every second
  useEffect(() => {
    if (!callStartTime) return

    const interval = setInterval(() => {
      const seconds = Math.floor((Date.now() - callStartTime) / 1000)
      const mins = Math.floor(seconds / 60).toString().padStart(2, '0')
      const secs = (seconds % 60).toString().padStart(2, '0')
      setCallDuration(`${mins}:${secs}`)
    }, 1000)

    return () => clearInterval(interval)
  }, [callStartTime])

  const participantList = Array.from(participants.values())
  const isGroupCall = participantList.length > 1

  return (
    <div className="fixed inset-0 bg-gray-900 flex flex-col">
      {/* Connection status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-black/30">
        <ConnectionQualityIndicator quality={connectionQuality} />
        <span className="text-white font-mono">{callDuration}</span>
      </div>

      {/* Video area */}
      <div className="flex-1 relative">
        {isGroupCall ? (
          <GroupCallGrid participants={participantList} />
        ) : (
          // 1:1 call layout
          <>
            {/* Remote video (full screen) */}
            {participantList[0] && (
              <VideoPlayer
                stream={participantList[0].stream}
                participantName={participantList[0].name}
                isSpeaking={participantList[0].isSpeaking}
                className="w-full h-full"
              />
            )}

            {/* Local video (picture-in-picture) */}
            <div className="absolute bottom-24 right-4 w-32 h-48 rounded-lg overflow-hidden shadow-lg">
              <VideoPlayer
                stream={localStream}
                muted
                isLocal
                className="w-full h-full"
              />
            </div>
          </>
        )}
      </div>

      {/* Call controls */}
      <CallControls
        isMuted={isMuted}
        isVideoOff={isVideoOff}
        onToggleMute={toggleMute}
        onToggleVideo={toggleVideo}
        onEndCall={endCall}
      />
    </div>
  )
}

function ConnectionQualityIndicator({ quality }: { quality: string }) {
  const config = {
    excellent: { bars: 4, color: 'bg-green-500' },
    good: { bars: 3, color: 'bg-green-500' },
    poor: { bars: 2, color: 'bg-yellow-500' },
    disconnected: { bars: 1, color: 'bg-red-500' }
  }[quality] || { bars: 0, color: 'bg-gray-500' }

  return (
    <div className="flex items-end gap-0.5 h-4">
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className={`w-1 rounded-sm ${i <= config.bars ? config.color : 'bg-gray-600'}`}
          style={{ height: `${i * 4}px` }}
        />
      ))}
    </div>
  )
}
```

## Deep Dive: Incoming Call Overlay (5 minutes)

### Incoming Call UI

```typescript
// components/IncomingCallOverlay.tsx
function IncomingCallOverlay() {
  const { incomingCall, answerCall, declineCall } = useCallStore()

  if (!incomingCall) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="flex flex-col items-center">
        {/* Caller avatar with ring animation */}
        <div className="relative">
          <div className="absolute inset-0 animate-ping rounded-full bg-green-500/30" />
          <div className="absolute inset-0 animate-pulse rounded-full bg-green-500/20" style={{ animationDelay: '0.5s' }} />
          <img
            src={incomingCall.caller.avatarUrl}
            alt={incomingCall.caller.name}
            className="relative w-32 h-32 rounded-full border-4 border-white/20"
          />
        </div>

        {/* Caller info */}
        <h2 className="mt-6 text-2xl font-semibold text-white">
          {incomingCall.caller.name}
        </h2>
        <p className="mt-1 text-gray-300">
          Incoming {incomingCall.callType} call...
        </p>

        {/* Action buttons */}
        <div className="mt-10 flex items-center gap-12">
          <button
            onClick={declineCall}
            className="flex flex-col items-center"
          >
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg hover:bg-red-600 transition-colors">
              <PhoneXIcon className="w-8 h-8 text-white" />
            </div>
            <span className="mt-2 text-sm text-gray-300">Decline</span>
          </button>

          <button
            onClick={answerCall}
            className="flex flex-col items-center"
          >
            <div className="w-16 h-16 rounded-full bg-green-500 flex items-center justify-center shadow-lg hover:bg-green-600 transition-colors animate-pulse">
              <PhoneIcon className="w-8 h-8 text-white" />
            </div>
            <span className="mt-2 text-sm text-gray-300">Accept</span>
          </button>
        </div>
      </div>
    </div>
  )
}
```

### Call Controls Component

```typescript
// components/CallControls.tsx
interface CallControlsProps {
  isMuted: boolean
  isVideoOff: boolean
  onToggleMute: () => void
  onToggleVideo: () => void
  onEndCall: () => void
}

function CallControls({
  isMuted,
  isVideoOff,
  onToggleMute,
  onToggleVideo,
  onEndCall
}: CallControlsProps) {
  return (
    <div className="flex items-center justify-center gap-6 py-6 bg-black/50">
      {/* Mute button */}
      <ControlButton
        icon={isMuted ? MicOffIcon : MicIcon}
        label={isMuted ? 'Unmute' : 'Mute'}
        isActive={!isMuted}
        onClick={onToggleMute}
      />

      {/* Video toggle */}
      <ControlButton
        icon={isVideoOff ? VideoCameraOffIcon : VideoCameraIcon}
        label={isVideoOff ? 'Start Video' : 'Stop Video'}
        isActive={!isVideoOff}
        onClick={onToggleVideo}
      />

      {/* Flip camera (mobile) */}
      <ControlButton
        icon={ArrowPathIcon}
        label="Flip"
        onClick={() => {/* TODO: flip camera */}}
      />

      {/* Effects */}
      <ControlButton
        icon={SparklesIcon}
        label="Effects"
        onClick={() => {/* TODO: open effects */}}
      />

      {/* End call */}
      <button
        onClick={onEndCall}
        className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg hover:bg-red-600 transition-colors"
        aria-label="End call"
      >
        <PhoneXIcon className="w-8 h-8 text-white" />
      </button>
    </div>
  )
}

interface ControlButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  isActive?: boolean
  onClick: () => void
}

function ControlButton({ icon: Icon, label, isActive = true, onClick }: ControlButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center ${isActive ? 'text-white' : 'text-gray-400'}`}
      aria-label={label}
    >
      <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
        isActive ? 'bg-gray-700' : 'bg-gray-800'
      }`}>
        <Icon className="w-6 h-6" />
      </div>
      <span className="mt-1 text-xs">{label}</span>
    </button>
  )
}
```

## Deep Dive: Group Call Grid (5 minutes)

### Responsive Grid Layout

```typescript
// components/GroupCallGrid.tsx
interface GroupCallGridProps {
  participants: CallParticipant[]
}

function GroupCallGrid({ participants }: GroupCallGridProps) {
  const dominantSpeaker = participants.find(p => p.isSpeaking)

  // Determine grid layout based on participant count
  const getGridClass = (count: number) => {
    if (count <= 1) return 'grid-cols-1'
    if (count === 2) return 'grid-cols-2'
    if (count <= 4) return 'grid-cols-2 grid-rows-2'
    if (count <= 6) return 'grid-cols-3 grid-rows-2'
    if (count <= 9) return 'grid-cols-3 grid-rows-3'
    return 'grid-cols-4 grid-rows-3'  // Max 12 visible, rest in overflow
  }

  // Spotlight mode: dominant speaker is large, others are small
  const isSpotlightMode = participants.length > 4 && dominantSpeaker

  if (isSpotlightMode) {
    return (
      <div className="flex flex-col h-full">
        {/* Spotlight view */}
        <div className="flex-1 p-2">
          <VideoPlayer
            stream={dominantSpeaker.stream}
            participantName={dominantSpeaker.name}
            isSpeaking
            className="w-full h-full rounded-lg"
          />
        </div>

        {/* Filmstrip of other participants */}
        <div className="h-24 flex gap-2 px-2 pb-2 overflow-x-auto">
          {participants
            .filter(p => p.id !== dominantSpeaker.id)
            .map((participant) => (
              <VideoPlayer
                key={participant.id}
                stream={participant.stream}
                participantName={participant.name}
                isSpeaking={participant.isSpeaking}
                className="w-32 h-full rounded-lg flex-shrink-0"
                objectFit="cover"
              />
            ))}
        </div>
      </div>
    )
  }

  // Grid mode
  return (
    <div className={`h-full grid gap-2 p-2 ${getGridClass(participants.length)}`}>
      {participants.map((participant) => (
        <VideoPlayer
          key={participant.id}
          stream={participant.stream}
          participantName={participant.name}
          isSpeaking={participant.isSpeaking}
          className="w-full h-full rounded-lg"
          objectFit="cover"
        />
      ))}
    </div>
  )
}
```

## Deep Dive: Signaling Integration (5 minutes)

### WebSocket Signaling Hook

```typescript
// hooks/useSignaling.ts
interface SignalingMessage {
  type: string
  callId?: string
  payload?: unknown
}

function useSignaling() {
  const wsRef = useRef<WebSocket | null>(null)
  const {
    receiveIncomingCall,
    setCallConnected,
    endCall
  } = useCallStore()

  // WebRTC hook reference for call handling
  const webRTCRef = useRef<UseWebRTCReturn | null>(null)

  useEffect(() => {
    const ws = new WebSocket(`wss://${window.location.host}/signaling`)
    wsRef.current = ws

    ws.onmessage = async (event) => {
      const message: SignalingMessage = JSON.parse(event.data)

      switch (message.type) {
        case 'ring':
          // Incoming call notification
          receiveIncomingCall({
            callId: message.callId!,
            caller: message.payload as IncomingCall['caller'],
            callType: 'video'
          })
          break

        case 'offer':
          // Received offer from caller
          if (webRTCRef.current) {
            const answer = await webRTCRef.current.createAnswer(
              message.payload as RTCSessionDescriptionInit
            )
            sendMessage({
              type: 'answer',
              callId: message.callId,
              payload: answer
            })
          }
          break

        case 'answer':
          // Received answer from callee
          if (webRTCRef.current) {
            await webRTCRef.current.handleAnswer(
              message.payload as RTCSessionDescriptionInit
            )
          }
          break

        case 'ice_candidate':
          // Received ICE candidate from peer
          if (webRTCRef.current) {
            await webRTCRef.current.addIceCandidate(
              message.payload as RTCIceCandidateInit
            )
          }
          break

        case 'call_answered':
          // Another device answered, stop ringing
          setCallConnected()
          break

        case 'call_ended':
          // Remote party ended the call
          endCall()
          break
      }
    }

    return () => {
      ws.close()
    }
  }, [])

  const sendMessage = (message: SignalingMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    }
  }

  const initiateCall = async (userId: string, callType: 'video' | 'audio') => {
    sendMessage({
      type: 'initiate_call',
      payload: { userId, callType }
    })
  }

  const setWebRTCRef = (ref: UseWebRTCReturn) => {
    webRTCRef.current = ref
  }

  return {
    initiateCall,
    sendMessage,
    setWebRTCRef
  }
}
```

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

## Closing Summary (1 minute)

"The FaceTime frontend is built around three key patterns:

1. **WebRTC Hook Architecture** - The `useWebRTC` hook encapsulates peer connection lifecycle, handling offer/answer exchange, ICE candidate queuing, and media track management. This abstraction makes call logic testable and reusable.

2. **Call State Machine** - Zustand manages the call state (idle, ringing, connecting, connected, ended) with clear transitions. The store coordinates between signaling events and UI updates.

3. **Composable Video Components** - The VideoPlayer component handles stream rendering, placeholders when video is off, speaking indicators, and mirror transforms. The GroupCallGrid adapts between grid and spotlight layouts based on participant count.

The main trade-off is between simplicity and flexibility. Using native video elements with CSS Grid provides excellent performance and browser support, though a canvas-based approach would offer more control for effects like background blur."
