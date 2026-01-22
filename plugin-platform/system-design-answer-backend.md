# Plugin Platform - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design a web-based plugin platform that enables developers to build, publish, and distribute extensions that extend core application functionality. The core challenge is designing a flexible plugin architecture that balances capability with maintainability.

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Install**: Users can add extensions from a marketplace
- **Run**: Execute extensions with access to plugin APIs
- **Publish**: Developers can submit extensions for review
- **Manage**: Enable, disable, update, configure extensions
- **Discover**: Browse, search, and review extensions

### Non-Functional Requirements
- **Composability**: Plugins work independently and together
- **Performance**: < 500ms extension activation
- **Scale**: 10,000+ extensions, 1M+ users
- **Developer Experience**: Easy to build and debug plugins

### Scale Requirements
- **Extensions**: 10,000+
- **Daily active users**: 1M+
- **Extension installations**: 100M+ total
- **API calls/day**: 100M+

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend (React)                                │
│  ┌────────────────────┐  ┌─────────────────────────────────────────────────┐│
│  │   Plugin Host      │  │              Marketplace UI                      ││
│  │  ┌──────────────┐  │  │  ┌───────────┐ ┌───────────┐ ┌───────────────┐ ││
│  │  │ Event Bus    │  │  │  │ Browse    │ │ Install   │ │ Auth Modal    │ ││
│  │  │ State Mgr    │  │  │  │ Plugins   │ │ Uninstall │ │ Login/Register│ ││
│  │  │ Slot System  │  │  │  └───────────┘ └───────────┘ └───────────────┘ ││
│  │  └──────────────┘  │  └─────────────────────────────────────────────────┘│
│  └────────────────────┘                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ HTTP/REST
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Backend Services (Express.js)                      │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │ Auth Routes   │  │ Plugin Routes │  │ User Plugins  │  │ Developer    │ │
│  │ - Register    │  │ - Browse      │  │ - Install     │  │ - Publish    │ │
│  │ - Login       │  │ - Search      │  │ - Uninstall   │  │ - Versions   │ │
│  │ - Session     │  │ - Details     │  │ - Settings    │  │ - Manage     │ │
│  └───────────────┘  └───────────────┘  └───────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
         │                      │                      │
         ▼                      ▼                      ▼
    ┌─────────┐           ┌─────────┐            ┌─────────┐
    │PostgreSQL│          │  Redis  │            │  MinIO  │
    │ - Users │           │ - Cache │            │ Plugin  │
    │ - Plugins│          │ - Session│           │ Bundles │
    │ - Reviews│          └─────────┘            └─────────┘
    └─────────┘
```

## Deep Dive 1: Database Schema and Data Modeling (8 minutes)

### Core Tables

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_developer BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Plugins table (core registry)
CREATE TABLE plugins (
  id VARCHAR(100) PRIMARY KEY,  -- e.g., 'font-selector'
  author_id UUID REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  license VARCHAR(50) DEFAULT 'MIT',
  repository_url TEXT,
  homepage_url TEXT,
  icon_url TEXT,
  status VARCHAR(20) DEFAULT 'draft',  -- draft, published, suspended
  install_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Plugin versions (immutable releases)
CREATE TABLE plugin_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  version VARCHAR(20) NOT NULL,
  bundle_url TEXT NOT NULL,
  manifest JSONB NOT NULL,
  changelog TEXT,
  min_platform_version VARCHAR(20),
  file_size INTEGER,
  checksum VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(plugin_id, version)
);

-- User installed plugins (authenticated users)
CREATE TABLE user_plugins (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  version_installed VARCHAR(20),
  is_enabled BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  installed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, plugin_id)
);

-- Anonymous user installs (tracked by session)
CREATE TABLE anonymous_installs (
  session_id VARCHAR(255) NOT NULL,
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  version_installed VARCHAR(20),
  is_enabled BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  installed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (session_id, plugin_id)
);

-- Plugin reviews
CREATE TABLE plugin_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  content TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(plugin_id, user_id)
);

-- Indexes for common queries
CREATE INDEX idx_plugins_status ON plugins(status);
CREATE INDEX idx_plugins_category ON plugins(category);
CREATE INDEX idx_plugins_install_count ON plugins(install_count DESC);
CREATE INDEX idx_plugin_versions_plugin ON plugin_versions(plugin_id);
CREATE INDEX idx_user_plugins_user ON user_plugins(user_id);
CREATE INDEX idx_plugin_reviews_plugin ON plugin_reviews(plugin_id);
```

