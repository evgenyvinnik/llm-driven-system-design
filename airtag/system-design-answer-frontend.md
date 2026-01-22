# AirTag - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend experience for AirTag's Find My app, enabling users to locate their items through a privacy-preserving crowd-sourced network. Key frontend challenges include:
- Interactive map with real-time location updates
- Privacy-preserving decryption in the browser/app
- Anti-stalking detection UI and notifications
- Precision finding with UWB directional guidance
- Offline-capable device management

## Requirements Clarification

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

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Find My Application                          │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    App Shell                             │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │   │
│  │  │ Devices │  │   Map   │  │  People │  │   Me    │    │   │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│  ┌───────────────────────────┴────────────────────────────┐    │
│  │                    Main View                            │    │
│  │  ┌─────────────────────────────────────────────────┐   │    │
│  │  │              Interactive Map                     │   │    │
│  │  │         (Leaflet / MapKit / Google)              │   │    │
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐          │   │    │
│  │  │  │ Marker  │  │ Marker  │  │ Marker  │          │   │    │
│  │  │  │ (Keys)  │  │ (Bag)   │  │(Wallet) │          │   │    │
│  │  │  └─────────┘  └─────────┘  └─────────┘          │   │    │
│  │  └─────────────────────────────────────────────────┘   │    │
│  │                                                         │    │
│  │  ┌─────────────────────────────────────────────────┐   │    │
│  │  │              Device Card (Selected)              │   │    │
│  │  │  Name | Last seen | Actions (Play Sound, etc.)   │   │    │
│  │  └─────────────────────────────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Map Component Architecture

### Interactive Map with Device Markers

```tsx
interface DeviceLocation {
  deviceId: string;
  name: string;
  emoji: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: Date;
  isRecent: boolean;  // < 15 minutes old
}

function FindMyMap({ devices }: { devices: DeviceLocation[] }) {
  const mapRef = useRef<L.Map | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [mapBounds, setMapBounds] = useState<L.LatLngBounds | null>(null);

  // Fit map to show all devices
  useEffect(() => {
    if (devices.length > 0 && mapRef.current) {
      const bounds = L.latLngBounds(
        devices.map(d => [d.latitude, d.longitude])
      );
      mapRef.current.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [devices]);

  // Auto-refresh locations every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refreshDeviceLocations();
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative h-full">
      <MapContainer
        ref={mapRef}
        className="h-full w-full"
        center={[37.7749, -122.4194]}
        zoom={12}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        {devices.map(device => (
          <DeviceMarker
            key={device.deviceId}
            device={device}
            isSelected={selectedDevice === device.deviceId}
            onSelect={() => setSelectedDevice(device.deviceId)}
          />
        ))}

        {/* Accuracy circle for selected device */}
        {selectedDevice && (
          <AccuracyCircle device={devices.find(d => d.deviceId === selectedDevice)} />
        )}
      </MapContainer>

      {/* Device list overlay */}
      <DeviceListPanel
        devices={devices}
        selectedDevice={selectedDevice}
        onDeviceSelect={setSelectedDevice}
      />

      {/* Selected device card */}
      {selectedDevice && (
        <DeviceDetailCard
          device={devices.find(d => d.deviceId === selectedDevice)!}
          onClose={() => setSelectedDevice(null)}
        />
      )}
    </div>
  );
}
```

### Custom Device Markers

```tsx
function DeviceMarker({
  device,
  isSelected,
  onSelect
}: {
  device: DeviceLocation;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const markerRef = useRef<L.Marker | null>(null);

  // Create custom icon with emoji and status
  const icon = useMemo(() => {
    return L.divIcon({
      className: 'device-marker',
      html: `
        <div class="${cn(
          'flex items-center justify-center w-10 h-10 rounded-full shadow-lg',
          'transform transition-transform duration-200',
          isSelected ? 'scale-125 ring-2 ring-blue-500' : '',
          device.isRecent ? 'bg-green-500' : 'bg-gray-400'
        )}">
          <span class="text-xl">${device.emoji}</span>
        </div>
        ${!device.isRecent ? `
          <div class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-xs text-gray-600">
            ${formatTimeAgo(device.timestamp)}
          </div>
        ` : ''}
      `,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
  }, [device, isSelected]);

  return (
    <Marker
      ref={markerRef}
      position={[device.latitude, device.longitude]}
      icon={icon}
      eventHandlers={{
        click: onSelect,
        keypress: (e) => {
          if (e.originalEvent.key === 'Enter') onSelect();
        }
      }}
      keyboard={true}
      alt={`${device.name}, last seen ${formatTimeAgo(device.timestamp)}`}
    />
  );
}
```

