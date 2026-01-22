# Tinder - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **Swipe Interface**: Card-based UI with drag gestures for like/pass
- **Profile Display**: Photos, bio, distance, common interests
- **Match Celebration**: Animated modal when mutual like occurs
- **Chat Interface**: Real-time messaging with matched users
- **Profile Management**: Edit photos, bio, preferences
- **Discovery Settings**: Configure age, distance, gender preferences

### Non-Functional Requirements
- **Smooth Animations**: 60fps swipe gestures and transitions
- **Responsive Design**: Mobile-first with tablet support
- **Accessibility**: Screen reader support, keyboard navigation
- **Performance**: Fast photo loading, minimal layout shifts
- **Offline Resilience**: Queue actions when disconnected

### User Experience Goals
- Addictive, gamified interaction pattern
- Instant feedback on every action
- Clear visual hierarchy prioritizing photos
- Minimal friction to start swiping

---

## 2. Component Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                         App Shell                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Navigation Bar                        │   │
│  │  [Logo]  [Discover]  [Matches]  [Messages]  [Profile]   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│         ┌────────────────────┼────────────────────┐             │
│         ▼                    ▼                    ▼             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐     │
│  │  Discovery  │    │   Matches   │    │    Messages     │     │
│  │    View     │    │    Grid     │    │      List       │     │
│  │             │    │             │    │                 │     │
│  │ ┌─────────┐ │    │ ┌─────────┐ │    │ ┌─────────────┐ │     │
│  │ │  Swipe  │ │    │ │  Match  │ │    │ │Conversation │ │     │
│  │ │  Deck   │ │    │ │  Card   │ │    │ │   Thread    │ │     │
│  │ └─────────┘ │    │ └─────────┘ │    │ └─────────────┘ │     │
│  │             │    │             │    │                 │     │
│  │ ┌─────────┐ │    │             │    │ ┌─────────────┐ │     │
│  │ │ Action  │ │    │             │    │ │   Message   │ │     │
│  │ │ Buttons │ │    │             │    │ │   Input     │ │     │
│  │ └─────────┘ │    │             │    │ └─────────────┘ │     │
│  └─────────────┘    └─────────────┘    └─────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### Component Hierarchy

```
src/
├── components/
│   ├── discovery/
│   │   ├── SwipeDeck.tsx           # Card stack container
│   │   ├── SwipeCard.tsx           # Individual profile card
│   │   ├── CardPhotoGallery.tsx    # Photo carousel
│   │   ├── ProfileDetails.tsx      # Expanded info section
│   │   └── ActionButtons.tsx       # Like/Pass/SuperLike
│   ├── matches/
│   │   ├── MatchGrid.tsx           # Grid of matches
│   │   ├── MatchCard.tsx           # Individual match
│   │   └── MatchModal.tsx          # Celebration animation
│   ├── messages/
│   │   ├── ConversationList.tsx    # List of chats
│   │   ├── ConversationThread.tsx  # Chat messages
│   │   ├── MessageBubble.tsx       # Individual message
│   │   └── MessageInput.tsx        # Compose message
│   ├── profile/
│   │   ├── ProfileEditor.tsx       # Edit profile
│   │   ├── PhotoUploader.tsx       # Manage photos
│   │   └── PreferencesForm.tsx     # Discovery settings
│   ├── shared/
│   │   ├── Avatar.tsx              # User avatar
│   │   ├── ProceduralAvatar.tsx    # ReignsAvatar fallback
│   │   └── DistanceBadge.tsx       # Distance display
│   └── icons/
│       ├── HeartIcon.tsx
│       ├── CrossIcon.tsx
│       ├── StarIcon.tsx
│       └── index.ts
├── hooks/
│   ├── useSwipeGesture.ts
│   ├── useWebSocket.ts
│   └── useGeolocation.ts
├── stores/
│   ├── discoveryStore.ts
│   ├── matchStore.ts
│   └── messageStore.ts
└── routes/
    ├── __root.tsx
    ├── index.tsx                   # Discovery
    ├── matches.tsx
    ├── messages.$matchId.tsx
    └── profile.tsx
```

---

## 3. State Management Design (5 minutes)

### Zustand Stores