### Design Decisions

**Composite Primary Keys**: Using (user_id, plugin_id) for user_plugins ensures one installation per user per plugin while optimizing lookups.

**JSONB for Settings**: Plugin-specific settings vary widely. JSONB allows flexible schema while supporting queries on settings.

**Anonymous Install Support**: Separate table for session-based installs enables anonymous usage while allowing migration when users register.

## Deep Dive 2: API Design and RESTful Endpoints (8 minutes)

### API Endpoint Structure

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/auth/register` | POST | None | Create account |
| `/api/v1/auth/login` | POST | None | Login |
| `/api/v1/auth/logout` | POST | Session | Logout |
| `/api/v1/auth/me` | GET | Session | Get current user |
| `/api/v1/plugins` | GET | Optional | Browse/search plugins |
| `/api/v1/plugins/:id` | GET | Optional | Plugin details |
| `/api/v1/plugins/categories` | GET | None | List categories |
| `/api/v1/user/plugins` | GET | Optional | Installed plugins |
| `/api/v1/user/plugins/install` | POST | Optional | Install plugin |
| `/api/v1/user/plugins/:id` | DELETE | Optional | Uninstall |
| `/api/v1/developer/register` | POST | Required | Become developer |
| `/api/v1/developer/plugins` | GET/POST | Required | Manage plugins |
| `/api/v1/developer/plugins/:id/versions` | POST | Required | Publish version |

### Extension Publishing Service

```typescript
class MarketplaceService {
  async publishExtension(authorId: string, manifest: PluginManifest, bundle: Buffer) {
    // 1. Validate manifest structure
    this.validateManifest(manifest);

    // 2. Basic code review (for bundled plugins)
    const reviewResult = await this.codeReview.analyze(bundle);
    if (reviewResult.hasIssues) {
      throw new Error(`Review issues: ${reviewResult.issues.join(', ')}`);
    }

    // 3. Upload bundle to MinIO (S3-compatible)
    const bundleUrl = await this.storage.upload(
      `extensions/${manifest.id}/${manifest.version}/bundle.js`,
      bundle
    );

    // 4. Create or update extension record
    const extension = await db.query(`
      INSERT INTO plugins (id, author_id, name, description, category, icon_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        name = $3, description = $4, updated_at = NOW()
      RETURNING *
    `, [manifest.id, authorId, manifest.name, manifest.description,
        manifest.category, manifest.icon]);

    // 5. Add version record
    await db.query(`
      INSERT INTO plugin_versions
        (plugin_id, version, bundle_url, manifest, changelog, min_platform_version)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [manifest.id, manifest.version, bundleUrl, manifest,
        manifest.changelog, manifest.minPlatformVersion]);

    // 6. Invalidate cache
    await this.cache.invalidatePattern(`plugins:*`);

    // 7. Update search index
    await this.updateSearchIndex(extension.rows[0]);

    return extension.rows[0];
  }
}
```

### Search with Elasticsearch

```typescript
async searchExtensions(query: string, options = {}) {
  const { category, sortBy = 'popularity', limit = 20 } = options;

  // Elasticsearch query for full-text search
  const esQuery = {
    bool: {
      must: [
        { match: { status: 'published' } },
        query ? {
          multi_match: {
            query,
            fields: ['name^3', 'description', 'tags^2']
          }
        } : { match_all: {} }
      ]
    }
  };

  if (category) {
    esQuery.bool.must.push({ term: { category } });
  }

  const sortOptions = {
    popularity: [{ install_count: 'desc' }],
    rating: [{ average_rating: 'desc' }],
    recent: [{ published_at: 'desc' }]
  };

  return elasticsearch.search({
    index: 'extensions',
    body: {
      query: esQuery,
      sort: sortOptions[sortBy],
      size: limit
    }
  });
}
```

## Deep Dive 3: Session Management and Authentication (6 minutes)

### Session-Based Auth with Anonymous Support

```typescript
import session from 'express-session';
import RedisStore from 'connect-redis';

const sessionMiddleware = session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true, // Create session for anonymous users
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
});

// Middleware to handle both authenticated and anonymous users
function optionalAuth(req, res, next) {
  // Session always exists (for anonymous users)
  // req.session.userId may or may not exist
  next();
}

// Migrate anonymous installs when user logs in
async function migrateAnonymousInstalls(sessionId: string, userId: string) {
  await db.query(`
    INSERT INTO user_plugins (user_id, plugin_id, version_installed, is_enabled, settings, installed_at)
    SELECT $1, plugin_id, version_installed, is_enabled, settings, installed_at
    FROM anonymous_installs
    WHERE session_id = $2
    ON CONFLICT (user_id, plugin_id) DO NOTHING
  `, [userId, sessionId]);

  await db.query(`DELETE FROM anonymous_installs WHERE session_id = $1`, [sessionId]);
}
```

### Install Flow for Both User Types

```typescript
async function installPlugin(req, res) {
  const { pluginId, version } = req.body;
  const userId = req.session.userId;
  const sessionId = req.session.id;

  // Verify plugin exists and is published
  const plugin = await db.query(`
    SELECT p.*, pv.bundle_url
    FROM plugins p
    JOIN plugin_versions pv ON p.id = pv.plugin_id
    WHERE p.id = $1 AND p.status = 'published' AND pv.version = $2
  `, [pluginId, version]);

  if (plugin.rows.length === 0) {
    return res.status(404).json({ error: 'Plugin not found' });
  }

  if (userId) {
    // Authenticated user - store in user_plugins
    await db.query(`
      INSERT INTO user_plugins (user_id, plugin_id, version_installed)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, plugin_id) DO UPDATE SET
        version_installed = $3, installed_at = NOW()
    `, [userId, pluginId, version]);
  } else {
    // Anonymous user - store in anonymous_installs
    await db.query(`
      INSERT INTO anonymous_installs (session_id, plugin_id, version_installed)
      VALUES ($1, $2, $3)
      ON CONFLICT (session_id, plugin_id) DO UPDATE SET
        version_installed = $3, installed_at = NOW()
    `, [sessionId, pluginId, version]);
  }

  // Increment install count
  await db.query(`
    UPDATE plugins SET install_count = install_count + 1 WHERE id = $1
  `, [pluginId]);

  res.json({ success: true, bundleUrl: plugin.rows[0].bundle_url });
}
```

## Deep Dive 4: Caching Strategy (5 minutes)

### Redis Cache Architecture

```typescript
// Redis cache key patterns
const CACHE_KEYS = {
  PLUGIN_LIST: 'plugins:list',
  PLUGIN_DETAIL: (id: string) => `plugins:detail:${id}`,
  CATEGORIES: 'plugins:categories',
  USER_PLUGINS: (userId: string) => `user:${userId}:plugins`,
};

const CACHE_TTL = {
  PLUGIN_LIST: 300,      // 5 minutes
  PLUGIN_DETAIL: 600,    // 10 minutes
  CATEGORIES: 1800,      // 30 minutes
  USER_PLUGINS: 300,     // 5 minutes
};

class CacheService {
  async getPluginList(query: string, category?: string) {
    const cacheKey = `${CACHE_KEYS.PLUGIN_LIST}:${hashQuery(query, category)}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const plugins = await this.fetchPluginsFromDb(query, category);
    await redis.setex(cacheKey, CACHE_TTL.PLUGIN_LIST, JSON.stringify(plugins));

    return plugins;
  }

