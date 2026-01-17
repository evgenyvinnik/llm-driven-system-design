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

Each folder contains an independent implementation of a system design problem.

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
| [Kindle Highlights](./kindle-highlights/) | Social reading platform with real-time sync | 📝 Design Only |

### Messaging & Communication

| Project | Description | Status |
|---------|-------------|--------|
| [WhatsApp](./whatsapp/) | Real-time messaging platform | ✅ Implemented |
| [Discord](./discord/) | Real-time chat and community platform | ✅ Implemented |
| [Slack](./slack/) | Team communication and collaboration | ✅ Implemented |
| [iMessage](./imessage/) | Cross-device messaging with offline sync | ✅ Implemented |
| [FaceTime](./facetime/) | Real-time video calling | ✅ Implemented |

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

### Ticketing, Events & Reservations

| Project | Description | Status |
|---------|-------------|--------|
| [Ticketmaster](./ticketmaster/) | Event ticketing and inventory management | ✅ Implemented |
| [Hotel Booking](./hotel-booking/) | Hotel reservation and management system | ✅ Implemented |
| [Calendly](./calendly/) | Meeting scheduling and calendar coordination | ✅ Implemented |

### Developer & Productivity Tools

| Project | Description | Status |
|---------|-------------|--------|
| [LeetCode](./leetcode/) | Online coding judge and practice platform | ✅ Implemented |
| [Google Docs](./google-docs/) | Collaborative document editing | ✅ Implemented |
| [Figma](./figma/) | Collaborative design and prototyping platform | ✅ Implemented |
| [GitHub](./github/) | Code hosting and version control | ✅ Implemented |
| [Notion](./notion/) | Collaborative workspace with blocks | ✅ Implemented |
| [Jira](./jira/) | Issue tracking and project management | ✅ Implemented |
| [Collaborative Editor](./collaborative-editor/) | Real-time document editing | ✅ Implemented |
| [AI Code Assistant](./ai-code-assistant/) | CLI coding assistant like Claude Code/Cursor | 📝 Design Only |
| [Plugin Platform](./plugin-platform/) | VS Code-like extension system with sandboxing | 📝 Design Only |

### Financial Services & Payments

| Project | Description | Status |
|---------|-------------|--------|
| [Robinhood](./robinhood/) | Stock trading platform | ✅ Implemented |
| [Payment System](./payment-system/) | Transaction processing system | ✅ Implemented |
| [Stripe](./stripe/) | Payment processing and APIs | ✅ Implemented |
| [Venmo](./venmo/) | P2P payment platform | ✅ Implemented |
| [Apple Pay](./apple-pay/) | Secure mobile payments | ✅ Implemented |

### Business Services

| Project | Description | Status |
|---------|-------------|--------|
| [DocuSign](./docusign/) | Electronic signature platform | ✅ Implemented |

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

### Personal Projects & Experiments

External projects demonstrating system design concepts (with local architecture documentation):

| Project | Description | Status |
|---------|-------------|--------|
| [MD Reader](./mdreader/) | Progressive Web App for Markdown editing ([source](https://github.com/evgenyvinnik/mdreader)) | 📝 Design Only |
| [MCPlator](./mcplator/) | Retro calculator with LLM-powered AI assistant ([source](https://github.com/evgenyvinnik/MCPlator)) | 📝 Design Only |
| [20 Forms, 40 Designs](./20forms-20designs/) | Form library comparison across 41 React design systems ([source](https://github.com/evgenyvinnik/20forms-20designs)) | 📝 Design Only |

## Project Structure

Each project folder contains:

| File | Purpose |
|------|---------|
| `README.md` | Implementation guide, setup instructions, and testing details |
| `architecture.md` | System design documentation, architectural decisions, and trade-offs |
| `system-design-answer.md` | Interview-style answer (45-minute format) |
| `claude.md` | LLM collaboration notes and iteration history |
| Source code | Actual implementation (varies by project) |

## Getting Started

1. Choose a system design challenge that interests you
2. Read the `architecture.md` to understand the design decisions
3. Follow the `README.md` for setup and implementation details
4. Review `claude.md` to see how the system evolved through LLM collaboration

## LLM-Assisted Development

This repository leverages Claude and other LLMs to:
- Rapidly prototype architectural ideas
- Generate boilerplate code and infrastructure
- Explore different implementation approaches
- Debug and optimize systems
- Document design decisions

See [CLAUDE.md](./CLAUDE.md) for guidelines on collaborating with AI on system design projects.

## Scripts

Utility scripts for repository management:

```bash
# Count SLOC for entire repository
node scripts/sloc.mjs

# Count SLOC for specific project
node scripts/sloc.mjs scale-ai

# Output as JSON
node scripts/sloc.mjs scale-ai --json

# Output summary for README embedding
node scripts/sloc.mjs scale-ai --summary
```

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