## Deep Dive: Client-Side Decryption

### Privacy-Preserving Location Retrieval

The key insight is that **decryption happens entirely on the client**. The server only stores encrypted blobs.

```typescript
class FindMyDecryptionService {
  private masterSecret: string;
  private crypto: SubtleCrypto;

  constructor(masterSecret: string) {
    this.masterSecret = masterSecret;
    this.crypto = window.crypto.subtle;
  }

  async decryptLocations(
    encryptedReports: EncryptedReport[],
    timeRange: TimeRange
  ): Promise<DecryptedLocation[]> {
    const locations: DecryptedLocation[] = [];

    // Generate private keys for each 15-minute period in range
    const periodKeys = await this.generatePeriodKeys(timeRange);

    for (const report of encryptedReports) {
      for (const [period, privateKey] of periodKeys) {
        try {
          const location = await this.decryptReport(report, privateKey);
          locations.push({
            ...location,
            period,
            reportId: report.id
          });
          break;  // Successfully decrypted, move to next report
        } catch {
          // Not our key for this report, try next period
        }
      }
    }

    return locations.sort((a, b) => b.timestamp - a.timestamp);
  }

  private async decryptReport(
    report: EncryptedReport,
    privateKey: CryptoKey
  ): Promise<RawLocation> {
    const { ephemeralPublicKey, iv, ciphertext, authTag } = report.encryptedPayload;

    // Import ephemeral public key
    const ephemeralKey = await this.crypto.importKey(
      'raw',
      base64ToArrayBuffer(ephemeralPublicKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    // Derive shared secret
    const sharedSecret = await this.crypto.deriveBits(
      { name: 'ECDH', public: ephemeralKey },
      privateKey,
      256
    );

    // Derive decryption key
    const decryptionKey = await this.crypto.importKey(
      'raw',
      sharedSecret,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    // Decrypt
    const combined = new Uint8Array([
      ...base64ToArrayBuffer(ciphertext),
      ...base64ToArrayBuffer(authTag)
    ]);

    const decrypted = await this.crypto.decrypt(
      { name: 'AES-GCM', iv: base64ToArrayBuffer(iv) },
      decryptionKey,
      combined
    );

    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  private async generatePeriodKeys(
    timeRange: TimeRange
  ): Promise<Map<number, CryptoKey>> {
    const keys = new Map<number, CryptoKey>();
    const startPeriod = Math.floor(timeRange.start / (15 * 60 * 1000));
    const endPeriod = Math.floor(timeRange.end / (15 * 60 * 1000));

    for (let period = startPeriod; period <= endPeriod; period++) {
      const privateKeyBytes = await this.deriveKeyForPeriod(period);
      const key = await this.crypto.importKey(
        'raw',
        privateKeyBytes,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
      );
      keys.set(period, key);
    }

    return keys;
  }
}
```

### Decryption Hook with Loading State

```tsx
function useDecryptedLocations(deviceId: string) {
  const { masterSecret } = useAuth();
  const [locations, setLocations] = useState<DecryptedLocation[]>([]);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [progress, setProgress] = useState(0);

  const decryptionService = useMemo(
    () => new FindMyDecryptionService(masterSecret),
    [masterSecret]
  );

  const fetchAndDecrypt = useCallback(async (timeRange: TimeRange) => {
    setIsDecrypting(true);
    setProgress(0);

    try {
      // Generate identifier hashes
      const hashes = await decryptionService.generateIdentifierHashes(timeRange);
      setProgress(20);

      // Fetch encrypted reports from server
      const reports = await api.queryReports(hashes, timeRange);
      setProgress(50);

      // Decrypt locally
      const decrypted = await decryptionService.decryptLocations(
        reports,
        timeRange
      );
      setProgress(100);

      setLocations(decrypted);
    } finally {
      setIsDecrypting(false);
    }
  }, [decryptionService]);

  return { locations, isDecrypting, progress, fetchAndDecrypt };
}
```