  async invalidatePattern(pattern: string) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  // Invalidation triggers
  async onPluginPublished(pluginId: string) {
    await this.invalidatePattern('plugins:list:*');
    await redis.del(CACHE_KEYS.PLUGIN_DETAIL(pluginId));
  }

  async onPluginInstalled(pluginId: string) {
    // Update install count without full invalidation
    await redis.del(CACHE_KEYS.PLUGIN_DETAIL(pluginId));
  }
}
```

### Cache-Aside Pattern

```typescript
async function getPluginDetails(pluginId: string) {
  const cacheKey = CACHE_KEYS.PLUGIN_DETAIL(pluginId);

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss - fetch from database
  const result = await db.query(`
    SELECT p.*,
           json_agg(DISTINCT pv.*) as versions,
           AVG(pr.rating) as average_rating,
           COUNT(pr.id) as review_count
    FROM plugins p
    LEFT JOIN plugin_versions pv ON p.id = pv.plugin_id
    LEFT JOIN plugin_reviews pr ON p.id = pr.plugin_id
    WHERE p.id = $1
    GROUP BY p.id
  `, [pluginId]);

  if (result.rows.length === 0) {
    return null;
  }

  // Store in cache
  await redis.setex(cacheKey, CACHE_TTL.PLUGIN_DETAIL, JSON.stringify(result.rows[0]));

  return result.rows[0];
}
```

## Deep Dive 5: Object Storage for Plugin Bundles (5 minutes)

### MinIO Storage Service

```typescript
import { Client as MinioClient } from 'minio';

