# News Aggregator - System Design Interview Answer

## Opening Statement

"Today I'll design a news aggregator like Google News, Flipboard, or Apple News. The core challenges are crawling thousands of sources efficiently, deduplicating articles about the same story, categorizing and ranking content, and personalizing the news feed for millions of users while maintaining freshness."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Source crawling** - Fetch articles from thousands of news sources
2. **Deduplication** - Identify and group articles about the same story
3. **Categorization** - Classify articles by topic (politics, sports, tech, etc.)
4. **Personalization** - Customize feed based on user interests and reading history
5. **Search** - Full-text search across all articles
6. **Breaking news** - Surface urgent/trending stories quickly
7. **Source diversity** - Show multiple perspectives on same story

### Non-Functional Requirements

- **Freshness**: Breaking news indexed within 5 minutes
- **Scale**: 100K sources, 10M articles/day, 50M users
- **Latency**: Feed generation < 200ms
- **Availability**: 99.9% uptime

### Out of Scope

- Publisher partnerships/paywalls
- Video content
- User-generated content

---

## Step 2: Scale Estimation (2-3 minutes)

**Content volume:**
- 100,000 news sources
- Average 100 articles per source per day = 10 million articles/day
- Average article size: 5KB text + 50KB images = 55KB
- Daily ingestion: 10M * 55KB = 550 GB/day

**Crawling:**
- Crawl each source every 15 minutes = 100K * 96/day = 9.6M crawls/day
- 111 crawls/second

**User traffic:**
- 50 million daily active users
- Average 5 feed loads per user = 250M feed requests/day
- Peak: 250M / 86400 * 3 = 8,700 QPS

**Deduplication:**
- 10M articles clustered into ~1M unique stories/day
- 90% of articles are duplicates/similar coverage

**Key insight**: "This is a content processing pipeline. Crawling, deduplication, and categorization happen offline; feed generation is the hot path."

---

## Step 3: High-Level Architecture (10 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Client Apps                                     │
│                          (Web, Mobile, API)                                  │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             API Gateway                                      │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────────┐
          │                         │                             │
          ▼                         ▼                             ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│    Feed Service     │   │   Search Service    │   │    User Service     │
│                     │   │                     │   │                     │
│  Personalization    │   │   Full-text         │   │   Preferences       │
│  Ranking            │   │   Filters           │   │   History           │
└──────────┬──────────┘   └──────────┬──────────┘   └─────────────────────┘
           │                         │
           └────────────┬────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Elasticsearch                                      │
│                    (Articles, Stories, Topics)                               │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────────┐
          │                         │                             │
          ▼                         ▼                             ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│   Story Service     │   │  Category Service   │   │  Trending Service   │
│                     │   │                     │   │                     │
│   Deduplication     │   │   Classification    │   │   Breaking news     │
│   Clustering        │   │   Topic tagging     │   │   Viral detection   │
└──────────┬──────────┘   └──────────┬──────────┘   └──────────┬──────────┘
           │                         │                         │
           └─────────────────────────┼─────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               Kafka                                          │
│                          (Article Stream)                                    │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────────┐
          │                         │                             │
          ▼                         ▼                             ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│   Content Parser    │   │   Image Processor   │   │    NLP Pipeline     │
│                     │   │                     │   │                     │
│   HTML parsing      │   │   Thumbnails        │   │   NER               │
│   Text extraction   │   │   CDN upload        │   │   Summarization     │
└──────────┬──────────┘   └─────────────────────┘   └─────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Crawler Service                                   │
│                                                                              │
│   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐            │
│   │ Crawler 1 │   │ Crawler 2 │   │ Crawler 3 │   │ Crawler N │            │
│   └───────────┘   └───────────┘   └───────────┘   └───────────┘            │
│                                                                              │
│   RSS/Atom feeds    │    Web scraping    │    Rate limiting per domain      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Crawler Service** - Fetches content from news sources, respects robots.txt and rate limits, supports RSS feeds and web scraping

2. **Content Parser** - Extracts article text from HTML, handles diverse page layouts, cleans and normalizes content

3. **NLP Pipeline** - Named Entity Recognition (people, places, organizations), topic classification, summarization for snippets

