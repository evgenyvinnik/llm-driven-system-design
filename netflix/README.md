# Design Netflix - Video Streaming Platform

## Overview

A simplified Netflix-like platform demonstrating video streaming, adaptive bitrate delivery, content personalization, and A/B testing infrastructure. This educational project focuses on building a video streaming service with sophisticated recommendation and experimentation systems.

## Key Features

### 1. Video Catalog
- Movies and TV series
- Seasons and episodes
- Metadata management
- Content licensing

### 2. Video Streaming
- Adaptive bitrate streaming (ABR)
- Multiple quality levels
- DRM protection
- Cross-device resume

### 3. Personalization
- Personalized homepage rows
- Continue watching
- "Because you watched..."
- Top 10 lists

### 4. A/B Testing
- Feature experimentation
- Artwork testing
- Algorithm variations
- Statistical analysis

### 5. Profiles
- Multiple user profiles
- Kids profile restrictions
- Viewing history per profile
- Profile preferences

## Implementation Status

- [ ] Initial architecture design
- [ ] Video catalog management
- [ ] Adaptive streaming pipeline
- [ ] Profile system
- [ ] Recommendation engine
- [ ] A/B testing framework
- [ ] Analytics and reporting
- [ ] Documentation

## Key Technical Challenges

1. **ABR Streaming**: Seamless quality adaptation based on bandwidth
2. **Personalization**: Generating unique homepages for 200M+ users
3. **Content Encoding**: Optimizing encoding for different devices
4. **A/B Testing**: Running thousands of concurrent experiments
5. **Global Delivery**: CDN optimization for worldwide streaming

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.
