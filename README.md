# LLM-Driven System Design Practice

## Vision

Traditional system design interview preparation often relies on passive learning - reading articles, watching YouTube videos, and memorizing architectural patterns. While valuable, this approach lacks the hands-on experience that comes from actually building systems.

This repository represents a different approach: **learning system design by actually implementing it**.

With the assistance of LLMs like Claude, we can rapidly prototype lightweight versions of classic (and creative) system design interview questions. This hands-on practice helps develop:

- **Architectural thinking** - Making real trade-offs, not theoretical ones
- **Implementation experience** - Understanding what actually works vs. what looks good on a whiteboard
- **Technology selection** - Choosing the right tools for each use case
- **Scalability patterns** - Building systems that can grow
- **Problem-solving skills** - Debugging and iterating on real implementations

## System Design Challenges

Each folder contains an independent implementation of a system design problem: **99 implemented projects**, 3 design-only write-ups of external projects, and 14 more planned in [ROADMAP.md](./ROADMAP.md).

### URL Shortening & Web Services

| Project | Description | Status |
|---------|-------------|--------|
| [Bit.ly](./bitly/) | URL shortening service | ✅ Implemented |
| [Web Crawler](./web-crawler/) | Distributed web crawling system | ✅ Implemented |

### Storage & File Systems

| Project | Description | Status |
|---------|-------------|--------|
| [Dropbox](./dropbox/) | Cloud file storage and synchronization | ✅ Implemented |
| [Distributed Cache](./distributed-cache/) | High-performance caching layer | ✅ Implemented |
| [File System](./file-system/) | Four-level online-assessment practice (file store or key-value database), scaled into a namespace service with quotas and restores | ✅ Implemented |

### Social Media & Content

| Project | Description | Status |
|---------|-------------|--------|
| [FB News Feed](./fb-news-feed/) | Personalized content feed | ✅ Implemented |
| [FB Live Comments](./fb-live-comments/) | Real-time comment system | ✅ Implemented |
| [FB Post Search](./fb-post-search/) | Social media search engine | ✅ Implemented |
| [Instagram](./instagram/) | Photo sharing platform | ✅ Implemented |
| [Tinder](./tinder/) | Matching and recommendation system | ✅ Implemented |
| [r/place](./r-place/) | Collaborative real-time pixel canvas | ✅ Implemented |
| [Reddit](./reddit/) | Community forums with voting system | ✅ Implemented |
| [Twitter](./twitter/) | Microblogging and social network | ✅ Implemented |
| [LinkedIn](./linkedin/) | Professional networking platform | ✅ Implemented |
| [TikTok](./tiktok/) | Short-form video platform | ✅ Implemented |
| [Kindle Highlights](./kindle-highlights/) | Social reading platform with real-time sync | ✅ Implemented |
| [Pinterest](./pinterest/) | Visual discovery with pins, boards, and masonry feed | ✅ Implemented |

### Messaging & Communication

| Project | Description | Status |
|---------|-------------|--------|
| [WhatsApp](./whatsapp/) | Real-time messaging platform | ✅ Implemented |
| [Discord](./discord/) | Real-time chat and community platform | ✅ Implemented |
| [Slack](./slack/) | Team communication and collaboration | ✅ Implemented |
| [iMessage](./imessage/) | Cross-device messaging with offline sync | ✅ Implemented |
| [FaceTime](./facetime/) | Real-time video calling | ✅ Implemented |
| [Gmail](./gmail/) | Email with threaded conversations and search | ✅ Implemented |
| [Microsoft Teams](./microsoft-teams/) | Enterprise chat with teams, channels, and presence | ✅ Implemented |
| [Zoom](./zoom/) | Video conferencing with SFU media routing | ✅ Implemented |

### Video & Streaming

| Project | Description | Status |
|---------|-------------|--------|
| [YouTube](./youtube/) | Video hosting and streaming platform | ✅ Implemented |
| [YouTube Top K](./youtube-top-k/) | Real-time trending video analytics | ✅ Implemented |
| [Twitch](./twitch/) | Live streaming platform | ✅ Implemented |
| [Netflix](./netflix/) | Video streaming with adaptive bitrate | ✅ Implemented |
| [Spotify](./spotify/) | Music streaming and recommendations | ✅ Implemented |
| [Apple Music](./apple-music/) | Music streaming service | ✅ Implemented |
| [Apple TV+](./apple-tv/) | Video streaming service | ✅ Implemented |