```typescript
// stores/discoveryStore.ts
interface DiscoveryState {
  // Card deck
  deck: ProfileCard[];
  deckIndex: number;
  isLoading: boolean;

  // Swipe state
  currentSwipe: { direction: 'left' | 'right' | 'up'; progress: number } | null;
  pendingSwipes: SwipeAction[];

  // Actions
  loadDeck: () => Promise<void>;
  swipe: (userId: string, direction: 'like' | 'pass' | 'super_like') => Promise<SwipeResult>;
  undoSwipe: () => Promise<void>;
  setSwipeProgress: (direction: string, progress: number) => void;
}

export const useDiscoveryStore = create<DiscoveryState>((set, get) => ({
  deck: [],
  deckIndex: 0,
  isLoading: false,
  currentSwipe: null,
  pendingSwipes: [],

  loadDeck: async () => {
    set({ isLoading: true });
    try {
      const location = await getCurrentLocation();
      const response = await api.get('/discovery/deck', {
        params: { latitude: location.lat, longitude: location.lon }
      });
      set({
        deck: response.data.profiles,
        deckIndex: 0,
        isLoading: false
      });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  swipe: async (userId, direction) => {
    const { deck, deckIndex, pendingSwipes } = get();

    // Optimistic update
    set({
      deckIndex: deckIndex + 1,
      pendingSwipes: [...pendingSwipes, { userId, direction, timestamp: Date.now() }]
    });

    try {
      const result = await api.post('/swipes', {
        target_user_id: userId,
        direction,
        idempotency_key: crypto.randomUUID()
      });

      // Remove from pending
      set({
        pendingSwipes: pendingSwipes.filter(s => s.userId !== userId)
      });

      return result.data;
    } catch (error) {
      // Rollback on failure
      set({
        deckIndex: deckIndex,
        pendingSwipes: pendingSwipes.filter(s => s.userId !== userId)
      });
      throw error;
    }
  },

  undoSwipe: async () => {
    const { deckIndex } = get();
    if (deckIndex > 0) {
      await api.delete('/swipes/last');
      set({ deckIndex: deckIndex - 1 });
    }
  },

  setSwipeProgress: (direction, progress) => {
    set({ currentSwipe: { direction, progress } });
  }
}));

// stores/matchStore.ts
interface MatchState {
  matches: Match[];
  newMatchCount: number;
  showMatchModal: MatchModalData | null;

  loadMatches: () => Promise<void>;
  handleNewMatch: (match: Match) => void;
  dismissMatchModal: () => void;
}

export const useMatchStore = create<MatchState>((set, get) => ({
  matches: [],
  newMatchCount: 0,
  showMatchModal: null,

  loadMatches: async () => {
    const response = await api.get('/matches');
    set({ matches: response.data.matches });
  },

  handleNewMatch: (match) => {
    set(state => ({
      matches: [match, ...state.matches],
      newMatchCount: state.newMatchCount + 1,
      showMatchModal: {
        matchId: match.id,
        user: match.user,
        animationComplete: false
      }
    }));
  },

  dismissMatchModal: () => {
    set({ showMatchModal: null });
  }
}));

// stores/messageStore.ts
interface MessageState {
  conversations: Map<string, Conversation>;
  activeConversationId: string | null;
  typingUsers: Map<string, boolean>;

  loadConversation: (matchId: string) => Promise<void>;
  sendMessage: (matchId: string, content: string) => Promise<void>;
  handleIncomingMessage: (message: Message) => void;
  setTyping: (matchId: string, isTyping: boolean) => void;
}
```

### WebSocket Integration

```typescript
// hooks/useWebSocket.ts
export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const { handleNewMatch } = useMatchStore();
  const { handleIncomingMessage, setTyping } = useMessageStore();

  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(`${WS_URL}/events`);

      ws.onopen = () => {
        console.log('WebSocket connected');
        reconnectAttempts.current = 0;
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'match':
            handleNewMatch(data.match);
            break;
          case 'new_message':
            handleIncomingMessage(data.message);
            break;
          case 'typing':
            setTyping(data.match_id, data.is_typing);
            break;
        }
      };

      ws.onclose = () => {
        // Exponential backoff reconnect
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        setTimeout(connect, delay);
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      wsRef.current?.close();
    };
  }, []);

  const sendTypingIndicator = useCallback((matchId: string, isTyping: boolean) => {
    wsRef.current?.send(JSON.stringify({
      type: 'typing',
      match_id: matchId,
      is_typing: isTyping
    }));
  }, []);

  return { sendTypingIndicator };
}
```

---

## 4. Deep Dive: Swipe Card UI (10 minutes)

### Gesture-Based Swipe Card

