# Apple TV+ - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design a complete premium video streaming platform that:
- Ingests master files and transcodes to multiple quality variants
- Delivers adaptive bitrate streaming with < 2s playback start
- Provides a cinematic browsing and viewing experience
- Synchronizes watch progress across devices

## Requirements Clarification

### Functional Requirements
1. **Ingest**: Accept 4K HDR masters and encode to 10+ variants
2. **Browse**: Discover content through hero banners, rows, and search
3. **Watch**: Stream with adaptive quality and DRM protection
4. **Sync**: Resume playback position across all devices
5. **Profiles**: Family sharing with individual profiles

### Non-Functional Requirements
1. **Latency**: < 2s time to first frame
2. **Quality**: Support 4K HDR with Dolby Vision
3. **Availability**: 99.99% for streaming
4. **Scale**: Millions of concurrent streams

### Scale Estimates
- Thousands of movies and shows
- Millions of subscribers worldwide
- Each title: 10+ encoded variants
- Petabytes of video content

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Client Applications                              │
│     React + HLS.js (Web) │ Swift/AVPlayer (iOS/tvOS) │ Kotlin (Android) │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              CDN Edge                                    │
│          Video Segments │ Manifests │ Images │ DRM Licenses             │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Load Balancer                                  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
            ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
            │ API Server  │  │ API Server  │  │ API Server  │
            │   (Node)    │  │   (Node)    │  │   (Node)    │
            └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
                   │                │                │
        ┌──────────┴────────────────┴────────────────┴──────────┐
        │                                                        │
        ▼                ▼                ▼                     ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PostgreSQL  │ │    Valkey    │ │   RabbitMQ   │ │    MinIO     │
│   (Primary)  │ │   (Cache)    │ │   (Queue)    │ │  (Storage)   │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

## Deep Dive: Shared Type Definitions

### Content Types

```typescript
// shared/types/content.ts

export interface Content {
    id: string;
    title: string;
    description: string;
    duration: number;  // seconds
    releaseYear: number;
    rating: string;
    genres: string[];
    contentType: 'movie' | 'series' | 'episode';
    seriesId?: string;
    seasonNumber?: number;
    episodeNumber?: number;

    // Media info
    masterResolution: string;
    hdrFormat: 'dolby_vision' | 'hdr10' | 'hdr10plus' | null;
    hasAtmos: boolean;

    // URLs
    posterUrl: string;
    thumbnailUrl: string;
    heroImageUrl: string;
    logoUrl?: string;

    // Status
    status: 'processing' | 'ready' | 'error';
    createdAt: string;
}

export interface EncodedVariant {
    id: string;
    contentId: string;
    resolution: number;  // height in pixels
    codec: 'hevc' | 'h264';
    hdr: boolean;
    bitrate: number;  // kbps
    filePath: string;
    fileSize: number;  // bytes
}

export interface WatchProgress {
    profileId: string;
    contentId: string;
    position: number;  // seconds
    duration: number;
    completed: boolean;
    clientTimestamp: number;
    updatedAt: string;
}
```

### API Types

```typescript
// shared/types/api.ts

export interface PlaybackSession {
    manifestUrl: string;
    playbackToken: string;
    licenseUrl: string;
    qualities: QualityLevel[];
    resumePosition: number;
}

export interface QualityLevel {
    height: number;
    bitrate: number;
    codec: string;
    hdr: boolean;
}

export interface ProgressUpdateRequest {
    contentId: string;
    position: number;
    duration: number;
    clientTimestamp: number;
}

export interface ProgressUpdateResponse {
    success: boolean;
    wasUpdated: boolean;
    serverTimestamp: number;
}

export interface ContentListResponse {
    items: Content[];
    total: number;
    page: number;
    pageSize: number;
}

export interface RecommendationsResponse {
    sections: RecommendationSection[];
}

export interface RecommendationSection {
    title: string;
    type: 'continue_watching' | 'trending' | 'personalized' | 'new';
    items: Content[];
}
```