### E-Commerce & Marketplaces

| Project | Description | Status |
|---------|-------------|--------|
| [Yelp](./yelp/) | Local business review platform | ✅ Implemented |
| [Online Auction](./online-auction/) | Bidding and auction system | ✅ Implemented |
| [Price Tracking](./price-tracking/) | E-commerce price monitoring | ✅ Implemented |
| [Amazon](./amazon/) | E-commerce platform at scale | ✅ Implemented |
| [Airbnb](./airbnb/) | Vacation rental marketplace | ✅ Implemented |
| [Etsy](./etsy/) | Handmade goods marketplace | ✅ Implemented |
| [DoorDash](./doordash/) | Food delivery logistics | ✅ Implemented |
| [Shopify](./shopify/) | Multi-tenant e-commerce platform | ✅ Implemented |
| [App Store](./app-store/) | App discovery, purchases, and rankings | ✅ Implemented |

### Transportation & Logistics

| Project | Description | Status |
|---------|-------------|--------|
| [Uber](./uber/) | Ride-hailing platform | ✅ Implemented |
| [Local Delivery](./local-delivery/) | Last-mile delivery system | ✅ Implemented |
| [Strava](./strava/) | Fitness tracking and social platform | ✅ Implemented |
| [Apple Maps](./apple-maps/) | Navigation with real-time traffic | ✅ Implemented |
| [AirTag](./airtag/) | Item tracking and Find My network | ✅ Implemented |
| [Railcar Health](./railcar-health/) | Wayside detector predictive maintenance: bearing trending, identity resolution, late data, alerts, car holds and yard inspections | ✅ Implemented |
| [Locomotive Fueling](./locomotive-fueling/) | Fuel-stop recommendations from locomotive telemetry: noisy sensors, DP optimizer, stable plans, idempotent truck orders | ✅ Implemented |

### Ticketing, Events & Reservations

| Project | Description | Status |
|---------|-------------|--------|
| [Ticketmaster](./ticketmaster/) | Event ticketing and inventory management | ✅ Implemented |
| [Hotel Booking](./hotel-booking/) | Hotel reservation and management system | ✅ Implemented |
| [Calendly](./calendly/) | Meeting scheduling and calendar coordination | ✅ Implemented |
| [Google Calendar](./google-calendar/) | Calendar with Month/Week/Day views and conflict detection | ✅ Implemented |

### Developer & Productivity Tools

| Project | Description | Status |
|---------|-------------|--------|
| [LeetCode](./leetcode/) | Online coding judge and practice platform | ✅ Implemented |
| [Google Docs](./google-docs/) | Collaborative document editing | ✅ Implemented |
| [Google Sheets](./google-sheets/) | Collaborative spreadsheet with real-time sync | ✅ Implemented |
| [Figma](./figma/) | Collaborative design and prototyping platform | ✅ Implemented |
| [GitHub](./github/) | Code hosting and version control | ✅ Implemented |
| [Notion](./notion/) | Collaborative workspace with blocks | ✅ Implemented |
| [Jira](./jira/) | Issue tracking and project management | ✅ Implemented |
| [Collaborative Editor](./collaborative-editor/) | Real-time document editing | ✅ Implemented |
| [AI Code Assistant](./ai-code-assistant/) | CLI coding assistant like Claude Code/Cursor | ✅ Implemented |
| [Plugin Platform](./plugin-platform/) | VS Code-like extension system with sandboxing | ✅ Implemented |
| [Confluence](./confluence/) | Team wiki with spaces and page hierarchies | ✅ Implemented |
| [Excalidraw](./excalidraw/) | Collaborative infinite whiteboard canvas | ✅ Implemented |
| [Loom](./loom/) | Async screen and camera video messaging | ✅ Implemented |
| [Retool](./retool/) | No-code internal tool builder | ✅ Implemented |
| [Supabase Dashboard](./supabase-dashboard/) | Database management dashboard for Backend-as-a-Service | ✅ Implemented |