4. **Story Service** - Groups articles about the same event, creates story clusters, selects representative article per source

5. **Feed Service** - Generates personalized feeds, applies ranking algorithms, ensures diversity

6. **Trending Service** - Detects breaking news, identifies viral stories, real-time velocity tracking

---

## Step 4: Deep Dive - Content Crawling (7 minutes)

### Crawl Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Crawl Scheduling Flow                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────┐                                                   │
│   │  Crawl Schedule DB  │                                                   │
│   │                     │                                                   │
│   │  source_id          │                                                   │
│   │  url                │                                                   │
│   │  crawl_frequency    │                                                   │
│   │  last_crawl         │                                                   │
│   │  next_crawl         │                                                   │
│   │  priority           │                                                   │
│   └──────────┬──────────┘                                                   │
│              │                                                               │
│              ▼                                                               │
│   ┌─────────────────────┐                                                   │
│   │     Scheduler       │──▶ Query sources WHERE next_crawl <= NOW()        │
│   │     Service         │    ORDER BY priority DESC, next_crawl ASC         │
│   └──────────┬──────────┘                                                   │
│              │                                                               │
│              ▼                                                               │
│   ┌─────────────────────┐                                                   │
│   │       Kafka         │                                                   │
│   │   (Crawl Queue)     │                                                   │
│   └──────────┬──────────┘                                                   │
│              │                                                               │
│     ┌────────┼────────┬────────┐                                            │
│     ▼        ▼        ▼        ▼                                            │
│ ┌────────┐┌────────┐┌────────┐┌────────┐                                   │
│ │Crawler1││Crawler2││Crawler3││CrawlerN│                                   │
│ │DomainA ││DomainB ││DomainC ││DomainX │                                   │
│ └────────┘└────────┘└────────┘└────────┘                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Politeness and Rate Limiting

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Polite Crawler Flow                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│   │   Check     │────▶│   Rate      │────▶│   Fetch     │                   │
│   │ robots.txt  │     │   Limiter   │     │    URL      │                   │
│   └─────────────┘     └─────────────┘     └─────────────┘                   │
│          │                   │                   │                          │
│          ▼                   ▼                   ▼                          │
│   Disallowed?         Wait for token      30s timeout                       │
│   Return blocked      (1 req/sec/domain)  User-Agent: NewsAggregator/1.0    │
│                                                                              │
│   After fetch: Respect Crawl-Delay from robots.txt                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### RSS vs Web Scraping

| Method | Pros | Cons |
|--------|------|------|
| **RSS/Atom (preferred)** | Structured data, reliable | Not all sources offer |
| Web Scraping | Universal | Layout changes break parsing |

"I prefer RSS feeds when available for structured data. Fall back to web scraping with configurable selectors per source."

---

## Step 5: Deep Dive - Content Deduplication (10 minutes)

This is the most technically interesting part. Multiple outlets cover the same story.

### The Challenge

When a major event happens:
- CNN publishes "President Signs Climate Bill"
- NYT publishes "Climate Legislation Passes, President Signs"
- Reuters publishes "US President Signs Climate Change Bill"

These are all about the same event but have different text. We need to:
1. Detect they're about the same story
2. Group them into a cluster
3. Show one entry with multiple source options

### Deduplication Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Articles   │────▶│  Fingerprint │────▶│   Clustering │────▶│    Story     │
│   Stream     │     │  Generation  │     │              │     │   Creation   │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

### Approach 1: SimHash (Chosen)

