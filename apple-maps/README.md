# Design Apple Maps - Navigation Platform

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 4,521 |
| Source Files | 35 |
| .js | 1,623 |
| .md | 1,144 |
| .tsx | 856 |
| .ts | 534 |
| .css | 139 |

## Overview

A simplified Apple Maps-like platform demonstrating mapping, routing, real-time traffic, and turn-by-turn navigation. This educational project focuses on building a navigation system with live traffic updates and ETA prediction.

## Features

### Implemented

- **Map Rendering**: Interactive map with Leaflet and OpenStreetMap tiles
- **Place Search**: Search for places by name with autocomplete
- **Geocoding**: Convert addresses to coordinates
- **Routing Engine**: A* pathfinding algorithm with traffic-aware weights
- **Turn-by-Turn Navigation**: Maneuver generation with directions
- **Real-Time Traffic**: Simulated traffic conditions with congestion levels
- **POI Display**: Points of interest with categories and ratings
- **Incident Reporting**: Traffic incidents display and reporting

### Key Technical Features

1. **A* Routing Algorithm**
   - Priority queue implementation with binary min-heap
   - Traffic-aware edge weights
   - Support for avoiding tolls and highways

2. **Traffic Simulation**
   - Simulated rush hour patterns
   - Congestion level calculation (free, light, moderate, heavy)
   - Real-time updates every 10 seconds

3. **Navigation**
   - Turn angle calculation and classification
   - Maneuver instruction generation
   - ETA calculation based on traffic

## Tech Stack

- **Frontend**: TypeScript, Vite, React 19, Zustand, Tailwind CSS, Leaflet
- **Backend**: Node.js, Express
- **Database**: PostgreSQL with PostGIS extension
- **Cache**: Redis

## Getting Started

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### Quick Start with Docker

1. **Start infrastructure services**:

```bash
cd apple-maps
docker-compose up -d
```

This starts:
- PostgreSQL with PostGIS on port 5432
- Redis on port 6379

2. **Install backend dependencies and seed database**:

```bash
cd backend
npm install
npm run seed
```

3. **Start the backend**:

```bash
npm run dev
```

The backend runs on http://localhost:3001

4. **Install frontend dependencies and start**:

```bash
cd ../frontend
npm install
npm run dev
```

The frontend runs on http://localhost:5173

### Native Setup (without Docker)

If you prefer to run PostgreSQL and Redis natively:

1. **Install PostgreSQL with PostGIS**:

```bash
# macOS with Homebrew
brew install postgresql@16 postgis

# Start PostgreSQL
brew services start postgresql@16

# Create database
createdb apple_maps
psql apple_maps -c "CREATE EXTENSION postgis;"
```

2. **Install Redis**:

```bash
# macOS with Homebrew
brew install redis
brew services start redis
```

3. **Set environment variables** (optional, defaults are provided):

```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=your_username
export DB_PASSWORD=your_password
export DB_NAME=apple_maps
export REDIS_HOST=localhost
export REDIS_PORT=6379
```

4. **Initialize the database schema**:

```bash
psql apple_maps -f backend/db/init.sql
```

5. **Continue with steps 2-4 from Quick Start**

## API Endpoints

### Routing

```
POST /api/routes
{
  "origin": { "lat": 37.77, "lng": -122.42 },
  "destination": { "lat": 37.78, "lng": -122.41 },
  "options": { "avoidTolls": false, "avoidHighways": false }
}
```

### Search

```
GET /api/search?q=coffee&lat=37.77&lng=-122.42&radius=5000
GET /api/search/geocode?address=Market%20Street
GET /api/search/reverse?lat=37.77&lng=-122.42
GET /api/search/places/:id
GET /api/search/categories
```

### Traffic

```
GET /api/traffic?minLat=37.76&minLng=-122.43&maxLat=37.79&maxLng=-122.40
GET /api/traffic/incidents?minLat=37.76&minLng=-122.43&maxLat=37.79&maxLng=-122.40
POST /api/traffic/incidents
DELETE /api/traffic/incidents/:id
```

### Map Data

```
GET /api/map/nodes?minLat=&minLng=&maxLat=&maxLng=
GET /api/map/segments?minLat=&minLng=&maxLat=&maxLng=
GET /api/map/pois?minLat=&minLng=&maxLat=&maxLng=&category=
```

### Health Check

```
GET /health
```

## Usage

1. **View Map**: The application displays an interactive map centered on San Francisco
2. **Search**: Use the search bar to find places and addresses
3. **Set Route**: Click on the map to set origin (first click) and destination (second click)
4. **Get Directions**: Click "Get Directions" to calculate a route
5. **Start Navigation**: Click "Start" to begin turn-by-turn navigation
6. **Toggle Layers**: Use the controls on the right to toggle traffic, POIs, and incidents

## Project Structure

```
apple-maps/
├── docker-compose.yml       # PostgreSQL and Redis services
├── backend/
│   ├── package.json
│   ├── db/
│   │   ├── init.sql         # Database schema
│   │   └── seed.js          # Sample data seeder
│   └── src/
│       ├── index.js         # Express server
│       ├── db.js            # PostgreSQL connection
│       ├── redis.js         # Redis connection
│       ├── routes/
│       │   ├── routes.js    # Routing API
│       │   ├── search.js    # Search/geocoding API
│       │   └── traffic.js   # Traffic API
│       ├── services/
│       │   ├── routingService.js   # A* algorithm
│       │   ├── searchService.js    # Search/geocoding
│       │   └── trafficService.js   # Traffic simulation
│       └── utils/
│           └── geo.js       # Geographic utilities
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── index.css
        ├── components/
        │   ├── MapView.tsx      # Leaflet map
        │   ├── SearchBar.tsx    # Search component
        │   ├── RoutePanel.tsx   # Route/navigation panel
        │   └── MapControls.tsx  # Layer toggles
        ├── stores/
        │   └── mapStore.ts      # Zustand state
        ├── services/
        │   └── api.ts           # API client
        └── types/
            └── index.ts         # TypeScript types
```

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./CLAUDE.md) for development insights and design decisions.

## Running Multiple Backend Instances

For load testing or distributed development:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Key Technical Challenges

1. **Routing Scale**: Computing routes efficiently using A* with priority queue
2. **Real-Time Traffic**: Simulating and aggregating traffic conditions
3. **Map Matching**: Snapping GPS coordinates to road network
4. **ETA Accuracy**: Predicting arrival times with traffic
5. **Offline Navigation**: (Future) Functioning without connectivity

## References & Inspiration

- [MapKit Documentation](https://developer.apple.com/documentation/mapkit) - Apple's mapping framework for iOS and macOS applications
- [MapKit JS](https://developer.apple.com/documentation/mapkitjs) - Apple Maps for web applications
- [OSRM - Open Source Routing Machine](https://project-osrm.org/) - High-performance routing engine for shortest paths
- [Contraction Hierarchies Paper](https://algo2.iti.kit.edu/schultes/hwy/contract.pdf) - Academic paper on fast routing preprocessing
- [Map Matching with Hidden Markov Models](https://www.microsoft.com/en-us/research/publication/hidden-markov-map-matching-through-noise-and-sparseness/) - Microsoft Research on GPS-to-road matching
- [PostGIS Documentation](https://postgis.net/documentation/) - Spatial database extension for geographic queries
- [Leaflet Documentation](https://leafletjs.com/) - Open-source JavaScript library for interactive maps
- [Valhalla Routing Engine](https://github.com/valhalla/valhalla) - Open-source routing with turn-by-turn navigation
