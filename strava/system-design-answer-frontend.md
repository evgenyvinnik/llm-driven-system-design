# Strava - Fitness Tracking Platform - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a fitness tracking platform like Strava, focusing on the frontend systems that handle GPS route visualization, activity feeds, interactive maps, and real-time leaderboards. This involves map rendering with Leaflet, efficient list virtualization, and responsive mobile-first design. Let me clarify requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements (Frontend Perspective)

1. **Activity Upload** - GPX file upload with progress indication and simulated activity creation
2. **Map Visualization** - Display GPS routes on interactive maps with elevation profiles
3. **Activity Feed** - Infinite-scrolling personalized feed with kudos and comments
4. **Segment Leaderboards** - Interactive leaderboards with filtering and personal records
5. **User Profiles** - Following/followers, activity history, personal statistics
6. **Achievement Display** - Badge grid with progress indicators

### Non-Functional Requirements

- **Performance** - Sub-100ms interactions, smooth map panning
- **Responsiveness** - Mobile-first design, works on all screen sizes
- **Accessibility** - WCAG 2.1 AA compliance for core features
- **Offline Support** - Cached feed viewing when offline (future)

### Frontend-Specific Considerations

- Map tile loading and caching strategy
- Large GPS point arrays (1000s of points per activity)
- Real-time kudos/comment updates
- Form validation for activity metadata

---

## 2. Technology Stack (3 minutes)

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Framework | React 19 + Vite | Fast HMR, TypeScript support |
| Routing | TanStack Router | File-based routing, type-safe |
| State | Zustand | Minimal boilerplate, performant |
| Maps | Leaflet + React-Leaflet | Open source, widely supported |
| Styling | Tailwind CSS | Utility-first, consistent design |
| Data Fetching | TanStack Query | Caching, background refresh |
| Forms | React Hook Form | Performant, validation built-in |

---

## 3. Application Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              App Shell                                   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                         Navigation                                │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │   │
│  │  │   Home   │  │ Explore  │  │ Segments │  │ Profile  │        │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        Main Content                               │   │
│  │                                                                   │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │
│  │   │  Activity   │  │   Map       │  │ Leaderboard │             │   │
│  │   │    Feed     │  │   View      │  │    Panel    │             │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘             │   │
│  │                                                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      Zustand Store                                │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │   │
│  │  │   Auth   │  │Activities│  │ Segments │  │   Feed   │        │   │
│  │  │  Slice   │  │  Slice   │  │  Slice   │  │  Slice   │        │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Route Structure

```
frontend/src/routes/
├── __root.tsx           # Root layout with navigation
├── index.tsx            # Activity feed (home)
├── explore.tsx          # Public activities
├── upload.tsx           # Activity upload
├── activity.$id.tsx     # Activity detail with map
├── segments.tsx         # Segment explorer
├── segment.$id.tsx      # Segment detail with leaderboard
├── profile.$username.tsx # User profile
├── settings.tsx         # User settings
└── login.tsx            # Authentication
```

---

## 4. Component Architecture (8 minutes)

### Activity Feed Component

```tsx
// routes/index.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useInfiniteQuery } from '@tanstack/react-query';

export function ActivityFeed() {
  const parentRef = useRef<HTMLDivElement>(null);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['feed'],
    queryFn: ({ pageParam }) => api.getFeed(pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialPageParam: undefined,
  });

  const allActivities = data?.pages.flatMap(p => p.activities) ?? [];

  const virtualizer = useVirtualizer({
    count: hasNextPage ? allActivities.length + 1 : allActivities.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 400, // Estimated card height
    overscan: 3,
  });

  // Trigger load more when approaching end
  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1);
    if (lastItem && lastItem.index >= allActivities.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), hasNextPage, isFetchingNextPage]);

  return (
    <div ref={parentRef} className="h-screen overflow-auto">
      <div
        style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const activity = allActivities[virtualRow.index];

          if (!activity) {
            return (
              <div
                key="loader"
                style={{
                  position: 'absolute',
                  top: virtualRow.start,
                  height: virtualRow.size,
                }}
              >
                <LoadingSpinner />
              </div>
            );
          }

          return (
            <div
              key={activity.id}
              style={{
                position: 'absolute',
                top: virtualRow.start,
                width: '100%',
              }}
            >
              <ActivityCard activity={activity} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Activity Card Component

```tsx
// components/ActivityCard.tsx
interface ActivityCardProps {
  activity: Activity;
}