```typescript
// components/discovery/SwipeCard.tsx
interface SwipeCardProps {
  profile: ProfileCard;
  isTop: boolean;
  onSwipe: (direction: 'like' | 'pass' | 'super_like') => void;
}

export function SwipeCard({ profile, isTop, onSwipe }: SwipeCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, rotate: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);

  const { setSwipeProgress } = useDiscoveryStore();

  // Gesture thresholds
  const SWIPE_THRESHOLD = 150;
  const SUPER_LIKE_THRESHOLD = 100;
  const ROTATION_FACTOR = 0.1;

  const handleDrag = useCallback((e: PointerEvent, startPos: { x: number; y: number }) => {
    const deltaX = e.clientX - startPos.x;
    const deltaY = e.clientY - startPos.y;
    const rotate = deltaX * ROTATION_FACTOR;

    setTransform({ x: deltaX, y: deltaY, rotate });

    // Update store for visual feedback
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      setSwipeProgress(deltaX > 0 ? 'right' : 'left', Math.abs(deltaX) / SWIPE_THRESHOLD);
    } else if (deltaY < -SUPER_LIKE_THRESHOLD / 2) {
      setSwipeProgress('up', Math.abs(deltaY) / SUPER_LIKE_THRESHOLD);
    }
  }, [setSwipeProgress]);

  const handleDragEnd = useCallback((finalTransform: typeof transform) => {
    const { x, y } = finalTransform;

    if (x > SWIPE_THRESHOLD) {
      animateOut('right');
      onSwipe('like');
    } else if (x < -SWIPE_THRESHOLD) {
      animateOut('left');
      onSwipe('pass');
    } else if (y < -SUPER_LIKE_THRESHOLD) {
      animateOut('up');
      onSwipe('super_like');
    } else {
      // Spring back to center
      animateSpringBack();
    }

    setIsDragging(false);
    setSwipeProgress(null, 0);
  }, [onSwipe, setSwipeProgress]);

  const animateOut = (direction: 'left' | 'right' | 'up') => {
    const card = cardRef.current;
    if (!card) return;

    const targets = {
      left: { x: -window.innerWidth * 1.5, rotate: -30 },
      right: { x: window.innerWidth * 1.5, rotate: 30 },
      up: { y: -window.innerHeight * 1.5, rotate: 0 }
    };

    card.animate([
      { transform: `translate(${transform.x}px, ${transform.y}px) rotate(${transform.rotate}deg)` },
      { transform: `translate(${targets[direction].x}px, ${targets[direction].y || 0}px) rotate(${targets[direction].rotate}deg)` }
    ], {
      duration: 300,
      easing: 'ease-out'
    });
  };

  const animateSpringBack = () => {
    const card = cardRef.current;
    if (!card) return;

    card.animate([
      { transform: `translate(${transform.x}px, ${transform.y}px) rotate(${transform.rotate}deg)` },
      { transform: 'translate(0, 0) rotate(0)' }
    ], {
      duration: 400,
      easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' // Springy
    });

    setTransform({ x: 0, y: 0, rotate: 0 });
  };

  // Photo navigation
  const handleTapLeft = () => setPhotoIndex(i => Math.max(0, i - 1));
  const handleTapRight = () => setPhotoIndex(i => Math.min(profile.photos.length - 1, i + 1));

  if (!isTop) {
    // Background card - slightly scaled down
    return (
      <div
        className="absolute inset-0 rounded-2xl overflow-hidden shadow-lg
                   transform scale-95 translate-y-2 opacity-80"
      >
        <img
          src={profile.photos[0]?.url}
          alt=""
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className={`absolute inset-0 rounded-2xl overflow-hidden shadow-2xl
                  cursor-grab ${isDragging ? 'cursor-grabbing' : ''}`}
      style={{
        transform: `translate(${transform.x}px, ${transform.y}px) rotate(${transform.rotate}deg)`,
        touchAction: 'none'
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setIsDragging(true);
        const startPos = { x: e.clientX, y: e.clientY };
        // ... attach move handler
      }}
    >
      {/* Photo Gallery */}
      <div className="relative h-full">
        <img
          src={profile.photos[photoIndex]?.url}
          alt={profile.name}
          className="w-full h-full object-cover"
        />

        {/* Photo navigation zones */}
        <div className="absolute inset-0 flex">
          <div className="flex-1" onClick={handleTapLeft} />
          <div className="flex-1" onClick={handleTapRight} />
        </div>

        {/* Photo indicators */}
        <div className="absolute top-2 left-2 right-2 flex gap-1">
          {profile.photos.map((_, i) => (
            <div
              key={i}
              className={`flex-1 h-1 rounded-full transition-colors
                         ${i === photoIndex ? 'bg-white' : 'bg-white/40'}`}
            />
          ))}
        </div>

        {/* Swipe indicators */}
        <SwipeIndicator
          direction="like"
          opacity={transform.x > 0 ? transform.x / SWIPE_THRESHOLD : 0}
        />
        <SwipeIndicator
          direction="nope"
          opacity={transform.x < 0 ? -transform.x / SWIPE_THRESHOLD : 0}
        />
        <SwipeIndicator
          direction="super"
          opacity={transform.y < 0 ? -transform.y / SUPER_LIKE_THRESHOLD : 0}
        />

        {/* Profile info gradient overlay */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
          <h2 className="text-white text-2xl font-bold">
            {profile.name}, {profile.age}
          </h2>
          <p className="text-white/80 text-sm">{profile.distance_text}</p>
          {profile.bio && (
            <p className="text-white/90 mt-2 line-clamp-2">{profile.bio}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Swipe indicator overlay
function SwipeIndicator({ direction, opacity }: { direction: string; opacity: number }) {
  const config = {
    like: { text: 'LIKE', color: 'text-green-400 border-green-400', position: 'left-4 top-20 -rotate-12' },
    nope: { text: 'NOPE', color: 'text-red-400 border-red-400', position: 'right-4 top-20 rotate-12' },
    super: { text: 'SUPER LIKE', color: 'text-blue-400 border-blue-400', position: 'left-1/2 top-20 -translate-x-1/2' }
  }[direction];

  return (
    <div
      className={`absolute ${config.position} px-4 py-2 border-4 rounded-lg
                  text-2xl font-bold ${config.color}`}
      style={{ opacity: Math.min(opacity, 1) }}
    >
      {config.text}
    </div>
  );
}
```