const minio = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT,
  port: parseInt(process.env.MINIO_PORT),
  useSSL: process.env.NODE_ENV === 'production',
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});

const BUCKET_NAME = 'plugin-bundles';

class StorageService {
  async uploadBundle(pluginId: string, version: string, bundle: Buffer) {
    const objectName = `${pluginId}/${version}/bundle.js`;

    // Upload with public-read policy
    await minio.putObject(BUCKET_NAME, objectName, bundle, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });

    // Generate public URL
    return `${process.env.CDN_URL}/${BUCKET_NAME}/${objectName}`;
  }

  async uploadSourceMap(pluginId: string, version: string, sourceMap: Buffer) {
    const objectName = `${pluginId}/${version}/bundle.js.map`;

    await minio.putObject(BUCKET_NAME, objectName, sourceMap, {
      'Content-Type': 'application/json',
    });
  }

  async deleteVersion(pluginId: string, version: string) {
    const objects = await this.listVersionFiles(pluginId, version);

    if (objects.length > 0) {
      await minio.removeObjects(BUCKET_NAME, objects);
    }
  }

  private async listVersionFiles(pluginId: string, version: string) {
    const prefix = `${pluginId}/${version}/`;
    const objects: string[] = [];

    const stream = minio.listObjects(BUCKET_NAME, prefix, true);

    return new Promise((resolve) => {
      stream.on('data', (obj) => objects.push(obj.name));
      stream.on('end', () => resolve(objects));
    });
  }
}
```

### CDN Configuration

```typescript
// Plugin bundles are served through CDN for optimal performance
// Immutable versioning - each version has unique URL

// Example URLs:
// https://cdn.example.com/plugin-bundles/font-selector/1.0.0/bundle.js
// https://cdn.example.com/plugin-bundles/font-selector/1.0.1/bundle.js

// Browser caching headers (set during upload):
// Cache-Control: public, max-age=31536000, immutable
```

## Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| Search | Elasticsearch | PostgreSQL FTS | Better relevance, faceting, scales independently |
| Plugin Storage | MinIO (S3) | PostgreSQL BLOB | CDN integration, scales independently, cheaper at scale |
| Session Store | Redis | PostgreSQL | Faster session lookups, built-in TTL |
| Anonymous Support | Separate table | Single table with nullable user_id | Cleaner data model, easier cleanup |
| Plugin IDs | String slug | UUID | Human-readable, easier debugging |
| Version Storage | Immutable rows | Mutable with history | Simpler, supports rollback |

## Future Backend Enhancements

1. **Plugin Dependencies**: DAG resolution for plugins that depend on other plugins
2. **Webhook Notifications**: Notify developers on installs, reviews, issues
3. **Usage Analytics**: Track plugin activation, feature usage, errors
4. **Rate Limiting**: Per-developer API limits for publishing
5. **Plugin Sandboxing Metadata**: Store security audit results per version
6. **Automated Testing**: Run plugin test suites during publish
7. **Geographic Distribution**: Multi-region MinIO for faster downloads