## Deep Dive: API Layer Integration

### API Client Service

```typescript
// frontend/src/services/api.ts

const API_BASE = '/api';

class ApiClient {
    private token: string | null = null;

    setToken(token: string) {
        this.token = token;
    }

    private async request<T>(
        method: string,
        path: string,
        body?: object,
        options: RequestInit = {}
    ): Promise<T> {
        const headers: HeadersInit = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        // Add idempotency key for mutations
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
            headers['Idempotency-Key'] = crypto.randomUUID();
        }

        const response = await fetch(`${API_BASE}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            credentials: 'include',
            ...options
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new ApiError(response.status, error.message || 'Request failed');
        }

        return response.json();
    }

    // Auth
    async login(username: string, password: string) {
        return this.request<{ user: User; profiles: Profile[] }>(
            'POST', '/auth/login', { username, password }
        );
    }

    async logout() {
        return this.request<void>('POST', '/auth/logout');
    }

    // Profiles
    async getProfiles() {
        return this.request<Profile[]>('GET', '/profiles');
    }

    async selectProfile(profileId: string) {
        return this.request<{ token: string }>(
            'POST', `/profiles/${profileId}/select`
        );
    }

    // Content
    async getContent(id: string) {
        return this.request<Content>('GET', `/content/${id}`);
    }

    async getContentList(params: ContentQueryParams) {
        const query = new URLSearchParams(params as Record<string, string>);
        return this.request<ContentListResponse>(
            'GET', `/content?${query}`
        );
    }

    async getRecommendations(profileId: string) {
        return this.request<RecommendationsResponse>(
            'GET', `/profiles/${profileId}/recommendations`
        );
    }

    // Playback
    async getPlaybackSession(contentId: string) {
        return this.request<PlaybackSession>(
            'POST', `/stream/${contentId}/session`
        );
    }

    // Watch Progress
    async updateProgress(data: ProgressUpdateRequest) {
        return this.request<ProgressUpdateResponse>(
            'POST', '/watch/progress', data
        );
    }

    async getContinueWatching(profileId: string) {
        return this.request<Content[]>(
            'GET', `/profiles/${profileId}/continue-watching`
        );
    }
}

export const api = new ApiClient();
```

### Backend Route Implementation

```typescript
// backend/src/routes/streaming.ts

import express from 'express';
import { z } from 'zod';
import { db, valkey, metrics } from '../shared/index.js';
import { requireProfile } from '../middleware/auth.js';

const router = express.Router();

/**
 * Create playback session and get manifest URL
 */
router.post('/:contentId/session', requireProfile, async (req, res) => {
    const { contentId } = req.params;
    const { profileId, userId } = req.session;

    const startTime = Date.now();

    try {
        // Check content exists and is ready
        const content = await db.query(`
            SELECT id, duration, status FROM content WHERE id = $1
        `, [contentId]);

        if (content.rows.length === 0) {
            return res.status(404).json({ error: 'Content not found' });
        }

        if (content.rows[0].status !== 'ready') {
            return res.status(400).json({ error: 'Content not available' });
        }

        // Get encoded variants
        const variants = await db.query(`
            SELECT resolution, codec, hdr, bitrate
            FROM encoded_variants
            WHERE content_id = $1
            ORDER BY resolution DESC, bitrate DESC
        `, [contentId]);

        // Get saved progress
        const progress = await db.query(`
            SELECT position FROM watch_progress
            WHERE profile_id = $1 AND content_id = $2
        `, [profileId, contentId]);

        // Generate signed playback token
        const playbackToken = await generatePlaybackToken({
            contentId,
            userId,
            profileId,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000
        });

        // Build response
        const session: PlaybackSession = {
            manifestUrl: `/api/stream/${contentId}/master.m3u8`,
            playbackToken,
            licenseUrl: '/api/drm/license',
            qualities: variants.rows.map(v => ({
                height: v.resolution,
                bitrate: v.bitrate,
                codec: v.codec,
                hdr: v.hdr
            })),
            resumePosition: progress.rows[0]?.position || 0
        };

        metrics.playbackSessionCreated.inc({ content_type: content.rows[0].content_type });
        metrics.playbackStartLatency.observe(
            { device_type: req.headers['x-device-type'] || 'unknown' },
            (Date.now() - startTime) / 1000
        );

        res.json(session);
    } catch (error) {
        metrics.streamingErrors.inc({ error_type: 'session_creation' });
        throw error;
    }
});