### Action Buttons

```typescript
// components/discovery/ActionButtons.tsx
interface ActionButtonsProps {
  onPass: () => void;
  onLike: () => void;
  onSuperLike: () => void;
  onUndo?: () => void;
  canUndo: boolean;
  remainingSwipes: number;
}

export function ActionButtons({
  onPass,
  onLike,
  onSuperLike,
  onUndo,
  canUndo,
  remainingSwipes
}: ActionButtonsProps) {
  return (
    <div className="flex items-center justify-center gap-4 py-4">
      {/* Undo button (smaller) */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        className="w-12 h-12 rounded-full bg-white shadow-lg
                   flex items-center justify-center
                   disabled:opacity-40 transition-all
                   hover:scale-110 active:scale-95"
        aria-label="Undo last swipe"
      >
        <UndoIcon className="w-5 h-5 text-yellow-500" />
      </button>

      {/* Pass button */}
      <button
        onClick={onPass}
        className="w-16 h-16 rounded-full bg-white shadow-lg
                   flex items-center justify-center
                   hover:scale-110 active:scale-95 transition-all
                   hover:bg-red-50"
        aria-label="Pass"
      >
        <CrossIcon className="w-8 h-8 text-red-500" />
      </button>

      {/* Super Like button */}
      <button
        onClick={onSuperLike}
        className="w-12 h-12 rounded-full bg-white shadow-lg
                   flex items-center justify-center
                   hover:scale-110 active:scale-95 transition-all
                   hover:bg-blue-50"
        aria-label="Super Like"
      >
        <StarIcon className="w-6 h-6 text-blue-500" />
      </button>

      {/* Like button */}
      <button
        onClick={onLike}
        className="w-16 h-16 rounded-full bg-white shadow-lg
                   flex items-center justify-center
                   hover:scale-110 active:scale-95 transition-all
                   hover:bg-green-50"
        aria-label="Like"
      >
        <HeartIcon className="w-8 h-8 text-green-500" />
      </button>

      {/* Boost button (smaller) */}
      <button
        className="w-12 h-12 rounded-full bg-white shadow-lg
                   flex items-center justify-center
                   hover:scale-110 active:scale-95 transition-all
                   hover:bg-purple-50"
        aria-label="Boost profile"
      >
        <LightningIcon className="w-5 h-5 text-purple-500" />
      </button>
    </div>
  );
}
```

### Swipe Deck Container

