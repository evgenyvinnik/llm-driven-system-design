# MCPlator - Retro Calculator with AI Co-Pilot

A fully functional retro Casio-style calculator with an LLM-powered AI assistant that understands natural language and controls the calculator through animated key presses.

**Live Demo:** [mcplator.com](https://mcplator.com/)

**Source Code:** [github.com/evgenyvinnik/MCPlator](https://github.com/evgenyvinnik/MCPlator)

## Features

- **Authentic Casio Calculator** - Complete functionality (memory, percentage, square root, sign change, etc.)
- **Polished Retro UI** - CSS Modules with authentic 3D button effects and LCD display
- **LLM-Powered AI Chat** - Natural language calculator control ("add 2 plus one hundred", "what's 15% of 80")
- **LMCIFY Sharing** - "Let Me Calculate It For You" - share calculations via URL with animated playback
- **Persistent State** - IndexedDB for calculator memory, chat history, and daily quota

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser Client                           │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐     ┌─────────────────────────────┐    │
│  │   Calculator UI     │     │      AI Chat Panel          │    │
│  │  (Retro CSS)        │◀───▶│   (Natural Language)        │    │
│  └──────────┬──────────┘     └──────────────┬──────────────┘    │
│             │                               │                    │
│  ┌──────────▼──────────┐     ┌──────────────▼──────────────┐    │
│  │  Calculator Engine  │     │    Message Processor        │    │
│  │  (Computation)      │     │  (Parse → Key Sequences)    │    │
│  └──────────┬──────────┘     └──────────────┬──────────────┘    │
│             │                               │                    │
│  ┌──────────▼───────────────────────────────▼──────────────┐    │
│  │              Zustand State Management                    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                          │                                       │
│  ┌───────────────────────▼──────────────────────────────────┐    │
│  │              IndexedDB (Persistence)                      │    │
│  └───────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│                    Native Fetch (SSE Streaming)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Vercel Serverless Functions (Edge)                  │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    /api/chat Endpoint                      │  │
│  │  - Receives natural language requests                     │  │
│  │  - Calls Claude Haiku 4.5 API                             │  │
│  │  - Streams SSE responses with key sequences               │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Anthropic Claude API                          │
│                  (Claude Haiku 4.5 Model)                        │
└─────────────────────────────────────────────────────────────────┘
```

See [architecture.md](./architecture.md) for detailed design documentation.

## Tech Stack

### Frontend
- **Framework:** React 19 + TypeScript 5.9
- **Build:** Vite 7.3
- **State Management:** Zustand + IndexedDB (manual persistence)
- **Styling:** CSS Modules + Tailwind CSS 4.1 (hybrid approach)
- **Storage:** IndexedDB (via `idb` library)
- **Streaming:** Native `fetch` API for SSE

### Backend
- **Platform:** Vercel Serverless Functions (Edge Runtime)
- **AI:** Anthropic Claude API (Claude Haiku 4.5 model)
- **Streaming:** Server-Sent Events (SSE) for real-time token streaming

## System Design Concepts Demonstrated

1. **Server-Sent Events (SSE)** - Real-time streaming from AI to browser
2. **Edge Functions** - Low-latency serverless compute
3. **LLM Integration** - Natural language to structured actions
4. **State Persistence** - IndexedDB for client-side storage
5. **URL-based Sharing** - Compressed message encoding in URLs

## Development

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Build for production
bun run build

# Run tests
bun run test

# Run linting
bun run lint
```

## Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

## Notes

This is an external project. The full source code and implementation details are available in the [MCPlator repository](https://github.com/evgenyvinnik/MCPlator).