## Deep Dive: Precision Finding UI

### UWB Directional Interface

```tsx
function PrecisionFindingView({ device }: { device: RegisteredDevice }) {
  const [ranging, setRanging] = useState<UWBRanging | null>(null);
  const [isActive, setIsActive] = useState(false);

  // Start UWB ranging session
  useEffect(() => {
    if (!isActive) return;

    let session: UWBSession | null = null;

    const startRanging = async () => {
      session = await uwb.startRanging(device.identifier);

      session.onRanging((data) => {
        setRanging({
          distance: data.distance,
          direction: {
            azimuth: data.azimuth,     // Horizontal angle (-180 to 180)
            elevation: data.elevation   // Vertical angle (-90 to 90)
          },
          signalStrength: data.rssi
        });
      });
    };

    startRanging();

    return () => {
      session?.stop();
    };
  }, [device.identifier, isActive]);

  // Haptic feedback as user gets closer
  useEffect(() => {
    if (!ranging) return;

    if (ranging.distance < 1) {
      haptics.impact('heavy');
    } else if (ranging.distance < 3) {
      haptics.impact('medium');
    } else if (ranging.distance < 5) {
      haptics.impact('light');
    }
  }, [ranging?.distance]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black">
      {/* Direction indicator */}
      <div className="relative w-64 h-64">
        <DirectionArrow
          azimuth={ranging?.direction.azimuth ?? 0}
          elevation={ranging?.direction.elevation ?? 0}
          distance={ranging?.distance ?? 0}
        />
      </div>

      {/* Distance display */}
      <div className="mt-8 text-center">
        <span className={cn(
          'text-6xl font-bold transition-colors duration-200',
          ranging && ranging.distance < 1 ? 'text-green-500' :
          ranging && ranging.distance < 3 ? 'text-yellow-500' :
          'text-white'
        )}>
          {ranging ? formatDistance(ranging.distance) : '--'}
        </span>
        <p className="mt-2 text-gray-400">
          {ranging && ranging.distance < 1
            ? 'Very close!'
            : 'Move in the direction of the arrow'}
        </p>
      </div>

      {/* Signal strength indicator */}
      <SignalStrengthBar strength={ranging?.signalStrength ?? 0} />

      {/* Play sound button */}
      <button
        className="mt-8 px-6 py-3 bg-blue-600 rounded-full"
        onClick={() => api.playSound(device.id)}
      >
        Play Sound
      </button>
    </div>
  );
}

function DirectionArrow({ azimuth, elevation, distance }: {
  azimuth: number;
  elevation: number;
  distance: number;
}) {
  // Calculate arrow rotation and size based on UWB data
  const rotation = azimuth;  // Horizontal direction
  const opacity = Math.max(0.3, 1 - distance / 10);  // Fade as distance increases
  const size = Math.max(100, 200 - distance * 20);   // Grow as closer

  return (
    <svg
      viewBox="0 0 100 100"
      className="absolute inset-0"
      style={{
        transform: `rotate(${rotation}deg)`,
        opacity
      }}
    >
      <polygon
        points="50,10 70,90 50,70 30,90"
        className={cn(
          'transition-all duration-100',
          distance < 1 ? 'fill-green-500' :
          distance < 3 ? 'fill-yellow-500' :
          'fill-blue-500'
        )}
      />
      {/* Elevation indicator (above/below) */}
      {elevation > 15 && (
        <text x="50" y="50" textAnchor="middle" fill="white">ABOVE</text>
      )}
      {elevation < -15 && (
        <text x="50" y="50" textAnchor="middle" fill="white">BELOW</text>
      )}
    </svg>
  );
}
```

## Deep Dive: Anti-Stalking UI

