# Design Twitch - Live Streaming Platform

## Overview

A simplified Twitch-like platform demonstrating live video streaming, real-time chat at scale, subscription systems, and VOD storage. This educational project focuses on building a live broadcasting system with interactive viewer experiences.

## Key Features

### 1. Live Streaming
- Stream ingestion (RTMP)
- Transcoding to multiple qualities
- Low-latency delivery (< 5 seconds)
- Adaptive bitrate streaming

### 2. Chat System
- Real-time chat per stream
- Chat at scale (100K+ concurrent)
- Emotes and badges
- Moderation tools (bans, timeouts)

### 3. Channel Management
- Streamer profiles and schedules
- Stream titles and categories
- Follower and subscriber systems
- Channel customization

### 4. VOD & Clips
- Automatic VOD recording
- Clip creation from live streams
- Highlight reels
- Video-on-demand playback

### 5. Monetization
- Subscriptions (tiers)
- Bits (virtual currency)
- Ads and sponsorships
- Creator payouts

## Implementation Status

- [ ] Initial architecture design
- [ ] Stream ingestion server
- [ ] Transcoding pipeline
- [ ] Live video delivery (HLS/DASH)
- [ ] Real-time chat system
- [ ] Channel and user management
- [ ] VOD recording and playback
- [ ] Subscription system
- [ ] Local multi-instance testing
- [ ] Documentation

## Key Technical Challenges

1. **Low-Latency Streaming**: Minimizing delay from broadcaster to viewer
2. **Chat at Scale**: Handling millions of messages per minute
3. **Stream Ingestion**: Reliably accepting streams from various encoders
4. **Transcoding**: Real-time encoding to multiple quality levels
5. **Global Distribution**: Edge delivery for viewers worldwide

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## Streaming Pipeline Overview

```
Broadcaster (OBS)
     │
     │ RTMP
     ▼
┌─────────────┐
│ Ingest Node │ ──▶ Validate stream key
└─────────────┘
     │
     │ Raw stream
     ▼
┌─────────────┐
│ Transcoder  │ ──▶ 1080p, 720p, 480p, 360p
└─────────────┘
     │
     │ HLS segments
     ▼
┌─────────────┐
│  Origin     │ ──▶ Segment storage
└─────────────┘
     │
     │ CDN pull
     ▼
┌─────────────┐
│  CDN Edge   │ ──▶ Viewer playback
└─────────────┘
```