SimHash creates a fingerprint that's similar for similar documents:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SimHash Algorithm                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Input: "President signs climate bill into law"                            │
│                                                                              │
│   1. Tokenize ──▶ ["president", "signs", "climate", "bill", "into", "law"]  │
│                                                                              │
│   2. Hash each token to 64-bit value                                        │
│      hash64("president") = 0x3a7f...                                        │
│      hash64("signs") = 0x8b2c...                                            │
│                                                                              │
│   3. Create weighted bit vector (64 dimensions)                             │
│      For each bit position i in each hash:                                  │
│        bit = 1? vector[i]++                                                 │
│        bit = 0? vector[i]--                                                 │
│                                                                              │
│   4. Convert to fingerprint                                                 │
│      vector[i] > 0? fingerprint bit = 1                                     │
│      vector[i] <= 0? fingerprint bit = 0                                    │
│                                                                              │
│   Output: 64-bit fingerprint                                                │
│                                                                              │
│   Similarity: Hamming distance < 3 ──▶ Same story                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Approach 2: MinHash + LSH (For efficiency at scale)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MinHash + LSH                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   MinHash Signature (100 hash functions):                                   │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  1. Extract 3-character shingles from text                          │   │
│   │  2. For each of 100 hash functions:                                 │   │
│   │     Find minimum hash value across all shingles                     │   │
│   │  3. Result: 100-dimensional signature                               │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   LSH Indexing (20 bands, 5 rows each):                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  For each band:                                                     │   │
│   │    bucketKey = hash(signature[band * 5 : band * 5 + 5])            │   │
│   │    buckets[bucketKey].add(articleId)                               │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Candidate Retrieval:                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Find all articles sharing at least one bucket                      │   │
│   │  These are similarity candidates (O(1) lookup)                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Story Clustering

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Story Assignment Flow                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   New article arrives                                                        │
│          │                                                                   │
│          ▼                                                                   │
│   ┌─────────────────┐                                                       │
│   │ Compute SimHash │──▶ fingerprint = simhash(title + body)                │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                       │
│   │ Find candidates │──▶ LSH buckets OR recent stories (48h window)         │
│   └────────┬────────┘    Hamming distance < 3                               │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Candidates found?                                                  │   │
│   │     ├── Yes ──▶ Add article to best matching story                  │   │
│   │     │          Update story: article_count++, velocity++            │   │
│   │     │                                                               │   │
│   │     └── No ──▶ Create new story                                     │   │
│   │               { id, title: article.title, fingerprint }             │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 6: Deep Dive - Personalization and Ranking (8 minutes)

### User Interest Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           User Profile                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   user_id: "abc123"                                                         │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  topic_weights (from 30-day reading history)                        │   │
│   │                                                                     │   │
│   │    technology: 0.35                                                 │   │
│   │    politics: 0.25                                                   │   │
│   │    sports: 0.15                                                     │   │
│   │    ...                                                              │   │
│   │                                                                     │   │
│   │  Boosted by dwell time > 60 seconds (1.2x multiplier)              │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  source_preferences                                                 │   │
│   │                                                                     │   │
│   │    nytimes: 0.9                                                     │   │
│   │    bbc: 0.8                                                         │   │
│   │    ...                                                              │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   reading_history[]  │  click_history[]  │  dwell_times{}                  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Ranking Signals

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Story Ranking Score                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Final Score = Relevance * 0.35                                            │
│               + Freshness * 0.25                                            │
│               + Quality * 0.20                                              │
│               + Diversity * 0.10                                            │
│               + Trending * 0.10                                             │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   RELEVANCE (35%)                                                           │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  + Sum of user topic weights for matching story topics              │   │
│   │  + 0.3 bonus for each followed entity (person, company)            │   │
│   │  * 0.1 penalty if story already read                               │   │
│   │  Cap at 1.0                                                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   FRESHNESS (25%)                                                           │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Exponential decay: e^(-age_hours / 6)                              │   │
│   │  Half-life: 6 hours                                                 │   │
│   │  12h old = 0.25, 24h old = 0.06                                    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   QUALITY (20%)                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Based on source diversity in story cluster                        │   │
│   │  More sources = higher credibility                                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   DIVERSITY (10%)                                                           │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Similar story already in feed? 0.3 score                          │   │
│   │  Same primary topic in feed? 0.7 score                             │   │
│   │  Unique topic? 1.0 score                                            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   TRENDING (10%)                                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  story.velocity (articles per minute)                               │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Feed Generation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Feed Generation Flow                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   GET /api/v1/feed?cursor=...&limit=20                                      │
│          │                                                                   │
│          ▼                                                                   │
│   ┌─────────────────┐                                                       │
│   │ Load user       │──▶ topic_weights, source_preferences, history         │
│   │ profile         │                                                       │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                       │
│   │ Get candidate   │──▶ 200 stories from last 48 hours                     │
│   │ stories         │    filtered by user's top topics                      │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                       │
│   │ Score each      │──▶ calculateStoryScore(story, profile, context)       │
│   │ story           │    Update context.stories_so_far for diversity        │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                       │
│   │ Sort by score   │──▶ Return top 20 with next_cursor                     │
│   │ Apply cursor    │                                                       │
│   └─────────────────┘                                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 7: Deep Dive - Breaking News Detection (5 minutes)