```typescript
// components/discovery/SwipeDeck.tsx
export function SwipeDeck() {
  const { deck, deckIndex, isLoading, swipe, loadDeck } = useDiscoveryStore();
  const { showMatchModal, dismissMatchModal, handleNewMatch } = useMatchStore();

  useEffect(() => {
    loadDeck();
  }, [loadDeck]);

  // Prefetch next profiles when running low
  useEffect(() => {
    if (deck.length - deckIndex < 5) {
      loadDeck();
    }
  }, [deckIndex, deck.length, loadDeck]);

  const handleSwipe = async (direction: 'like' | 'pass' | 'super_like') => {
    const currentProfile = deck[deckIndex];
    if (!currentProfile) return;

    const result = await swipe(currentProfile.id, direction);

    if (result.match) {
      handleNewMatch(result.match);
    }
  };

  const visibleCards = deck.slice(deckIndex, deckIndex + 2);

  if (isLoading && visibleCards.length === 0) {
    return <LoadingSpinner />;
  }

  if (visibleCards.length === 0) {
    return <EmptyDeckMessage onRefresh={loadDeck} />;
  }

  return (
    <div className="relative h-[70vh] max-w-sm mx-auto">
      {/* Render cards in reverse order so top card is on top of z-stack */}
      {visibleCards.map((profile, index) => (
        <SwipeCard
          key={profile.id}
          profile={profile}
          isTop={index === 0}
          onSwipe={handleSwipe}
        />
      )).reverse()}

      <ActionButtons
        onPass={() => handleSwipe('pass')}
        onLike={() => handleSwipe('like')}
        onSuperLike={() => handleSwipe('super_like')}
        canUndo={deckIndex > 0}
        remainingSwipes={50} // From API
      />

      {/* Match modal */}
      {showMatchModal && (
        <MatchModal
          matchData={showMatchModal}
          onDismiss={dismissMatchModal}
          onSendMessage={(matchId) => navigate(`/messages/${matchId}`)}
        />
      )}
    </div>
  );
}
```

---

## 5. Deep Dive: Match Celebration Modal (8 minutes)

### Animated Match Modal