export function ActivityCard({ activity }: ActivityCardProps) {
  const [showComments, setShowComments] = useState(false);
  const kudosMutation = useMutation({
    mutationFn: () => api.toggleKudos(activity.id),
    onSuccess: () => queryClient.invalidateQueries(['feed']),
  });

  return (
    <article className="bg-white rounded-lg shadow-sm border p-4 mb-4">
      {/* Header with user info */}
      <header className="flex items-center gap-3 mb-3">
        <Link to={`/profile/${activity.user.username}`}>
          <img
            src={activity.user.profilePhoto || '/default-avatar.png'}
            alt={activity.user.username}
            className="w-10 h-10 rounded-full"
          />
        </Link>
        <div>
          <Link
            to={`/profile/${activity.user.username}`}
            className="font-semibold hover:underline"
          >
            {activity.user.username}
          </Link>
          <p className="text-sm text-gray-500">
            {formatRelativeTime(activity.startTime)}
          </p>
        </div>
      </header>

      {/* Activity details */}
      <Link to={`/activity/${activity.id}`} className="block">
        <h3 className="text-lg font-semibold mb-2">{activity.name}</h3>

        {/* Mini map preview */}
        <div className="h-48 rounded-lg overflow-hidden mb-3">
          <ActivityMapPreview polyline={activity.polyline} />
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-4 text-center">
          <StatBlock
            label="Distance"
            value={formatDistance(activity.distance)}
          />
          <StatBlock
            label="Time"
            value={formatDuration(activity.movingTime)}
          />
          <StatBlock
            label="Pace"
            value={formatPace(activity.distance, activity.movingTime)}
          />
        </div>
      </Link>

      {/* Social actions */}
      <footer className="flex items-center gap-4 mt-4 pt-4 border-t">
        <button
          onClick={() => kudosMutation.mutate()}
          className={`flex items-center gap-1 ${
            activity.hasKudos ? 'text-orange-500' : 'text-gray-500'
          }`}
          aria-pressed={activity.hasKudos}
        >
          <ThumbsUpIcon className="w-5 h-5" />
          <span>{activity.kudosCount}</span>
        </button>

        <button
          onClick={() => setShowComments(!showComments)}
          className="flex items-center gap-1 text-gray-500"
          aria-expanded={showComments}
        >
          <CommentIcon className="w-5 h-5" />
          <span>{activity.commentCount}</span>
        </button>
      </footer>

      {/* Expandable comments */}
      {showComments && (
        <CommentSection activityId={activity.id} />
      )}
    </article>
  );
}
```

### Activity Map Component

```tsx
// components/ActivityMap.tsx
import { MapContainer, TileLayer, Polyline, Marker, useMap } from 'react-leaflet';
import { decode } from '@googlemaps/polyline-codec';

interface ActivityMapProps {
  polyline: string;
  segmentEfforts?: SegmentEffort[];
  height?: string;
}

export function ActivityMap({ polyline, segmentEfforts = [], height = '400px' }: ActivityMapProps) {
  const positions = useMemo(() => {
    const decoded = decode(polyline);
    return decoded.map(([lat, lng]) => [lat, lng] as [number, number]);
  }, [polyline]);

  const bounds = useMemo(() => {
    if (positions.length === 0) return undefined;
    return L.latLngBounds(positions);
  }, [positions]);

  return (
    <MapContainer
      bounds={bounds}
      style={{ height, width: '100%' }}
      scrollWheelZoom={true}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Main route */}
      <Polyline
        positions={positions}
        pathOptions={{ color: '#fc4c02', weight: 4 }}
      />

      {/* Start marker */}
      <Marker position={positions[0]}>
        <Popup>Start</Popup>
      </Marker>

      {/* End marker */}
      <Marker position={positions[positions.length - 1]}>
        <Popup>Finish</Popup>
      </Marker>

      {/* Segment overlays */}
      {segmentEfforts.map((effort) => (
        <SegmentOverlay key={effort.id} effort={effort} />
      ))}

      <FitBoundsOnLoad bounds={bounds} />
    </MapContainer>
  );
}

