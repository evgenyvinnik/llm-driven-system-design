# Design TikTok - Short Video Platform

## Overview

A simplified TikTok-like platform demonstrating short video recommendations, content discovery algorithms, and creator monetization. This educational project focuses on building a recommendation-driven video platform with infinite scroll experiences.

## Key Features

### 1. Short Video Content
- Video upload (15-60 seconds)
- Video processing and transcoding
- Effects, filters, and sounds
- Duets and stitches

### 2. For You Page (FYP)
- Personalized video recommendations
- Cold start for new users
- Exploration vs exploitation balance
- Watch time optimization

### 3. Content Discovery
- Hashtag-based discovery
- Sound/music-based discovery
- Trending content surfacing
- Search functionality

### 4. Engagement Features
- Like, comment, share
- Follow creators
- Save to favorites
- Video view counting

### 5. Creator Tools
- Analytics dashboard
- Monetization (creator fund)
- Live streaming
- Audience insights

## Implementation Status

- [ ] Initial architecture design
- [ ] Video upload and storage
- [ ] Video transcoding pipeline
- [ ] Recommendation engine
- [ ] Feed generation
- [ ] Engagement tracking
- [ ] Creator analytics
- [ ] Local multi-instance testing
- [ ] Documentation

## Key Technical Challenges

1. **Recommendation Algorithm**: Optimizing for watch time with limited user history
2. **Cold Start Problem**: Recommending content to new users with no data
3. **Video Processing**: Transcoding to multiple formats efficiently
4. **Infinite Scroll**: Prefetching next videos seamlessly
5. **Real-Time Analytics**: Tracking view counts at massive scale

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## Recommendation Approach

**Multi-Armed Bandit for Exploration:**
```javascript
function selectNextVideo(userId, candidateVideos) {
  const epsilon = 0.1 // 10% exploration

  if (Math.random() < epsilon) {
    // Explore: random video from pool
    return randomChoice(candidateVideos)
  } else {
    // Exploit: highest predicted engagement
    return candidateVideos.reduce((best, video) =>
      predictEngagement(userId, video) > predictEngagement(userId, best)
        ? video : best
    )
  }
}
```

**Engagement Prediction:**
- User features: watch history, likes, follows
- Video features: hashtags, sounds, creator, duration
- Context: time of day, device, session depth
