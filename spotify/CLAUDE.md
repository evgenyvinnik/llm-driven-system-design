# Design Spotify - Development with Claude

## Project Context

Building a music streaming platform to understand audio delivery, recommendation systems, and offline synchronization.

**Key Learning Goals:**
- Build audio streaming with CDN
- Design recommendation engines (collaborative + content)
- Implement offline download with DRM
- Handle playback analytics for royalties

---

## Key Challenges to Explore

### 1. Audio Quality Switching

**Challenge**: Seamlessly switch quality mid-stream

**Approach:**
- Buffer segments of different qualities
- Switch on segment boundary
- Pre-buffer next quality level

### 2. Cold Start Recommendations

**Problem**: New user with no listening history

**Solutions:**
- Onboarding flow: "Select artists you like"
- Use registration data (age, location)
- Show trending/popular content initially

### 3. Playlist Ordering

**Challenge**: Collaborative playlists with concurrent edits

**Solutions:**
- Fractional indexing for position
- Last-write-wins for conflicts
- Show edit history

---

## Development Phases

### Phase 1: Catalog [Completed]
- [x] Artists, albums, tracks database schema
- [x] Search and browse endpoints
- [x] Basic playback with HTML5 Audio

### Phase 2: Library [In Progress]
- [x] Save tracks/albums to library
- [x] Playlists CRUD operations
- [x] Queue management in player store
- [ ] Drag-and-drop reordering
- [ ] Collaborative playlists

### Phase 3: Recommendations
- [x] Listening history tracking
- [x] Basic recommendations from listening history
- [ ] Track embeddings with vector similarity
- [ ] Discover Weekly generation

### Phase 4: Offline
- [ ] Download manager
- [ ] License handling
- [ ] Sync status

---

## Implementation Notes

### Audio Playback Architecture

The player uses a Zustand store for state management with the following key features:
- Queue management with original and shuffled arrays
- Repeat modes: off, all, one
- Playback event tracking for analytics
- Stream count recorded after 30 seconds (industry standard)

```typescript
// Player store handles:
// - currentTrack, isPlaying, currentTime
// - queue, queueIndex, originalQueue (for shuffle restore)
// - volume, isMuted, shuffleEnabled, repeatMode
```

### Recommendation Algorithm

Simplified collaborative filtering based on:
1. User's listening history (last 28 days)
2. Liked tracks from library
3. Find tracks from same artists not yet listened to
4. Fill remaining slots with popular tracks

Future improvements:
- Vector embeddings for audio similarity
- User embedding based on listening patterns
- Blend collaborative + content-based filtering

### Database Schema

Key tables:
- `users` - Authentication and profile
- `artists`, `albums`, `tracks` - Catalog
- `playlists`, `playlist_tracks` - User playlists
- `user_library` - Liked songs, albums, artists
- `listening_history` - For recommendations
- `playback_events` - Analytics and royalty tracking

---

## Resources

- [Spotify Engineering Blog](https://engineering.atspotify.com/)
- [How Spotify Recommendations Work](https://engineering.atspotify.com/2022/06/personalized-recommendations-at-spotify/)
- [Audio Fingerprinting](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C7/C7.html)