function FitBoundsOnLoad({ bounds }: { bounds?: L.LatLngBounds }) {
  const map = useMap();

  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [map, bounds]);

  return null;
}
```

### Segment Leaderboard Component

```tsx
// components/SegmentLeaderboard.tsx
interface LeaderboardProps {
  segmentId: string;
}

export function SegmentLeaderboard({ segmentId }: LeaderboardProps) {
  const [filter, setFilter] = useState<'overall' | 'friends' | 'my'>('overall');
  const { user } = useAuthStore();

  const { data: leaderboard, isLoading } = useQuery({
    queryKey: ['leaderboard', segmentId, filter],
    queryFn: () => api.getLeaderboard(segmentId, { filter }),
  });

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      {/* Filter tabs */}
      <div className="flex border-b">
        {(['overall', 'friends', 'my'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`flex-1 py-3 text-sm font-medium ${
              filter === f
                ? 'border-b-2 border-orange-500 text-orange-500'
                : 'text-gray-500'
            }`}
            aria-pressed={filter === f}
          >
            {f === 'overall' ? 'All Athletes' : f === 'friends' ? 'Following' : 'My Results'}
          </button>
        ))}
      </div>

      {/* Leaderboard table */}
      <div className="divide-y">
        {isLoading ? (
          <LoadingSkeleton rows={10} />
        ) : (
          leaderboard?.map((entry, index) => (
            <LeaderboardRow
              key={entry.oderId}
              rank={index + 1}
              entry={entry}
              isCurrentUser={entry.oderId === user?.id}
            />
          ))
        )}
      </div>
    </div>
  );
}

function LeaderboardRow({ rank, entry, isCurrentUser }: LeaderboardRowProps) {
  return (
    <div
      className={`flex items-center p-3 ${
        isCurrentUser ? 'bg-orange-50' : ''
      } ${rank <= 3 ? 'font-semibold' : ''}`}
    >
      {/* Rank with medal icons */}
      <div className="w-12 text-center">
        {rank === 1 && <span className="text-yellow-500">1st</span>}
        {rank === 2 && <span className="text-gray-400">2nd</span>}
        {rank === 3 && <span className="text-amber-600">3rd</span>}
        {rank > 3 && <span className="text-gray-500">{rank}</span>}
      </div>

      {/* Athlete info */}
      <Link
        to={`/profile/${entry.user.username}`}
        className="flex items-center gap-2 flex-1"
      >
        <img
          src={entry.user.profilePhoto || '/default-avatar.png'}
          alt=""
          className="w-8 h-8 rounded-full"
        />
        <span>{entry.user.username}</span>
      </Link>

      {/* Time */}
      <div className="text-right font-mono">
        {formatDuration(entry.elapsedTime)}
      </div>
    </div>
  );
}
```

---

## 5. State Management (5 minutes)

### Zustand Store Structure

```tsx
// stores/authStore.ts
interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,

  login: async (email, password) => {
    const response = await api.login(email, password);
    set({ user: response.user, isAuthenticated: true });
  },

  logout: async () => {
    await api.logout();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    try {
      const user = await api.getCurrentUser();
      set({ user, isAuthenticated: true });
    } catch {
      set({ user: null, isAuthenticated: false });
    }
  },
}));
```

```tsx
// stores/feedStore.ts
interface FeedState {
  activities: Activity[];
  cursor: string | null;
  hasMore: boolean;
  loadFeed: () => Promise<void>;
  loadMore: () => Promise<void>;
  addKudos: (activityId: string) => void;
  removeKudos: (activityId: string) => void;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  activities: [],
  cursor: null,
  hasMore: true,

  loadFeed: async () => {
    const response = await api.getFeed();
    set({
      activities: response.activities,
      cursor: response.nextCursor,
      hasMore: !!response.nextCursor,
    });
  },