### Financial Services & Payments

| Project | Description | Status |
|---------|-------------|--------|
| [Robinhood](./robinhood/) | Stock trading platform | ✅ Implemented |
| [Payment System](./payment-system/) | Transaction processing system | ✅ Implemented |
| [Stripe](./stripe/) | Payment processing and APIs | ✅ Implemented |
| [Venmo](./venmo/) | P2P payment platform | ✅ Implemented |
| [Splitwise](./splitwise/) | Shared-expense tracking with debt simplification | ✅ Implemented |
| [Apple Pay](./apple-pay/) | Secure mobile payments | ✅ Implemented |
| [Coinbase](./coinbase/) | Cryptocurrency exchange with order matching | ✅ Implemented |
| [PayPal](./paypal/) | P2P payments with double-entry ledger | ✅ Implemented |

### Business Services

| Project | Description | Status |
|---------|-------------|--------|
| [DocuSign](./docusign/) | Electronic signature platform | ✅ Implemented |
| [Salesforce](./salesforce/) | CRM with sales pipeline and lead conversion | ✅ Implemented |

### Search & Discovery

| Project | Description | Status |
|---------|-------------|--------|
| [Google Search](./google-search/) | Web search engine | ✅ Implemented |
| [Typeahead](./typeahead/) | Autocomplete and suggestions | ✅ Implemented |
| [Spotlight](./spotlight/) | Device and cloud search | ✅ Implemented |

### ML/AI & Data Platforms

| Project | Description | Status |
|---------|-------------|--------|
| [Scale AI](./scale-ai/) | Data labeling with crowdsourced drawing collection | ✅ Implemented |
| [Health Data Pipeline](./health-data-pipeline/) | Multi-device health data aggregation | ✅ Implemented |
| [Prompt Playground](./prompt-playground/) | Versioned prompts, streamed runs, side-by-side comparisons, and share links over a model API | ✅ Implemented |
| [In-App Assistant](./in-app-assistant/) | An LLM assistant inside a mail, docs and calendar suite: a durable agent loop, policy-checked tools, permission-aware hybrid retrieval and confirmations | ✅ Implemented |
| [Console Growth](./console-growth/) | Growth engineering take-home practice: an LLM API developer console with two instrumented A/B experiments | ✅ Implemented |
| [AI Chat Client](./ai-chat/) | Streaming chat with branching history, resumable answers, Stop, multi-device sync, and offline reading | ✅ Implemented |
| [Multi-Org Dashboard](./multi-org-dashboard/) | Multi-tenant AI console: per-org roles, feature flags, org switching, revocation on open pages, revocable share links, and background exports | ✅ Implemented |
| [LLM Chat Analytics](./llm-chat-analytics/) | Near-real-time chat usage, latency and cost dashboards: dedup, late data with watermarks, org-local days, drill-down, role-gated metrics | ✅ Implemented |

### Infrastructure & System Components

| Project | Description | Status |
|---------|-------------|--------|
| [Rate Limiter](./rate-limiter/) | API rate limiting service | ✅ Implemented |
| [Job Scheduler](./job-scheduler/) | Distributed task scheduling | ✅ Implemented |
| [Ad Click Aggregator](./ad-click-aggregator/) | Real-time analytics aggregation | ✅ Implemented |
| [News Aggregator](./news-aggregator/) | Content aggregation and curation | ✅ Implemented |
| [Dashboarding](./dashboarding/) | Metrics monitoring and visualization | ✅ Implemented |
| [Notification System](./notification-system/) | High-traffic push notifications | ✅ Implemented |
| [APNs](./apns/) | Apple Push Notification Service | ✅ Implemented |
| [iCloud Sync](./icloud/) | File and photo synchronization | ✅ Implemented |
| [Scalable API](./scalable-api/) | API serving millions of users | ✅ Implemented |
| [Storage Remediation](./storage-remediation/) | Fleet-wide cloud storage security fixes with usage evidence, waves, rollback and exceptions; doubles as an existing-system-review example | ✅ Implemented |

### UI Components & Patterns