/**
 * Generate HLS master manifest
 */
router.get('/:contentId/master.m3u8', requireProfile, async (req, res) => {
    const { contentId } = req.params;

    // Check cache first
    const cacheKey = `manifest:${contentId}:master`;
    const cached = await valkey.get(cacheKey);
    if (cached) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(cached);
    }

    // Get variants
    const variants = await db.query(`
        SELECT resolution, codec, hdr, bitrate
        FROM encoded_variants
        WHERE content_id = $1
        ORDER BY resolution DESC, bitrate DESC
    `, [contentId]);

    // Get audio tracks
    const audioTracks = await db.query(`
        SELECT language, name, codec FROM audio_tracks
        WHERE content_id = $1
    `, [contentId]);

    // Build manifest
    let manifest = '#EXTM3U\n#EXT-X-VERSION:6\n\n';

    // Audio groups
    for (const audio of audioTracks.rows) {
        manifest += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",`;
        manifest += `LANGUAGE="${audio.language}",NAME="${audio.name}",`;
        manifest += `URI="audio/${audio.language}.m3u8"\n`;
    }

    manifest += '\n';

    // Video variants
    for (const variant of variants.rows) {
        const bandwidth = variant.bitrate * 1000;
        const width = Math.round(variant.resolution * (16 / 9));
        const resolution = `${width}x${variant.resolution}`;
        const codecs = getCodecString(variant);

        manifest += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},`;
        manifest += `RESOLUTION=${resolution},CODECS="${codecs}",`;
        manifest += `AUDIO="audio"\n`;
        manifest += `${variant.resolution}_${variant.bitrate}.m3u8\n`;
    }

    // Cache for 1 hour
    await valkey.setex(cacheKey, 3600, manifest);

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(manifest);
});

function getCodecString(variant: EncodedVariant): string {
    if (variant.codec === 'hevc' && variant.hdr) {
        return 'hvc1.2.4.L150.B0,mp4a.40.2';
    } else if (variant.codec === 'hevc') {
        return 'hvc1.1.6.L150.90,mp4a.40.2';
    }
    return 'avc1.640029,mp4a.40.2';
}

export default router;
```

## Deep Dive: Watch Progress Synchronization

### Frontend Store Integration

```typescript
// frontend/src/stores/playerStore.ts

interface PlayerState {
    contentId: string | null;
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    lastSyncedTime: number;

    // Actions
    updateTime: (time: number) => void;
    syncProgress: () => Promise<void>;
}

export const usePlayerStore = create<PlayerState>()((set, get) => ({
    contentId: null,
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    lastSyncedTime: 0,

    updateTime: (time: number) => {
        set({ currentTime: time });

        // Sync every 30 seconds of playback
        const { lastSyncedTime, syncProgress } = get();
        if (time - lastSyncedTime >= 30) {
            syncProgress();
        }
    },

    syncProgress: async () => {
        const { contentId, currentTime, duration } = get();
        if (!contentId) return;

        try {
            const response = await api.updateProgress({
                contentId,
                position: Math.floor(currentTime),
                duration: Math.floor(duration),
                clientTimestamp: Date.now()
            });

            set({ lastSyncedTime: currentTime });

            // Update content store with new progress
            useContentStore.getState().updateProgress(
                contentId,
                currentTime,
                duration
            );
        } catch (error) {
            console.error('Failed to sync progress:', error);
            // Will retry on next interval
        }
    }
}));
```

### Backend Progress Handler

```typescript
// backend/src/routes/watchProgress.ts

import express from 'express';
import { z } from 'zod';
import { db, valkey, metrics } from '../shared/index.js';
import { requireProfile } from '../middleware/auth.js';

const router = express.Router();

const progressSchema = z.object({
    contentId: z.string().uuid(),
    position: z.number().int().min(0),
    duration: z.number().int().min(0),
    clientTimestamp: z.number().int()
});

/**
 * Update watch progress with last-write-wins conflict resolution
 */
router.post('/progress', requireProfile, async (req, res) => {
    const { profileId } = req.session;
    const validation = progressSchema.safeParse(req.body);

    if (!validation.success) {
        return res.status(400).json({
            error: 'Invalid request',
            details: validation.error.issues
        });
    }

    const { contentId, position, duration, clientTimestamp } = validation.data;

    try {
        // Last-write-wins update
        const result = await db.query(`
            INSERT INTO watch_progress
                (profile_id, content_id, position, duration,
                 client_timestamp, completed, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (profile_id, content_id)
            DO UPDATE SET
                position = CASE
                    WHEN watch_progress.client_timestamp < EXCLUDED.client_timestamp
                    THEN EXCLUDED.position
                    ELSE watch_progress.position
                END,
                duration = EXCLUDED.duration,
                client_timestamp = GREATEST(
                    watch_progress.client_timestamp,
                    EXCLUDED.client_timestamp
                ),
                completed = CASE
                    WHEN watch_progress.client_timestamp < EXCLUDED.client_timestamp
                        AND EXCLUDED.position::float / EXCLUDED.duration > 0.9
                    THEN true
                    ELSE watch_progress.completed
                END,
                updated_at = NOW()
            RETURNING
                position,
                (watch_progress.client_timestamp < $5) AS was_updated
        `, [
            profileId,
            contentId,
            position,
            duration,
            clientTimestamp,
            position / duration > 0.9
        ]);

        const wasUpdated = result.rows[0]?.was_updated ?? true;

        // Invalidate continue watching cache
        await valkey.del(`continue:${profileId}`);

        // Track metrics
        metrics.watchProgressUpdates.inc({
            result: wasUpdated ? 'updated' : 'stale'
        });

        res.json({
            success: true,
            wasUpdated,
            serverTimestamp: Date.now()
        });
    } catch (error) {
        metrics.watchProgressUpdates.inc({ result: 'error' });
        throw error;
    }
});

/**
 * Get continue watching list
 */
router.get('/continue', requireProfile, async (req, res) => {
    const { profileId } = req.session;

    // Check cache
    const cacheKey = `continue:${profileId}`;
    const cached = await valkey.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }

    const result = await db.query(`
        SELECT
            c.id, c.title, c.thumbnail_url, c.duration,
            c.content_type, c.series_id,
            wp.position,
            ROUND((wp.position::float / c.duration) * 100) AS progress_pct
        FROM watch_progress wp
        JOIN content c ON c.id = wp.content_id
        WHERE wp.profile_id = $1
          AND wp.position > 60
          AND NOT wp.completed
          AND (wp.position::float / c.duration) < 0.9
        ORDER BY wp.updated_at DESC
        LIMIT 20
    `, [profileId]);

    const items = result.rows.map(row => ({
        ...row,
        remainingMinutes: Math.round((row.duration - row.position) / 60)
    }));

    // Cache for 5 minutes
    await valkey.setex(cacheKey, 300, JSON.stringify(items));

    res.json(items);
});

/**
 * Batch sync progress (for offline-to-online sync)
 */
router.post('/progress/batch', requireProfile, async (req, res) => {
    const { profileId } = req.session;
    const { updates } = req.body;

    if (!Array.isArray(updates) || updates.length > 50) {
        return res.status(400).json({
            error: 'Invalid batch: max 50 updates allowed'
        });
    }

    const results = [];

    for (const update of updates) {
        const validation = progressSchema.safeParse(update);
        if (!validation.success) {
            results.push({
                contentId: update.contentId,
                success: false,
                error: 'Invalid data'
            });
            continue;
        }

        try {
            await db.query(`
                INSERT INTO watch_progress
                    (profile_id, content_id, position, duration,
                     client_timestamp, updated_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT (profile_id, content_id)
                DO UPDATE SET
                    position = CASE
                        WHEN watch_progress.client_timestamp < EXCLUDED.client_timestamp
                        THEN EXCLUDED.position
                        ELSE watch_progress.position
                    END,
                    client_timestamp = GREATEST(
                        watch_progress.client_timestamp,
                        EXCLUDED.client_timestamp
                    ),
                    updated_at = NOW()
            `, [
                profileId,
                validation.data.contentId,
                validation.data.position,
                validation.data.duration,
                validation.data.clientTimestamp
            ]);

            results.push({
                contentId: validation.data.contentId,
                success: true
            });
        } catch (error) {
            results.push({
                contentId: validation.data.contentId,
                success: false,
                error: 'Database error'
            });
        }
    }

    // Invalidate continue watching cache
    await valkey.del(`continue:${profileId}`);

    res.json({ results });
});

export default router;
```

## Deep Dive: HLS Player Integration

### Video Player with HLS.js

```typescript
// frontend/src/components/player/VideoPlayer.tsx

import Hls from 'hls.js';
import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { api } from '../../services/api';

export function VideoPlayer() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);

    const {
        contentId,
        currentTime,
        isPlaying,
        quality,
        updateTime,
        syncProgress,
        setAvailableQualities
    } = usePlayerStore();

    // Initialize HLS player
    useEffect(() => {
        if (!videoRef.current || !contentId) return;

        async function initPlayer() {
            // Get playback session from API
            const session = await api.getPlaybackSession(contentId!);

            if (Hls.isSupported()) {
                const hls = new Hls({
                    enableWorker: true,
                    lowLatencyMode: false,
                    backBufferLength: 90,
                    maxBufferLength: 30,
                    maxMaxBufferLength: 600,
                    xhrSetup: (xhr, url) => {
                        // Add auth token to segment requests
                        xhr.setRequestHeader(
                            'Authorization',
                            `Bearer ${session.playbackToken}`
                        );
                    }
                });

                hls.loadSource(session.manifestUrl);
                hls.attachMedia(videoRef.current!);

                // Handle manifest parsed
                hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                    setAvailableQualities(data.levels.map(level => ({
                        height: level.height,
                        bitrate: level.bitrate,
                        codec: level.videoCodec || 'h264'
                    })));

                    // Resume from saved position
                    if (session.resumePosition > 0) {
                        videoRef.current!.currentTime = session.resumePosition;
                    }

                    videoRef.current!.play();
                });

                // Handle quality switch
                hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
                    const level = hls.levels[data.level];
                    console.log(`Quality switched to ${level.height}p`);
                });

                // Handle errors
                hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                hls.recoverMediaError();
                                break;
                            default:
                                console.error('Fatal HLS error:', data);
                                break;
                        }
                    }
                });

                hlsRef.current = hls;
            } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
                // Native HLS support (Safari)
                videoRef.current.src = session.manifestUrl;
                videoRef.current.currentTime = session.resumePosition;
                videoRef.current.play();
            }
        }

        initPlayer();

        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
            }
        };
    }, [contentId]);

    // Handle quality change
    useEffect(() => {
        if (!hlsRef.current) return;

        if (quality === 'auto') {
            hlsRef.current.currentLevel = -1;  // Auto
        } else {
            const levelIndex = hlsRef.current.levels.findIndex(
                level => level.height === quality.height
            );
            if (levelIndex >= 0) {
                hlsRef.current.currentLevel = levelIndex;
            }
        }
    }, [quality]);

    // Save progress on unmount
    useEffect(() => {
        return () => {
            syncProgress();
        };
    }, [syncProgress]);

    return (
        <video
            ref={videoRef}
            className="w-full h-full object-contain bg-black"
            playsInline
            onTimeUpdate={(e) => updateTime(e.currentTarget.currentTime)}
            onPlay={() => usePlayerStore.setState({ isPlaying: true })}
            onPause={() => usePlayerStore.setState({ isPlaying: false })}
            onEnded={() => syncProgress()}
        />
    );
}
```

## Deep Dive: Profile Management

### Frontend Profile Selector

```typescript
// frontend/src/components/ProfileSelector.tsx

import { motion } from 'framer-motion';
import { useAuthStore } from '../stores/authStore';
import { useNavigate } from '@tanstack/react-router';

export function ProfileSelector() {
    const { profiles, selectProfile } = useAuthStore();
    const navigate = useNavigate();

    const handleSelectProfile = async (profileId: string) => {
        await selectProfile(profileId);
        navigate({ to: '/' });
    };

    return (
        <div className="min-h-screen bg-apple-gray-900 flex flex-col
                       items-center justify-center p-8">
            <h1 className="text-3xl font-semibold text-white mb-12">
                Who's Watching?
            </h1>

            <div className="flex flex-wrap justify-center gap-8 max-w-4xl">
                {profiles.map((profile, index) => (
                    <motion.button
                        key={profile.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.1 }}
                        onClick={() => handleSelectProfile(profile.id)}
                        className="flex flex-col items-center group"
                    >
                        <div className={`w-32 h-32 rounded-lg overflow-hidden
                                        border-4 border-transparent
                                        group-hover:border-white transition-colors
                                        ${profile.isKids ? 'ring-2 ring-green-500' : ''}`}>
                            <img
                                src={profile.avatarUrl}
                                alt={profile.name}
                                className="w-full h-full object-cover"
                            />
                        </div>

                        <span className="mt-3 text-lg text-white/70
                                        group-hover:text-white transition-colors">
                            {profile.name}
                        </span>

                        {profile.isKids && (
                            <span className="mt-1 text-xs text-green-500">
                                Kids
                            </span>
                        )}
                    </motion.button>
                ))}

                {/* Add Profile button */}
                {profiles.length < 6 && (
                    <motion.button
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: profiles.length * 0.1 }}
                        onClick={() => navigate({ to: '/profiles/new' })}
                        className="flex flex-col items-center group"
                    >
                        <div className="w-32 h-32 rounded-lg bg-apple-gray-800
                                       flex items-center justify-center
                                       border-4 border-transparent
                                       group-hover:border-white transition-colors">
                            <PlusIcon className="w-12 h-12 text-white/50
                                                group-hover:text-white transition-colors" />
                        </div>

                        <span className="mt-3 text-lg text-white/70
                                        group-hover:text-white transition-colors">
                            Add Profile
                        </span>
                    </motion.button>
                )}
            </div>
        </div>
    );
}
```

### Backend Profile Routes

```typescript
// backend/src/routes/profiles.ts

import express from 'express';
import { z } from 'zod';
import { db, valkey } from '../shared/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const createProfileSchema = z.object({
    name: z.string().min(1).max(50),
    avatarUrl: z.string().url().optional(),
    isKids: z.boolean().optional().default(false)
});

/**
 * List user's profiles
 */
router.get('/', requireAuth, async (req, res) => {
    const { userId } = req.session;

    const result = await db.query(`
        SELECT id, name, avatar_url, is_kids, created_at
        FROM profiles
        WHERE user_id = $1
        ORDER BY created_at
    `, [userId]);

    res.json(result.rows.map(row => ({
        id: row.id,
        name: row.name,
        avatarUrl: row.avatar_url,
        isKids: row.is_kids,
        createdAt: row.created_at
    })));
});

/**
 * Create new profile
 */
router.post('/', requireAuth, async (req, res) => {
    const { userId } = req.session;
    const validation = createProfileSchema.safeParse(req.body);

    if (!validation.success) {
        return res.status(400).json({
            error: 'Invalid request',
            details: validation.error.issues
        });
    }

    const { name, avatarUrl, isKids } = validation.data;

    // Check profile limit
    const countResult = await db.query(`
        SELECT COUNT(*) as count FROM profiles WHERE user_id = $1
    `, [userId]);

    if (parseInt(countResult.rows[0].count) >= 6) {
        return res.status(400).json({
            error: 'Maximum 6 profiles allowed'
        });
    }

    const result = await db.query(`
        INSERT INTO profiles (user_id, name, avatar_url, is_kids)
        VALUES ($1, $2, $3, $4)
        RETURNING id, name, avatar_url, is_kids, created_at
    `, [userId, name, avatarUrl || '/avatars/default.png', isKids]);

    res.status(201).json({
        id: result.rows[0].id,
        name: result.rows[0].name,
        avatarUrl: result.rows[0].avatar_url,
        isKids: result.rows[0].is_kids,
        createdAt: result.rows[0].created_at
    });
});

/**
 * Select profile (set in session)
 */
router.post('/:profileId/select', requireAuth, async (req, res) => {
    const { userId } = req.session;
    const { profileId } = req.params;

    // Verify profile belongs to user
    const result = await db.query(`
        SELECT id, name, is_kids FROM profiles
        WHERE id = $1 AND user_id = $2
    `, [profileId, userId]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Profile not found' });
    }

    // Update session with profile
    req.session.profileId = profileId;
    req.session.isKidsProfile = result.rows[0].is_kids;

    res.json({
        success: true,
        profile: {
            id: result.rows[0].id,
            name: result.rows[0].name,
            isKids: result.rows[0].is_kids
        }
    });
});

/**
 * Get profile recommendations
 */
router.get('/:profileId/recommendations', requireAuth, async (req, res) => {
    const { profileId } = req.params;
    const { userId } = req.session;

    // Verify profile belongs to user
    const profile = await db.query(`
        SELECT id, is_kids FROM profiles
        WHERE id = $1 AND user_id = $2
    `, [profileId, userId]);

    if (profile.rows.length === 0) {
        return res.status(404).json({ error: 'Profile not found' });
    }

    const isKids = profile.rows[0].is_kids;

    // Build recommendation sections
    const sections: RecommendationSection[] = [];

    // Continue watching
    const continueWatching = await getContinueWatching(profileId);
    if (continueWatching.length > 0) {
        sections.push({
            title: 'Continue Watching',
            type: 'continue_watching',
            items: continueWatching
        });
    }

    // Trending now
    const trending = await getTrending(isKids);
    sections.push({
        title: 'Trending Now',
        type: 'trending',
        items: trending
    });

    // New releases
    const newReleases = await getNewReleases(isKids);
    sections.push({
        title: 'New Releases',
        type: 'new',
        items: newReleases
    });

    // Personalized (based on watch history)
    const personalized = await getPersonalized(profileId, isKids);
    if (personalized.length > 0) {
        sections.push({
            title: 'Because You Watched...',
            type: 'personalized',
            items: personalized
        });
    }

    res.json({ sections });
});

export default router;
```

## API Design Summary

### Endpoints

```
Authentication:
POST   /api/auth/login              Login with credentials
POST   /api/auth/logout             Logout and clear session

Profiles:
GET    /api/profiles                List user's profiles
POST   /api/profiles                Create new profile
POST   /api/profiles/:id/select     Select profile for session
GET    /api/profiles/:id/recommendations  Get personalized recommendations

Content:
GET    /api/content                 List content (with pagination)
GET    /api/content/:id             Get content details

Streaming:
POST   /api/stream/:contentId/session     Create playback session
GET    /api/stream/:contentId/master.m3u8 Get HLS master manifest
GET    /api/stream/:contentId/:variant.m3u8  Get variant playlist
POST   /api/drm/license             Request DRM license

Watch Progress:
POST   /api/watch/progress          Update watch progress
GET    /api/watch/continue          Get continue watching list
POST   /api/watch/progress/batch    Batch sync progress

Admin:
POST   /api/admin/content           Upload new content
GET    /api/admin/content/:id/status   Check transcoding status
POST   /api/admin/content/:id/publish  Publish content
```

## Caching Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                      Cache Layers                                │
├─────────────────────────────────────────────────────────────────┤
│  CDN Edge (24h)                                                  │
│  - Video segments (.ts files)                                    │
│  - Images (posters, thumbnails)                                  │
├─────────────────────────────────────────────────────────────────┤
│  CDN Edge (1h)                                                   │
│  - HLS manifests (.m3u8)                                         │
├─────────────────────────────────────────────────────────────────┤
│  Valkey (5min)                                                   │
│  - Continue watching lists                                       │
│  - Recommendations                                               │
│  - Content metadata                                              │
├─────────────────────────────────────────────────────────────────┤
│  Valkey (7 days)                                                 │
│  - User sessions                                                 │
│  - Idempotency keys (24h)                                        │
└─────────────────────────────────────────────────────────────────┘
```

## Error Handling Pattern

### Backend Error Handler

```typescript
// backend/src/middleware/errorHandler.ts

export function errorHandler(
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
) {
    // Log error
    logger.error({
        error: err.message,
        stack: err.stack,
        requestId: req.id,
        userId: req.session?.userId,
        path: req.path
    });

    // Track metrics
    metrics.httpErrors.inc({
        path: req.route?.path || req.path,
        status: err instanceof ApiError ? err.statusCode : 500
    });

    // Send response
    if (err instanceof ApiError) {
        return res.status(err.statusCode).json({
            error: err.message,
            code: err.code
        });
    }

    // Don't leak internal errors
    res.status(500).json({
        error: 'Internal server error',
        requestId: req.id
    });
}
```

### Frontend Error Boundary

```typescript
// frontend/src/components/ErrorBoundary.tsx

export function ErrorBoundary({ children }: { children: React.ReactNode }) {
    return (
        <ReactErrorBoundary
            fallbackRender={({ error, resetErrorBoundary }) => (
                <div className="min-h-screen bg-apple-gray-900 flex flex-col
                               items-center justify-center p-8 text-center">
                    <ExclamationIcon className="w-16 h-16 text-red-500 mb-4" />
                    <h1 className="text-2xl font-semibold text-white mb-2">
                        Something went wrong
                    </h1>
                    <p className="text-white/70 mb-6 max-w-md">
                        {error.message}
                    </p>
                    <button
                        onClick={resetErrorBoundary}
                        className="px-6 py-3 bg-white text-black font-semibold
                                  rounded-lg hover:bg-white/90 transition-colors"
                    >
                        Try Again
                    </button>
                </div>
            )}
        >
            {children}
        </ReactErrorBoundary>
    );
}
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Session-based auth | Simple, secure cookies | Server-side state |
| PostgreSQL for all data | ACID, joins, familiar | Write scaling limits |
| HLS over DASH | Native Apple support | Less efficient |
| Last-write-wins sync | Low latency, simple | Potential stale data |
| Zod validation | Runtime type safety | Extra bundle size |
| Zustand over Redux | Less boilerplate | Smaller ecosystem |
| Separate profile sessions | Better isolation | More API calls |

## Future Fullstack Enhancements

1. **GraphQL API**: Better data fetching flexibility
2. **WebSocket Progress**: Real-time cross-device sync
3. **Offline Mode**: Service worker with IndexedDB
4. **SSR/Streaming**: React Server Components
5. **Multi-Region**: Global deployment with data locality
6. **Feature Flags**: Gradual rollout of new features