### Unknown Tracker Alert

```tsx
function UnknownTrackerAlert({ notification }: { notification: TrackerNotification }) {
  const [showDetails, setShowDetails] = useState(false);
  const [showMap, setShowMap] = useState(false);

  const { sightingCount, firstSeen, locations } = notification.data;
  const duration = formatDuration(Date.now() - new Date(firstSeen).getTime());

  return (
    <div className="bg-amber-50 border-l-4 border-amber-400 p-4 rounded-r-lg">
      <div className="flex items-start">
        <AlertTriangleIcon className="w-6 h-6 text-amber-400 flex-shrink-0" />

        <div className="ml-3 flex-1">
          <h3 className="font-semibold text-amber-800">
            Unknown AirTag Found
          </h3>
          <p className="mt-1 text-amber-700">
            An AirTag has been detected traveling with you for {duration}.
            Seen at {sightingCount} locations.
          </p>

          {/* Action buttons */}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className="px-4 py-2 bg-amber-100 text-amber-800 rounded-lg
                         hover:bg-amber-200 transition-colors"
              onClick={() => setShowMap(true)}
            >
              View Locations
            </button>

            <button
              className="px-4 py-2 bg-amber-600 text-white rounded-lg
                         hover:bg-amber-700 transition-colors"
              onClick={() => playTrackerSound(notification.data.identifierHash)}
            >
              Play Sound
            </button>

            <button
              className="px-4 py-2 border border-amber-300 text-amber-800 rounded-lg
                         hover:bg-amber-50 transition-colors"
              onClick={() => setShowDetails(true)}
            >
              Learn More
            </button>
          </div>
        </div>

        {/* Dismiss */}
        <button
          className="ml-2 text-amber-400 hover:text-amber-600"
          onClick={() => dismissNotification(notification.id)}
          aria-label="Dismiss alert"
        >
          <XIcon className="w-5 h-5" />
        </button>
      </div>

      {/* Tracker location map modal */}
      <Modal open={showMap} onClose={() => setShowMap(false)}>
        <TrackerLocationMap locations={locations} />
      </Modal>

      {/* Details modal */}
      <Modal open={showDetails} onClose={() => setShowDetails(false)}>
        <TrackerHelpContent />
      </Modal>
    </div>
  );
}

function TrackerLocationMap({ locations }: { locations: GeoPoint[] }) {
  return (
    <div className="h-80">
      <MapContainer
        bounds={L.latLngBounds(locations.map(l => [l.lat, l.lon]))}
        className="h-full rounded-lg"
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        {/* Connect sightings with a line */}
        <Polyline
          positions={locations.map(l => [l.lat, l.lon])}
          color="red"
          weight={3}
          dashArray="5, 10"
        />

        {/* Mark each sighting location */}
        {locations.map((location, index) => (
          <CircleMarker
            key={index}
            center={[location.lat, location.lon]}
            radius={8}
            fillColor="red"
            fillOpacity={0.8}
            stroke={false}
          />
        ))}
      </MapContainer>

      <p className="mt-2 text-sm text-gray-600">
        Red dots show where the unknown AirTag was detected with you.
      </p>
    </div>
  );
}
```

## Deep Dive: Lost Mode Interface

### Enable Lost Mode Flow