| Project | Description | Status |
|---------|-------------|--------|
| [Gallery](./gallery/) | Image gallery with Slideshow, Masonry, and Tiles views | ✅ Implemented |

### Personal Projects & Experiments

External projects demonstrating system design concepts (with local architecture documentation):

| Project | Description | Status |
|---------|-------------|--------|
| [MD Reader](./mdreader/) | Progressive Web App for Markdown editing ([source](https://github.com/evgenyvinnik/mdreader)) | 📝 Design Only |
| [MCPlator](./mcplator/) | Retro calculator with LLM-powered AI assistant ([source](https://github.com/evgenyvinnik/MCPlator)) | 📝 Design Only |
| [20 Forms, 40 Designs](./20forms-20designs/) | Form library comparison across 41 React design systems ([source](https://github.com/evgenyvinnik/20forms-20designs)) | 📝 Design Only |

### Planned Projects

Two rounds are in progress, and their built projects are listed in the tables above. The AI products and developer platforms round has 7 of 18 built: Prompt Playground, AI Chat Client, LLM Chat Analytics, Multi-Org Dashboard, In-App Assistant, File System and Console Growth. The [rail operations track](./ROADMAP.md#rail-operations-track-bnsf) for BNSF Railway loops has 3 of 6 built: Railcar Health, Locomotive Fueling and Storage Remediation. The rest are below. See [ROADMAP.md](./ROADMAP.md) for each project's scope, core entities, hard problems and interview follow-ups.

| Project | Description | Status |
|---------|-------------|--------|
| [Settings Service](./ROADMAP.md#3-settings-service) | Backend for an existing preferences UI: precise APIs, concurrency, and org policies | 📋 Planned |
| [LLM Inference API](./ROADMAP.md#5-llm-inference-api) | Multi-tenant model API with admission control, batching, and backend routing | 📋 Planned |
| [Webhook Platform](./ROADMAP.md#6-webhook-platform) | Signed, retried, replayable HTTP event delivery with per-endpoint isolation | 📋 Planned |
| [Document Q&A](./ROADMAP.md#8-document-qa) | Upload, process, index, retrieve, and delete documents for an assistant | 📋 Planned |
| [Experimentation Platform](./ROADMAP.md#9-experimentation-platform) | Feature flags, A/B assignment, exposure logging, and kill switches | 📋 Planned |
| [LLM Eval Dashboard](./ROADMAP.md#10-llm-eval-dashboard) | Versioned datasets, async eval runs, and provenance-aware comparisons | 📋 Planned |
| [CI/CD Platform](./ROADMAP.md#11-cicd-platform) | GitHub Actions-like workflows with job DAGs, runners, and live logs | 📋 Planned |
| [AI Code Review](./ROADMAP.md#12-ai-code-review) | Design critique and rebuild of an agentic PR auto-approval system | 📋 Planned |
| [Freight Quote Service](./ROADMAP.md#22-freight-quote-service) | High-traffic quote endpoint over slow pricing and capacity services: budgets, firm vs indicative, shedding | 📋 Planned |
| [Railcar Trip Plans](./ROADMAP.md#23-railcar-trip-plans-and-etas) | Car tracking against trip plans, missed connections, and dwell-based ETAs for shippers | 📋 Planned |
| [Yard Switch Lists](./ROADMAP.md#24-yard-switch-lists) | Classification yard planning with replanning, yardmaster overrides and execution feedback | 📋 Planned |
| [File Cache](./ROADMAP.md#13-file-cache) | Byte-bounded cache for large files with single-flight fills | 📋 Planned |
| [Model Distribution](./ROADMAP.md#14-model-distribution) | Peer-assisted distribution of a huge file to a fleet, then safe activation | 📋 Planned |
| [Online Chess](./ROADMAP.md#15-online-chess) | Real-time games with authoritative state, clocks, matchmaking, and spectators | 📋 Planned |

## Interview Practice

Some projects rehearse a specific interview format, not only a design question:

| Format | Where to practice |
|--------|-------------------|
| Frontend system design round | Rehearse in this order: [AI Chat Client](./ai-chat/system-design-answer-frontend.md) (with [In-App Assistant](./in-app-assistant/system-design-answer-frontend.md) for the sidebar variant), then [Multi-Org Dashboard](./multi-org-dashboard/system-design-answer-frontend.md), then [LLM Chat Analytics](./llm-chat-analytics/system-design-answer-frontend.md). The [Frontend Round Map](./ROADMAP.md#frontend-round-map) explains what each one covers |
| Leveled online coding assessment | [File System](./file-system/README.md#practice-mode): `npm run practice` shows one level at a time and unlocks the next only when the current one's tests pass. There are two problems, a file store and a key-value database |
| Product engineering take-home | [Console Growth](./console-growth/): find growth opportunities in a metrics snapshot, then ship two instrumented A/B experiments with a readout |
| Existing system review round | [Storage Remediation](./storage-remediation/existing-system-review.md): a ten-minute walkthrough script, key decisions with alternatives, an incident and a bank of likely probes. Use it as a template for presenting a system you built |
| Rail-themed loop (BNSF) | Rehearse in this order: [Railcar Health](./railcar-health/), [Locomotive Fueling](./locomotive-fueling/), then [Storage Remediation](./storage-remediation/). The [rail operations track](./ROADMAP.md#rail-operations-track-bnsf) has format notes and figures for estimates |

## Project Structure

Each project folder contains:

| File | Purpose |
|------|---------|
| `README.md` | Implementation guide, setup instructions, and testing details |
| `architecture.md` | System design documentation, architectural decisions, and trade-offs |
| `system-design-answer-{frontend,backend,fullstack}.md` | Interview-style answers tailored by role (45-minute format) |
| `CLAUDE.md` | LLM collaboration notes and iteration history |
| `screenshots/` | UI captures taken by the screenshot harness |
| `tests/` | Playwright smoke tests generated from the screenshot config |
| Source code | Actual implementation (varies by project) |

## Getting Started

1. Choose a system design challenge that interests you
2. Read the `architecture.md` to understand the design decisions
3. Follow the `README.md` for setup and implementation details
4. Review `CLAUDE.md` to see how the system evolved through LLM collaboration

## LLM-Assisted Development

This repository leverages Claude and other LLMs to:
- Rapidly prototype architectural ideas
- Generate boilerplate code and infrastructure
- Explore different implementation approaches
- Debug and optimize systems
- Document design decisions

See [CLAUDE.md](./CLAUDE.md) for guidelines on collaborating with AI on system design projects.

## Scripts

Utility scripts for repository management, run from the repository root:

```bash
# Count SLOC for the whole repository, or one project
npm run sloc
npm run sloc scale-ai

# Refresh the Codebase Stats table in every project README
npm run sloc:update

# Screenshots: start Docker, backend and frontend, capture, then stop everything
node scripts/screenshots.mjs --start instagram
npm run screenshots:all

# Smoke tests: generate from screenshot configs, then run against a running stack
npm run generate-tests instagram
npm run test:smoke instagram

# Triage: bring a project up (Docker, migrate, seed) and check that it works
npm run triage instagram
npm run triage:report
```

There is no CI build. Smoke tests need the full Docker stack, so projects are verified locally with `npm run build` / `npm run type-check`, then triage or screenshots, then smoke tests. [CLAUDE.md](./CLAUDE.md#cicd) explains why.

## Learning Approach

1. **Understand the requirements** - What problem are we solving?
2. **Design the architecture** - What components do we need?
3. **Identify key challenges** - What are the hard parts?
4. **Implement incrementally** - Start simple, add complexity
5. **Test and iterate** - Does it work? Can it scale?
6. **Reflect and document** - What did we learn?

## Skills Developed

- Distributed systems design
- Database schema design and optimization
- API design and versioning
- Caching strategies
- Load balancing and horizontal scaling
- Real-time data processing
- Message queues and event-driven architecture
- Security and authentication
- Monitoring and observability

## Contributing

This is a personal learning repository, but feel free to fork it and create your own implementations! Different approaches to the same problem are valuable learning opportunities.

## License

MIT License - Feel free to use this for your own learning and interview preparation.

---

**Remember**: The goal isn't to build production-ready systems, but to gain hands-on experience with system design concepts. Start simple, iterate, and learn by doing!