```typescript
// components/matches/MatchModal.tsx
interface MatchModalProps {
  matchData: {
    matchId: string;
    user: ProfileCard;
  };
  myProfile: ProfileCard;
  onDismiss: () => void;
  onSendMessage: (matchId: string) => void;
}

export function MatchModal({ matchData, myProfile, onDismiss, onSendMessage }: MatchModalProps) {
  const [phase, setPhase] = useState<'photos' | 'text' | 'buttons'>('photos');
  const overlayRef = useRef<HTMLDivElement>(null);

  // Animation sequence
  useEffect(() => {
    const sequence = async () => {
      await delay(500);  // Photos animate in
      setPhase('text');
      await delay(800);  // Text appears
      setPhase('buttons');
    };
    sequence();
  }, []);

  // Confetti effect
  useEffect(() => {
    const confetti = new ConfettiEffect(overlayRef.current);
    confetti.start();
    return () => confetti.stop();
  }, []);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onDismiss}
    >
      {/* Gradient background with animation */}
      <div
        className="absolute inset-0 animate-gradient-shift"
        style={{
          background: 'linear-gradient(135deg, #ff6b6b, #feca57, #48dbfb, #ff9ff3)'
        }}
      />

      {/* Content */}
      <div
        className="relative z-10 flex flex-col items-center p-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Photo circles with animation */}
        <div className="flex items-center -space-x-8">
          <div
            className={`w-32 h-32 rounded-full overflow-hidden border-4 border-white
                       shadow-xl transform transition-all duration-500
                       ${phase !== 'photos' ? 'translate-x-0 opacity-100' : '-translate-x-20 opacity-0'}`}
          >
            <img
              src={myProfile.photos[0]?.url}
              alt="You"
              className="w-full h-full object-cover"
            />
          </div>

          {/* Heart icon in center */}
          <div
            className={`relative z-10 w-16 h-16 rounded-full bg-white shadow-xl
                       flex items-center justify-center
                       transition-all duration-500 delay-200
                       ${phase !== 'photos' ? 'scale-100 opacity-100' : 'scale-0 opacity-0'}`}
          >
            <HeartIcon className="w-8 h-8 text-pink-500 animate-pulse" />
          </div>

          <div
            className={`w-32 h-32 rounded-full overflow-hidden border-4 border-white
                       shadow-xl transform transition-all duration-500
                       ${phase !== 'photos' ? 'translate-x-0 opacity-100' : 'translate-x-20 opacity-0'}`}
          >
            <img
              src={matchData.user.photos[0]?.url}
              alt={matchData.user.name}
              className="w-full h-full object-cover"
            />
          </div>
        </div>

        {/* "It's a Match!" text */}
        <h1
          className={`mt-8 text-4xl font-bold text-white drop-shadow-lg
                     transition-all duration-500 delay-300
                     ${phase === 'text' || phase === 'buttons' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
          style={{ fontFamily: 'cursive' }}
        >
          It's a Match!
        </h1>

        <p
          className={`mt-2 text-white/90 text-center
                     transition-all duration-500 delay-400
                     ${phase === 'text' || phase === 'buttons' ? 'opacity-100' : 'opacity-0'}`}
        >
          You and {matchData.user.name} liked each other
        </p>

        {/* Action buttons */}
        <div
          className={`mt-8 flex flex-col gap-3 w-full max-w-xs
                     transition-all duration-500 delay-500
                     ${phase === 'buttons' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
        >
          <button
            onClick={() => onSendMessage(matchData.matchId)}
            className="w-full py-3 bg-white rounded-full text-pink-500 font-semibold
                       shadow-lg hover:shadow-xl transition-shadow"
          >
            Send a Message
          </button>

          <button
            onClick={onDismiss}
            className="w-full py-3 bg-white/20 rounded-full text-white font-semibold
                       hover:bg-white/30 transition-colors"
          >
            Keep Swiping
          </button>
        </div>
      </div>
    </div>
  );
}

// CSS for gradient animation
const styles = `
@keyframes gradient-shift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.animate-gradient-shift {
  background-size: 400% 400%;
  animation: gradient-shift 3s ease infinite;
}
`;
```

### Confetti Effect

```typescript
// utils/confetti.ts
class ConfettiEffect {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private animationId: number | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'absolute inset-0 pointer-events-none';
    this.canvas.width = container.offsetWidth;
    this.canvas.height = container.offsetHeight;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  start() {
    // Create initial particles
    for (let i = 0; i < 100; i++) {
      this.particles.push(this.createParticle());
    }
    this.animate();
  }

  private createParticle(): Particle {
    return {
      x: Math.random() * this.canvas.width,
      y: -20,
      size: Math.random() * 10 + 5,
      color: ['#ff6b6b', '#feca57', '#48dbfb', '#ff9ff3', '#1dd1a1'][Math.floor(Math.random() * 5)],
      velocity: { x: (Math.random() - 0.5) * 3, y: Math.random() * 3 + 2 },
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10
    };
  }

  private animate = () => {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.particles.forEach((p, i) => {
      p.x += p.velocity.x;
      p.y += p.velocity.y;
      p.velocity.y += 0.1; // Gravity
      p.rotation += p.rotationSpeed;

      this.ctx.save();
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate((p.rotation * Math.PI) / 180);
      this.ctx.fillStyle = p.color;
      this.ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      this.ctx.restore();

      // Remove off-screen particles
      if (p.y > this.canvas.height + 20) {
        this.particles.splice(i, 1);
      }
    });

    this.animationId = requestAnimationFrame(this.animate);
  };

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.canvas.remove();
  }
}
```

---

## 6. Deep Dive: Chat Interface (7 minutes)

### Conversation Thread

```typescript
// components/messages/ConversationThread.tsx
interface ConversationThreadProps {
  matchId: string;
}

export function ConversationThread({ matchId }: ConversationThreadProps) {
  const { conversations, loadConversation, sendMessage } = useMessageStore();
  const { sendTypingIndicator } = useWebSocket();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState('');
  const typingTimeoutRef = useRef<NodeJS.Timeout>();

  const conversation = conversations.get(matchId);
  const currentUserId = useAuthStore(s => s.user?.id);

  useEffect(() => {
    loadConversation(matchId);
  }, [matchId, loadConversation]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation?.messages.length]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);

    // Debounced typing indicator
    sendTypingIndicator(matchId, true);
    clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      sendTypingIndicator(matchId, false);
    }, 2000);
  };

  const handleSend = async () => {
    if (!inputValue.trim()) return;

    const content = inputValue;
    setInputValue('');
    sendTypingIndicator(matchId, false);

    await sendMessage(matchId, content);
  };

  if (!conversation) {
    return <LoadingSpinner />;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-3 p-4 border-b bg-white">
        <button onClick={() => history.back()} className="p-2">
          <ChevronLeftIcon className="w-6 h-6" />
        </button>
        <Avatar user={conversation.matchedUser} size="md" />
        <div className="flex-1">
          <h2 className="font-semibold">{conversation.matchedUser.name}</h2>
          {conversation.isTyping && (
            <p className="text-sm text-gray-500">Typing...</p>
          )}
        </div>
        <button className="p-2">
          <EllipsisIcon className="w-6 h-6" />
        </button>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
        {conversation.messages.map((message, index) => {
          const isOwn = message.sender_id === currentUserId;
          const showAvatar = !isOwn && (
            index === 0 ||
            conversation.messages[index - 1].sender_id !== message.sender_id
          );

          return (
            <MessageBubble
              key={message.id}
              message={message}
              isOwn={isOwn}
              showAvatar={showAvatar}
              user={conversation.matchedUser}
            />
          );
        })}

        {/* Typing indicator */}
        {conversation.isTyping && (
          <TypingIndicator user={conversation.matchedUser} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t bg-white">
        <div className="flex items-center gap-2">
          <button className="p-2 text-gray-500 hover:text-pink-500">
            <GifIcon className="w-6 h-6" />
          </button>
          <input
            type="text"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
            className="flex-1 px-4 py-2 bg-gray-100 rounded-full
                       focus:outline-none focus:ring-2 focus:ring-pink-500"
          />
          <button
            onClick={handleSend}
            disabled={!inputValue.trim()}
            className="p-2 text-pink-500 disabled:text-gray-300"
          >
            <SendIcon className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

### Message Bubble

```typescript
// components/messages/MessageBubble.tsx
interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
  user: ProfileCard;
}

export function MessageBubble({ message, isOwn, showAvatar, user }: MessageBubbleProps) {
  return (
    <div className={`flex items-end gap-2 ${isOwn ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div className="w-8 h-8 flex-shrink-0">
        {showAvatar && !isOwn && (
          <Avatar user={user} size="sm" />
        )}
      </div>

      {/* Bubble */}
      <div
        className={`max-w-[70%] px-4 py-2 rounded-2xl
                   ${isOwn
                     ? 'bg-gradient-to-r from-pink-500 to-rose-500 text-white rounded-br-md'
                     : 'bg-white text-gray-900 rounded-bl-md shadow-sm'
                   }`}
      >
        <p className="break-words">{message.content}</p>
        <time
          className={`text-xs mt-1 block ${isOwn ? 'text-white/70' : 'text-gray-400'}`}
        >
          {formatTime(message.created_at)}
        </time>
      </div>

      {/* Read receipt */}
      {isOwn && message.read_at && (
        <CheckIcon className="w-4 h-4 text-blue-500" />
      )}
    </div>
  );
}
```

### Typing Indicator

```typescript
// components/messages/TypingIndicator.tsx
export function TypingIndicator({ user }: { user: ProfileCard }) {
  return (
    <div className="flex items-end gap-2">
      <Avatar user={user} size="sm" />
      <div className="bg-white px-4 py-3 rounded-2xl rounded-bl-md shadow-sm">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
```

---

## 7. Procedural Avatar System (5 minutes)

### ReignsAvatar Component

```typescript
// components/shared/ProceduralAvatar.tsx
interface ProceduralAvatarProps {
  seed: string;  // User ID for consistent generation
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

// Component options derived deterministically from seed
const FACE_SHAPES = ['round', 'oval', 'square', 'heart'];
const SKIN_TONES = ['#FFDFC4', '#F0C8A0', '#D4A574', '#8D5524', '#4A2C0A'];
const HAIR_STYLES = ['short', 'long', 'curly', 'bald', 'ponytail'];
const HAIR_COLORS = ['#2C1810', '#4A3728', '#8B4513', '#D4A574', '#FFD700', '#FF6B6B'];
const EYE_COLORS = ['#4A90D9', '#2E7D32', '#8B4513', '#424242'];
const ACCESSORIES = ['none', 'glasses', 'earrings', 'hat'];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function seededRandom(seed: number, index: number): number {
  const x = Math.sin(seed + index) * 10000;
  return x - Math.floor(x);
}

export function ProceduralAvatar({ seed, size = 'md', className }: ProceduralAvatarProps) {
  const hash = hashString(seed);

  // Derive features from hash
  const faceShape = FACE_SHAPES[Math.floor(seededRandom(hash, 0) * FACE_SHAPES.length)];
  const skinTone = SKIN_TONES[Math.floor(seededRandom(hash, 1) * SKIN_TONES.length)];
  const hairStyle = HAIR_STYLES[Math.floor(seededRandom(hash, 2) * HAIR_STYLES.length)];
  const hairColor = HAIR_COLORS[Math.floor(seededRandom(hash, 3) * HAIR_COLORS.length)];
  const eyeColor = EYE_COLORS[Math.floor(seededRandom(hash, 4) * EYE_COLORS.length)];
  const accessory = ACCESSORIES[Math.floor(seededRandom(hash, 5) * ACCESSORIES.length)];

  const sizeMap = { sm: 32, md: 48, lg: 96 };
  const svgSize = sizeMap[size];

  return (
    <svg
      width={svgSize}
      height={svgSize}
      viewBox="0 0 100 100"
      className={className}
    >
      {/* Background circle */}
      <circle cx="50" cy="50" r="48" fill="#f0f0f0" />

      {/* Face base */}
      <FaceShape shape={faceShape} fill={skinTone} />

      {/* Hair (behind face for some styles) */}
      {hairStyle !== 'bald' && (
        <Hair style={hairStyle} color={hairColor} behind={true} />
      )}

      {/* Eyes */}
      <Eyes color={eyeColor} />

      {/* Nose */}
      <path
        d="M 50 45 Q 53 52 50 55 Q 47 52 50 45"
        fill={adjustColor(skinTone, -20)}
      />

      {/* Mouth */}
      <path
        d="M 42 62 Q 50 68 58 62"
        fill="none"
        stroke="#c44"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Hair (in front for some styles) */}
      {hairStyle !== 'bald' && (
        <Hair style={hairStyle} color={hairColor} behind={false} />
      )}

      {/* Accessories */}
      {accessory === 'glasses' && <Glasses />}
      {accessory === 'earrings' && <Earrings color={hairColor} />}
    </svg>
  );
}

// Face shape component
function FaceShape({ shape, fill }: { shape: string; fill: string }) {
  const paths = {
    round: 'M 50 15 C 75 15 85 35 85 55 C 85 80 70 90 50 90 C 30 90 15 80 15 55 C 15 35 25 15 50 15',
    oval: 'M 50 12 C 72 12 80 32 80 55 C 80 82 68 92 50 92 C 32 92 20 82 20 55 C 20 32 28 12 50 12',
    square: 'M 22 20 L 78 20 Q 85 20 85 27 L 85 75 Q 85 90 70 90 L 30 90 Q 15 90 15 75 L 15 27 Q 15 20 22 20',
    heart: 'M 50 12 C 70 12 82 28 82 48 C 82 72 65 92 50 92 C 35 92 18 72 18 48 C 18 28 30 12 50 12'
  };

  return <path d={paths[shape]} fill={fill} />;
}

// Eyes component
function Eyes({ color }: { color: string }) {
  return (
    <>
      {/* Left eye */}
      <ellipse cx="38" cy="42" rx="6" ry="7" fill="white" />
      <circle cx="38" cy="43" r="3" fill={color} />
      <circle cx="37" cy="42" r="1" fill="white" />

      {/* Right eye */}
      <ellipse cx="62" cy="42" rx="6" ry="7" fill="white" />
      <circle cx="62" cy="43" r="3" fill={color} />
      <circle cx="61" cy="42" r="1" fill="white" />
    </>
  );
}

// Hair component (simplified)
function Hair({ style, color, behind }: { style: string; color: string; behind: boolean }) {
  if (style === 'short' && !behind) {
    return (
      <path
        d="M 20 35 Q 20 10 50 10 Q 80 10 80 35 Q 75 20 50 20 Q 25 20 20 35"
        fill={color}
      />
    );
  }

  if (style === 'long' && behind) {
    return (
      <path
        d="M 15 35 Q 15 5 50 5 Q 85 5 85 35 L 85 85 Q 85 95 75 95 L 25 95 Q 15 95 15 85 Z"
        fill={color}
      />
    );
  }

  // ... other styles
  return null;
}
```

---

## 8. Accessibility & Performance (3 minutes)

### Accessibility Features

```typescript
// Keyboard navigation for swipe deck
function useKeyboardSwipe(onSwipe: (dir: string) => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          onSwipe('pass');
          break;
        case 'ArrowRight':
          onSwipe('like');
          break;
        case 'ArrowUp':
          onSwipe('super_like');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSwipe]);
}

// Screen reader announcements
function useSwipeAnnouncement() {
  const announce = useCallback((message: string) => {
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.className = 'sr-only';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1000);
  }, []);

  return { announce };
}
```

### Performance Optimizations

```typescript
// Image preloading for smooth swipes
function useImagePreloader(deck: ProfileCard[], currentIndex: number) {
  useEffect(() => {
    const nextProfiles = deck.slice(currentIndex + 1, currentIndex + 4);

    nextProfiles.forEach(profile => {
      profile.photos.forEach(photo => {
        const img = new Image();
        img.src = photo.url;
      });
    });
  }, [deck, currentIndex]);
}

// Debounced location updates
function useLocationUpdates() {
  const updateLocationDebounced = useMemo(
    () => debounce((lat: number, lon: number) => {
      api.post('/users/me/location', { latitude: lat, longitude: lon });
    }, 30000), // Update at most every 30 seconds
    []
  );

  useEffect(() => {
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        updateLocationDebounced(position.coords.latitude, position.coords.longitude);
      },
      null,
      { enableHighAccuracy: false, maximumAge: 60000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [updateLocationDebounced]);
}
```

---

## 9. Summary

This frontend architecture delivers Tinder's core experience:

1. **Swipe Interface**: Gesture-based cards with 60fps animations and visual feedback
2. **Match Celebration**: Multi-phase animated modal with confetti effects
3. **Real-time Chat**: WebSocket-powered messaging with typing indicators
4. **Procedural Avatars**: ReignsAvatar system for consistent fallback avatars
5. **State Management**: Zustand stores with optimistic updates for instant feedback
6. **Accessibility**: Keyboard navigation and screen reader support
7. **Performance**: Image preloading, debounced updates, efficient re-renders

The mobile-first design prioritizes the core swiping experience while maintaining smooth performance across devices.