```tsx
function LostModePanel({ device }: { device: RegisteredDevice }) {
  const [isEnabled, setIsEnabled] = useState(device.lostMode?.enabled ?? false);
  const [contactInfo, setContactInfo] = useState({
    phone: device.lostMode?.contactPhone ?? '',
    email: device.lostMode?.contactEmail ?? '',
    message: device.lostMode?.message ?? ''
  });

  const toggleLostMode = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (enabled) {
        return api.enableLostMode(device.id, contactInfo);
      } else {
        return api.disableLostMode(device.id);
      }
    },
    onSuccess: (_, enabled) => {
      setIsEnabled(enabled);
      if (enabled) {
        toast.success('Lost Mode enabled. You will be notified when found.');
      }
    }
  });

  return (
    <div className="bg-white rounded-xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Lost Mode</h2>
          <p className="text-gray-600">
            {isEnabled
              ? 'Anyone who finds this item can see your contact info'
              : 'Enable to share contact info with finders'}
          </p>
        </div>

        <Switch
          checked={isEnabled}
          onChange={(enabled) => toggleLostMode.mutate(enabled)}
          className={cn(
            'relative inline-flex h-8 w-14 items-center rounded-full transition-colors',
            isEnabled ? 'bg-green-500' : 'bg-gray-200'
          )}
        >
          <span className={cn(
            'inline-block h-6 w-6 transform rounded-full bg-white transition-transform',
            isEnabled ? 'translate-x-7' : 'translate-x-1'
          )} />
        </Switch>
      </div>

      {/* Contact info form */}
      <div className={cn(
        'space-y-4 transition-opacity',
        isEnabled ? 'opacity-100' : 'opacity-50 pointer-events-none'
      )}>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Phone Number
          </label>
          <input
            type="tel"
            value={contactInfo.phone}
            onChange={(e) => setContactInfo(prev => ({ ...prev, phone: e.target.value }))}
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="+1 (555) 123-4567"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Email Address
          </label>
          <input
            type="email"
            value={contactInfo.email}
            onChange={(e) => setContactInfo(prev => ({ ...prev, email: e.target.value }))}
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Message for Finder
          </label>
          <textarea
            value={contactInfo.message}
            onChange={(e) => setContactInfo(prev => ({ ...prev, message: e.target.value }))}
            className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
            rows={3}
            placeholder="If found, please contact me at..."
          />
        </div>

        <button
          className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium
                     hover:bg-blue-700 disabled:opacity-50"
          onClick={() => api.updateLostModeContact(device.id, contactInfo)}
          disabled={!isEnabled}
        >
          Save Contact Info
        </button>
      </div>
    </div>
  );
}
```

## Deep Dive: State Management

### Device and Location Store

```typescript
interface FindMyState {
  // Devices
  devices: Map<string, RegisteredDevice>;
  selectedDeviceId: string | null;
  isLoadingDevices: boolean;

  // Locations (decrypted)
  locations: Map<string, DecryptedLocation[]>;
  isDecrypting: boolean;
  decryptionProgress: number;

  // Notifications
  notifications: Notification[];
  unreadCount: number;

  // Actions
  selectDevice: (id: string | null) => void;
  refreshDevices: () => Promise<void>;
  fetchLocations: (deviceId: string, timeRange: TimeRange) => Promise<void>;
  markNotificationRead: (id: string) => void;
}

const useFindMyStore = create<FindMyState>((set, get) => ({
  devices: new Map(),
  selectedDeviceId: null,
  isLoadingDevices: false,
  locations: new Map(),
  isDecrypting: false,
  decryptionProgress: 0,
  notifications: [],
  unreadCount: 0,

  selectDevice: (id) => {
    set({ selectedDeviceId: id });

    // Auto-fetch locations for selected device
    if (id) {
      get().fetchLocations(id, {
        start: Date.now() - 7 * 24 * 60 * 60 * 1000,  // Last 7 days
        end: Date.now()
      });
    }
  },

  refreshDevices: async () => {
    set({ isLoadingDevices: true });
    try {
      const devices = await api.getDevices();
      set({
        devices: new Map(devices.map(d => [d.id, d])),
        isLoadingDevices: false
      });
    } catch (error) {
      set({ isLoadingDevices: false });
      throw error;
    }
  },

  fetchLocations: async (deviceId, timeRange) => {
    const device = get().devices.get(deviceId);
    if (!device) return;

    set({ isDecrypting: true, decryptionProgress: 0 });

    try {
      // Get master secret from secure storage
      const masterSecret = await secureStorage.get(`master_secret_${deviceId}`);
      const decryptionService = new FindMyDecryptionService(masterSecret);

      // Generate identifier hashes
      const hashes = await decryptionService.generateIdentifierHashes(timeRange);
      set({ decryptionProgress: 20 });

      // Fetch encrypted reports
      const reports = await api.queryReports(hashes, timeRange);
      set({ decryptionProgress: 50 });

      // Decrypt locally
      const decrypted = await decryptionService.decryptLocations(reports, timeRange);
      set({ decryptionProgress: 100 });

      // Update store
      set(state => {
        const newLocations = new Map(state.locations);
        newLocations.set(deviceId, decrypted);
        return { locations: newLocations, isDecrypting: false };
      });
    } catch (error) {
      set({ isDecrypting: false });
      throw error;
    }
  },

  markNotificationRead: (id) => {
    set(state => ({
      notifications: state.notifications.map(n =>
        n.id === id ? { ...n, isRead: true } : n
      ),
      unreadCount: Math.max(0, state.unreadCount - 1)
    }));
    api.markNotificationRead(id);
  }
}));
```