  loadMore: async () => {
    const { cursor, activities, hasMore } = get();
    if (!hasMore || !cursor) return;

    const response = await api.getFeed(cursor);
    set({
      activities: [...activities, ...response.activities],
      cursor: response.nextCursor,
      hasMore: !!response.nextCursor,
    });
  },

  addKudos: (activityId) => {
    set((state) => ({
      activities: state.activities.map((a) =>
        a.id === activityId
          ? { ...a, kudosCount: a.kudosCount + 1, hasKudos: true }
          : a
      ),
    }));
  },

  removeKudos: (activityId) => {
    set((state) => ({
      activities: state.activities.map((a) =>
        a.id === activityId
          ? { ...a, kudosCount: a.kudosCount - 1, hasKudos: false }
          : a
      ),
    }));
  },
}));
```

---

## 6. Deep Dive: Activity Upload Flow (8 minutes)

### Upload Component with Drag-and-Drop

```tsx
// routes/upload.tsx
export function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ActivityPreview | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const navigate = useNavigate();

  const uploadMutation = useMutation({
    mutationFn: async (data: { file: File; metadata: ActivityMetadata }) => {
      const formData = new FormData();
      formData.append('file', data.file);
      formData.append('name', data.metadata.name);
      formData.append('type', data.metadata.type);

      return api.uploadActivity(formData, {
        onUploadProgress: (progress) => {
          setUploadProgress(Math.round((progress.loaded / progress.total) * 100));
        },
      });
    },
    onSuccess: (activity) => {
      navigate(`/activity/${activity.id}`);
    },
  });

  const handleFileDrop = async (acceptedFiles: File[]) => {
    const gpxFile = acceptedFiles[0];
    if (!gpxFile) return;

    setFile(gpxFile);

    // Parse GPX client-side for preview
    const content = await gpxFile.text();
    const preview = parseGPXPreview(content);
    setPreview(preview);
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Upload Activity</h1>

      {/* Drag and drop zone */}
      {!file && (
        <Dropzone
          onDrop={handleFileDrop}
          accept={{ 'application/gpx+xml': ['.gpx'] }}
        >
          {({ getRootProps, getInputProps, isDragActive }) => (
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer
                ${isDragActive ? 'border-orange-500 bg-orange-50' : 'border-gray-300'}`}
            >
              <input {...getInputProps()} />
              <UploadIcon className="w-12 h-12 mx-auto mb-4 text-gray-400" />
              <p className="text-lg">
                {isDragActive ? 'Drop your GPX file here' : 'Drag & drop a GPX file, or click to select'}
              </p>
              <p className="text-sm text-gray-500 mt-2">
                Supports .gpx files up to 10MB
              </p>
            </div>
          )}
        </Dropzone>
      )}

      {/* Preview and metadata form */}
      {preview && (
        <div className="space-y-6">
          {/* Map preview */}
          <div className="h-64 rounded-lg overflow-hidden">
            <ActivityMapPreview polyline={preview.polyline} />
          </div>

          {/* Stats preview */}
          <div className="grid grid-cols-3 gap-4">
            <StatBlock label="Distance" value={formatDistance(preview.distance)} />
            <StatBlock label="Duration" value={formatDuration(preview.duration)} />
            <StatBlock label="Elevation" value={`${preview.elevationGain}m`} />
          </div>

          {/* Metadata form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Activity Name</label>
              <input
                type="text"
                defaultValue={preview.suggestedName}
                className="w-full px-3 py-2 border rounded-lg"
                {...register('name', { required: true })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Activity Type</label>
              <select
                className="w-full px-3 py-2 border rounded-lg"
                {...register('type')}
              >
                <option value="run">Run</option>
                <option value="ride">Ride</option>
                <option value="hike">Hike</option>
                <option value="walk">Walk</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={uploadMutation.isPending}
              className="w-full bg-orange-500 text-white py-3 rounded-lg font-semibold
                hover:bg-orange-600 disabled:opacity-50"
            >
              {uploadMutation.isPending ? (
                <span>Uploading... {uploadProgress}%</span>
              ) : (
                'Upload Activity'
              )}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
```

### Client-Side GPX Preview Parser

```tsx
// utils/gpxParser.ts
export function parseGPXPreview(gpxContent: string): ActivityPreview {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxContent, 'text/xml');
  const trackpoints = doc.querySelectorAll('trkpt');

  const points: [number, number][] = [];
  let totalDistance = 0;
  let totalElevationGain = 0;
  let prevPoint: { lat: number; lng: number; ele: number } | null = null;

  trackpoints.forEach((trkpt) => {
    const lat = parseFloat(trkpt.getAttribute('lat') || '0');
    const lng = parseFloat(trkpt.getAttribute('lon') || '0');
    const ele = parseFloat(trkpt.querySelector('ele')?.textContent || '0');

    points.push([lat, lng]);

    if (prevPoint) {
      totalDistance += haversineDistance(prevPoint, { lat, lng });
      const elevChange = ele - prevPoint.ele;
      if (elevChange > 0) totalElevationGain += elevChange;
    }

    prevPoint = { lat, lng, ele };
  });

  // Encode to polyline for preview
  const polyline = encodePolyline(points);

  // Calculate duration from timestamps
  const firstTime = new Date(trackpoints[0]?.querySelector('time')?.textContent || '');
  const lastTime = new Date(trackpoints[trackpoints.length - 1]?.querySelector('time')?.textContent || '');
  const duration = (lastTime.getTime() - firstTime.getTime()) / 1000;

  return {
    polyline,
    distance: totalDistance,
    duration,
    elevationGain: Math.round(totalElevationGain),
    suggestedName: generateActivityName(new Date(firstTime)),
    pointCount: points.length,
  };
}
```

---

## 7. Accessibility Considerations (3 minutes)

### Keyboard Navigation

```tsx
// components/Leaderboard.tsx - Keyboard accessible table
export function LeaderboardTable({ entries }: { entries: LeaderboardEntry[] }) {
  const [focusedIndex, setFocusedIndex] = useState(0);

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, entries.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        // Navigate to athlete profile
        navigate(`/profile/${entries[focusedIndex].user.username}`);
        break;
    }
  };

  return (
    <table
      role="grid"
      aria-label="Segment leaderboard"
      onKeyDown={handleKeyDown}
    >
      <thead>
        <tr>
          <th scope="col">Rank</th>
          <th scope="col">Athlete</th>
          <th scope="col">Time</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, index) => (
          <tr
            key={entry.id}
            tabIndex={index === focusedIndex ? 0 : -1}
            aria-selected={index === focusedIndex}
            className={index === focusedIndex ? 'bg-blue-50 ring-2 ring-blue-500' : ''}
          >
            <td>{index + 1}</td>
            <td>{entry.user.username}</td>
            <td>{formatDuration(entry.elapsedTime)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Screen Reader Announcements

```tsx
// hooks/useLiveRegion.ts
export function useLiveRegion() {
  const announce = useCallback((message: string, priority: 'polite' | 'assertive' = 'polite') => {
    const region = document.getElementById('live-region');
    if (region) {
      region.setAttribute('aria-live', priority);
      region.textContent = message;
    }
  }, []);

  return { announce };
}

// Usage in kudos button
function KudosButton({ activity }: { activity: Activity }) {
  const { announce } = useLiveRegion();

  const handleKudos = async () => {
    await toggleKudos(activity.id);
    announce(
      activity.hasKudos
        ? 'Kudos removed'
        : `Kudos given to ${activity.user.username}`,
      'polite'
    );
  };

  return (
    <button
      onClick={handleKudos}
      aria-label={`${activity.hasKudos ? 'Remove' : 'Give'} kudos. Current count: ${activity.kudosCount}`}
    >
      <ThumbsUpIcon />
    </button>
  );
}
```

---

## 8. Performance Optimizations (5 minutes)

### Map Tile Caching

```tsx
// hooks/useMapTileCache.ts
const TILE_CACHE_NAME = 'strava-map-tiles-v1';

export function useMapTileCache() {
  useEffect(() => {
    // Pre-cache common zoom levels for user's area
    if ('caches' in window) {
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude } = pos.coords;
        const cache = await caches.open(TILE_CACHE_NAME);

        // Cache tiles for zoom levels 10-15 around user location
        for (let z = 10; z <= 15; z++) {
          const { x, y } = latLngToTile(latitude, longitude, z);
          const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
          try {
            await cache.add(url);
          } catch {
            // Ignore cache errors
          }
        }
      });
    }
  }, []);
}
```

### Polyline Simplification for Large Routes

```tsx
// utils/polylineSimplify.ts
import simplify from 'simplify-js';

export function simplifyForZoom(points: [number, number][], zoom: number): [number, number][] {
  // More simplification at lower zoom levels
  const tolerance = Math.pow(2, 15 - zoom) * 0.00001;

  const simplified = simplify(
    points.map(([lat, lng]) => ({ x: lng, y: lat })),
    tolerance,
    true
  );

  return simplified.map(({ x, y }) => [y, x]);
}

// Usage in map component
function ActivityMap({ polyline }: { polyline: string }) {
  const [zoom, setZoom] = useState(13);
  const map = useMap();

  const positions = useMemo(() => {
    const decoded = decode(polyline);
    return simplifyForZoom(decoded, zoom);
  }, [polyline, zoom]);

  useMapEvents({
    zoomend: () => setZoom(map.getZoom()),
  });

  return <Polyline positions={positions} />;
}
```

### Lazy Loading Activity Cards

```tsx
// components/LazyActivityCard.tsx
const ActivityMapPreview = lazy(() => import('./ActivityMapPreview'));

export function LazyActivityCard({ activity }: { activity: Activity }) {
  const { ref, inView } = useInView({
    triggerOnce: true,
    threshold: 0.1,
  });

  return (
    <article ref={ref} className="bg-white rounded-lg shadow-sm p-4">
      {/* Header always renders */}
      <ActivityCardHeader activity={activity} />

      {/* Map only loads when visible */}
      {inView ? (
        <Suspense fallback={<MapSkeleton />}>
          <ActivityMapPreview polyline={activity.polyline} />
        </Suspense>
      ) : (
        <MapSkeleton />
      )}

      <ActivityCardStats activity={activity} />
      <ActivityCardActions activity={activity} />
    </article>
  );
}
```

---

## 9. Trade-offs and Alternatives

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Map Library | Leaflet | Open source, larger bundle | Mapbox GL (better perf, paid) |
| State Management | Zustand | Simple, less boilerplate | Redux Toolkit (more features, verbose) |
| Virtualization | TanStack Virtual | Manual setup | react-window (simpler API) |
| Styling | Tailwind CSS | Utility classes, large CSS | CSS Modules (scoped, smaller) |
| GPX Parsing | Client-side | Immediate preview | Server-only (simpler, no preview) |
| Polyline Display | Encoded | Compact storage | Raw points (easier debug) |

---

## 10. Future Enhancements

1. **Offline Support**
   - Service Worker for feed caching
   - IndexedDB for offline activity viewing
   - Background sync for kudos/comments

2. **Real-time Updates**
   - WebSocket for live kudos notifications
   - Server-Sent Events for feed updates
   - Optimistic UI updates

3. **Elevation Profile Chart**
   - D3.js or Chart.js integration
   - Synchronized hover with map
   - Gradient analysis visualization

4. **Mobile App Shell**
   - PWA with install prompt
   - Native-like navigation
   - Push notifications for achievements

---

## Summary

"To summarize the frontend architecture:

1. **React 19 + TanStack Router** - File-based routing with type-safe navigation and data loading

2. **Leaflet for maps** - Interactive GPS route visualization with polyline encoding for efficient storage and transfer

3. **TanStack Virtual for feeds** - Virtualized infinite-scrolling feed that renders only visible items

4. **Zustand for state** - Lightweight global state for auth, feed, and UI state with minimal boilerplate

5. **Progressive enhancement** - Client-side GPX preview before upload, lazy-loaded map components, cached map tiles

The key insight is balancing immediate feedback (client-side GPX parsing, optimistic updates) with performance (virtualization, lazy loading, polyline simplification) to create a responsive experience even with large GPS datasets."