### Velocity Tracking

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Velocity Calculation                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Sliding window: 30 minutes                                                │
│                                                                              │
│   velocity = count(articles in window) / window_minutes                     │
│                                                                              │
│   Breaking news threshold:                                                   │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  velocity > 2 articles/minute                                       │   │
│   │  AND article_count > 10 in 30 minutes                              │   │
│   │  AND unique_sources > 5                                             │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   If all conditions met ──▶ markAsBreakingNews(story)                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Breaking News Alert Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Breaking News Flow                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Story flagged as breaking                                                  │
│          │                                                                   │
│          ▼                                                                   │
│   ┌─────────────────┐                                                       │
│   │ Update story    │──▶ is_breaking: true                                  │
│   │                 │    breaking_started_at: now                           │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                       │
│   │ Find interested │──▶ Users with matching topic preferences              │
│   │ users           │                                                       │
│   └────────┬────────┘                                                       │
│            │                                                                 │
│            ▼                                                                 │
│   ┌─────────────────┐                                                       │
│   │ Send push       │──▶ "Breaking News: {story.title}"                     │
│   │ notifications   │    Only if user notification settings allow           │
│   └─────────────────┘                                                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 8: Data Model (3 minutes)

### PostgreSQL Schema

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Database Schema                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   SOURCES                            ARTICLES                               │
│   ┌───────────────────────┐          ┌───────────────────────────────────┐  │
│   │ id UUID PK            │          │ id UUID PK                        │  │
│   │ name VARCHAR(255)     │          │ source_id UUID FK                 │  │
│   │ domain VARCHAR(255)   │◀────────▶│ story_id UUID FK                  │  │
│   │ feed_url VARCHAR(500) │          │ url VARCHAR(1000) UNIQUE          │  │
│   │ category VARCHAR(50)  │          │ title VARCHAR(500)                │  │
│   │ credibility_score     │          │ summary TEXT                      │  │
│   │ crawl_frequency_mins  │          │ body TEXT                         │  │
│   │ created_at TIMESTAMP  │          │ image_url VARCHAR(500)            │  │
│   └───────────────────────┘          │ published_at TIMESTAMP            │  │
│                                      │ fingerprint BIGINT (SimHash)      │  │
│                                      │ topics TEXT[]                     │  │
│   STORIES                            │ entities JSONB                    │  │
│   ┌───────────────────────┐          │ created_at TIMESTAMP              │  │
│   │ id UUID PK            │          └───────────────────────────────────┘  │
│   │ title VARCHAR(500)    │                                                 │
│   │ summary TEXT          │◀─────────────────────────────────────────────── │
│   │ primary_topic         │                                                 │
│   │ topics TEXT[]         │          USER_READING_HISTORY                   │
│   │ entities JSONB        │          ┌───────────────────────────────────┐  │
│   │ fingerprint BIGINT    │          │ user_id UUID FK                   │  │
│   │ article_count INT     │          │ article_id UUID FK                │  │
│   │ source_count INT      │          │ story_id UUID FK                  │  │
│   │ velocity DECIMAL      │          │ read_at TIMESTAMP                 │  │
│   │ is_breaking BOOLEAN   │          │ dwell_time_seconds INT            │  │
│   │ created_at TIMESTAMP  │          │ PRIMARY KEY (user_id, article_id) │  │
│   │ updated_at TIMESTAMP  │          └───────────────────────────────────┘  │
│   └───────────────────────┘                                                 │
│                                                                              │
│   KEY INDEXES:                                                               │
│   - articles(story_id)                                                       │
│   - articles(published_at DESC)                                             │
│   - stories(topics) using GIN                                               │
│   - stories(velocity DESC) WHERE velocity > 0                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Elasticsearch Mapping

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Elasticsearch Index                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Index: articles                                                           │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  title          │ text      │ analyzer: english                    │   │
│   │  body           │ text      │ analyzer: english                    │   │
│   │  topics         │ keyword   │ (array)                              │   │
│   │  entities.name  │ keyword   │ (nested)                             │   │
│   │  entities.type  │ keyword   │ (nested)                             │   │
│   │  published_at   │ date      │                                      │   │
│   │  source_id      │ keyword   │                                      │   │
│   │  story_id       │ keyword   │                                      │   │
│   │  velocity       │ float     │                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 9: API Design (2 minutes)