## Deep Dive: Offline Support

### Service Worker for Offline Viewing

```typescript
// sw.ts
const CACHE_NAME = 'findmy-v1';
const OFFLINE_ASSETS = [
  '/',
  '/devices',
  '/offline.html',
  '/static/map-tiles/'  // Pre-cached map tiles
];

// Cache device and location data for offline viewing
self.addEventListener('message', (event) => {
  if (event.data.type === 'CACHE_LOCATIONS') {
    const { deviceId, locations } = event.data;
    caches.open(CACHE_NAME).then(cache => {
      cache.put(
        `/api/v1/devices/${deviceId}/locations`,
        new Response(JSON.stringify(locations))
      );
    });
  }
});

// Serve cached data when offline
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/v1/devices')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache successful responses
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(() => {
          // Serve from cache when offline
          return caches.match(event.request);
        })
    );
  }
});
```

### Offline Indicator Component

```tsx
function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 bg-amber-100 border border-amber-300
                    rounded-lg p-3 flex items-center gap-3 shadow-lg z-50">
      <WifiOffIcon className="w-5 h-5 text-amber-600" />
      <div className="flex-1">
        <p className="font-medium text-amber-800">You're offline</p>
        <p className="text-sm text-amber-600">
          Showing last known locations from{' '}
          {lastSynced ? formatRelativeTime(lastSynced) : 'cache'}
        </p>
      </div>
    </div>
  );
}
```

## Accessibility Considerations

### Screen Reader Support for Map

```tsx
function AccessibleDeviceList({ devices }: { devices: DeviceLocation[] }) {
  return (
    <div role="region" aria-label="Your devices">
      <h2 id="devices-heading" className="sr-only">Device Locations</h2>

      <ul aria-labelledby="devices-heading" role="listbox">
        {devices.map(device => (
          <li
            key={device.deviceId}
            role="option"
            aria-selected={false}
            className="p-4 border-b hover:bg-gray-50 cursor-pointer"
            onClick={() => selectDevice(device.deviceId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                selectDevice(device.deviceId);
              }
            }}
            tabIndex={0}
          >
            <span className="font-medium">{device.name}</span>
            <span className="sr-only">
              {device.isRecent
                ? `Located now at ${formatAddress(device)}`
                : `Last seen ${formatTimeAgo(device.timestamp)} at ${formatAddress(device)}`}
            </span>
            <span aria-hidden="true" className="text-gray-500 text-sm block">
              {formatTimeAgo(device.timestamp)}
            </span>
          </li>
        ))}
      </ul>

      {/* Live region for location updates */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {/* Announce location updates */}
      </div>
    </div>
  );
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Client-side decryption | WebCrypto API | Server decryption | Privacy - server never sees locations |
| Leaflet for maps | Native MapKit | Cross-platform, open source |
| Zustand for state | Redux | Simpler for moderate complexity |
| Service Worker caching | No offline | Critical for lost device scenarios |
| Progressive disclosure | Show all | Avoid information overload |

## Future Frontend Enhancements

1. **AR Precision Finding**: Camera-based augmented reality overlay
2. **Widgets**: Home screen widgets for quick device status
3. **Family Sharing UI**: View shared devices with permissions
4. **History Timeline**: Playback of device movement over time
5. **Accessibility Audit**: Full WCAG 2.1 AA compliance
6. **Dark Mode**: System-aware theme switching
