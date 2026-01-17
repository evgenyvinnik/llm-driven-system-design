# LLM-Driven System Design Practice

## 🎯 Vision

Traditional system design interview preparation often relies on passive learning - reading articles, watching YouTube videos, and memorizing architectural patterns. While valuable, this approach lacks the hands-on experience that comes from actually building systems.

This repository represents a different approach: **learning system design by actually implementing it**.

With the assistance of LLMs like Claude, we can rapidly prototype lightweight versions of classic (and creative) system design interview questions. This hands-on practice helps develop:

- **Architectural thinking** - Making real trade-offs, not theoretical ones
- **Implementation experience** - Understanding what actually works vs. what looks good on a whiteboard
- **Technology selection** - Choosing the right tools for each use case
- **Scalability patterns** - Building systems that can grow
- **Problem-solving skills** - Debugging and iterating on real implementations

## 📚 System Design Challenges

Each folder contains an independent implementation of a system design problem:

### URL Shortening & Web Services
- [Design Bit.ly](./bitly/) - URL shortening service
- [Design Web Crawler](./web-crawler/) - Distributed web crawling system

### Storage & File Systems
- [Design Dropbox](./dropbox/) - Cloud file storage and synchronization
- [Design a Distributed Cache](./distributed-cache/) - High-performance caching layer

### Social Media & Content
- [Design FB News Feed](./fb-news-feed/) - Personalized content feed
- [Design FB Live Comments](./fb-live-comments/) - Real-time comment system
- [Design FB Post Search](./fb-post-search/) - Social media search engine
- [Design Instagram](./instagram/) - Photo sharing platform
- [Design Tinder](./tinder/) - Matching and recommendation system

### Messaging & Communication
- [Design WhatsApp](./whatsapp/) - Real-time messaging platform

### Video & Streaming
- [Design YouTube](./youtube/) - Video hosting and streaming platform
- [Design YouTube Top K](./youtube-top-k/) - Real-time trending video analytics

### E-Commerce & Marketplaces
- [Design Yelp](./yelp/) - Local business review platform
- [Design Online Auction](./online-auction/) - Bidding and auction system
- [Design a Price Tracking Service](./price-tracking/) - E-commerce price monitoring

### Transportation & Logistics
- [Design Uber](./uber/) - Ride-hailing platform
- [Design a Local Delivery Service](./local-delivery/) - Last-mile delivery system
- [Design Strava](./strava/) - Fitness tracking and social platform

### Ticketing & Events
- [Design Ticketmaster](./ticketmaster/) - Event ticketing and inventory management

### Developer Tools & Platforms
- [Design LeetCode](./leetcode/) - Online coding judge and practice platform
- [Design Google Docs](./google-docs/) - Collaborative document editing

### Financial Services
- [Design Robinhood](./robinhood/) - Stock trading platform
- [Design a Payment System](./payment-system/) - Transaction processing system

### Infrastructure & System Components
- [Design a Rate Limiter](./rate-limiter/) - API rate limiting service
- [Design a Job Scheduler](./job-scheduler/) - Distributed task scheduling
- [Design Ad Click Aggregator](./ad-click-aggregator/) - Real-time analytics aggregation
- [Design a News Aggregator](./news-aggregator/) - Content aggregation and curation

## 🏗️ Project Structure

Each project folder contains:

- **README.md** - Implementation guide, setup instructions, and testing details
- **architecture.md** - System design documentation, architectural decisions, and trade-offs
- **claude.md** - Collaboration notes, LLM-assisted development insights, and iteration history
- **Source code** - Actual implementation (varies by project)

## 🚀 Getting Started

1. Choose a system design challenge that interests you
2. Read the `architecture.md` to understand the design decisions
3. Follow the `README.md` for setup and implementation details
4. Review `claude.md` to see how the system evolved through LLM collaboration

## 🤖 LLM-Assisted Development

This repository leverages Claude and other LLMs to:
- Rapidly prototype architectural ideas
- Generate boilerplate code and infrastructure
- Explore different implementation approaches
- Debug and optimize systems
- Document design decisions

See [CLAUDE.md](./CLAUDE.md) for guidelines on collaborating with AI on system design projects.

## 📖 Learning Approach

1. **Understand the requirements** - What problem are we solving?
2. **Design the architecture** - What components do we need?
3. **Identify key challenges** - What are the hard parts?
4. **Implement incrementally** - Start simple, add complexity
5. **Test and iterate** - Does it work? Can it scale?
6. **Reflect and document** - What did we learn?

## 🎓 Skills Developed

- Distributed systems design
- Database schema design and optimization
- API design and versioning
- Caching strategies
- Load balancing and horizontal scaling
- Real-time data processing
- Message queues and event-driven architecture
- Security and authentication
- Monitoring and observability

## 🤝 Contributing

This is a personal learning repository, but feel free to fork it and create your own implementations! Different approaches to the same problem are valuable learning opportunities.

## 📝 License

MIT License - Feel free to use this for your own learning and interview preparation.

---

**Remember**: The goal isn't to build production-ready systems, but to gain hands-on experience with system design concepts. Start simple, iterate, and learn by doing!