### REST API Endpoints

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              REST API                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   FEED                                                                       │
│   ─────────────────────────────────────────────────────                     │
│   GET  /api/v1/feed?cursor=...&limit=20                                     │
│   GET  /api/v1/feed/topic/{topic}                                           │
│   GET  /api/v1/feed/for-you                                                 │
│                                                                              │
│   STORIES                                                                    │
│   ─────────────────────────────────────────────────────                     │
│   GET  /api/v1/stories/{id}                                                 │
│   GET  /api/v1/stories/{id}/articles                                        │
│                                                                              │
│   SEARCH                                                                     │
│   ─────────────────────────────────────────────────────                     │
│   GET  /api/v1/search?q=climate+change&topic=politics&date_from=...         │
│                                                                              │
│   TRENDING                                                                   │
│   ─────────────────────────────────────────────────────                     │
│   GET  /api/v1/trending                                                     │
│   GET  /api/v1/breaking                                                     │
│                                                                              │
│   USER                                                                       │
│   ─────────────────────────────────────────────────────                     │
│   GET  /api/v1/user/preferences                                             │
│   PUT  /api/v1/user/preferences                                             │
│        Body: { topics: [...], sources: [...] }                              │
│   POST /api/v1/user/reading-history                                         │
│        Body: { article_id, dwell_time_seconds }                             │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 10: Scalability (3 minutes)

### Crawling at Scale

- Distribute crawlers by domain (consistent hashing)
- Queue-based work distribution via Kafka
- Per-domain rate limiting

### Deduplication at Scale

- Real-time: Check last 48 hours with LSH
- Batch: Nightly full re-clustering for older content
- Partition by topic for parallel processing

### Feed Generation

- Pre-compute feeds for active users
- Cache personalized feeds for 5 minutes
- Fall back to topic-based cache for cold users

### Geographic Distribution

- Edge caching for feed responses
- Regional crawler deployments
- Replicated Elasticsearch clusters

---

## Step 11: Trade-offs (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| SimHash for dedup | Fast, but may miss semantic similarity |
| 48-hour clustering window | Fresh clusters, but may split ongoing stories |
| Pre-computed feeds | Fast response, but slightly stale |
| Topic-based diversity | Broad coverage, but may miss depth |

### Alternatives Considered

1. **Semantic embeddings for dedup** - Better for paraphrased content, more compute intensive, could use as secondary signal

2. **Real-time feed generation** - Always fresh, higher latency, use for active users

3. **Collaborative filtering for personalization** - "Users like you read...", cold start problem, hybrid approach possible

---

## Closing Summary

"I've designed a news aggregator with:

1. **Distributed crawling** with rate limiting and RSS/scraping support
2. **SimHash + LSH deduplication** for grouping articles into stories
3. **Multi-signal ranking** balancing relevance, freshness, and diversity
4. **Velocity-based breaking news** detection for real-time alerts

The key insight is that this is a content processing pipeline. Most work (crawling, dedup, classification) happens asynchronously, enabling fast feed generation at query time. Happy to dive deeper into any component."

---

## Potential Follow-up Questions

1. **How would you handle fake news detection?** - Cross-reference claims across sources, source credibility scoring, fact-checking partnerships

2. **How would you handle a source that changes its layout?** - Monitor extraction success rates, automatic layout learning, fallback to RSS if available

3. **How would you personalize for new users?** - Onboarding topic selection, location-based defaults, popular/trending until profile builds
