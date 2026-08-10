# Google Sheets - Collaborative Spreadsheet

A real-time collaborative spreadsheet application with virtualized rendering, formula support, and multi-user editing capabilities.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 6,844 |
| Source Files | 47 |
| .ts | 4,059 |
| .md | 1,401 |
| .tsx | 852 |
| .sql | 212 |
| .json | 147 |


## Features

### Core Spreadsheet
- Virtualized grid supporting 1000+ rows and columns
- Cell editing with double-click or typing
- Arrow key, Tab, and Enter navigation
- Cell selection (single and range)
- Column and row headers (A, B, C... and 1, 2, 3...)

### Real-Time Collaboration
- Multiple users can edit the same spreadsheet simultaneously
- Live cursor tracking (see where others are)
- Selection sharing (see what others have selected)
- Presence indicators with user colors
- WebSocket-based sync with optimistic updates

### Formulas (Basic)
- Simple arithmetic (=1+2)
- SUM function (=SUM(1,2,3))
- More formulas can be added with HyperFormula integration

## Prerequisites

- Node.js 18+
- Docker & Docker Compose (for infrastructure)

## Quick Start

### 1. Start Infrastructure

```bash
cd google-sheets
docker-compose up -d
```

This starts:
- PostgreSQL (port 5432) - spreadsheet data
- Redis (port 6379) - pub/sub for real-time sync

### 2. Setup Backend

```bash
cd backend
npm install
npm run db:migrate
npm run dev
```

Server runs on http://localhost:3001

### 3. Setup Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173

### 4. Test Collaboration

1. Open http://localhost:5173 in one browser
2. Copy the URL (includes spreadsheet ID)
3. Open the same URL in another browser/incognito window
4. Enter different names when prompted
5. Edit cells and see changes sync in real-time!

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Browser 1     │     │   Browser 2     │
│   (Alice)       │     │   (Bob)         │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │    WebSocket          │
         └───────────┬───────────┘
                     │
         ┌───────────▼───────────┐
         │   Express + WS Server │
         │   (Port 3001)         │
         └───────────┬───────────┘
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
   ┌──────────┐           ┌──────────┐
   │ PostgreSQL│           │  Redis   │
   │  (Data)   │           │ (Pub/Sub)│
   └──────────┘           └──────────┘
```

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/spreadsheets | List all spreadsheets |
| POST | /api/spreadsheets | Create new spreadsheet |
| GET | /api/spreadsheets/:id | Get spreadsheet details |
| PATCH | /api/spreadsheets/:id | Update title |
| DELETE | /api/spreadsheets/:id | Delete spreadsheet |
| GET | /api/sheets/:sheetId/cells | Get all cells |
| PATCH | /api/sheets/:sheetId/cells | Batch update cells |
| GET | /api/spreadsheets/:id/export | Export as CSV |

### WebSocket Messages

**Client → Server:**
- `CELL_EDIT` - Edit a cell
- `CURSOR_MOVE` - Move cursor
- `SELECTION_CHANGE` - Change selection
- `RESIZE_COLUMN` - Resize column
- `RESIZE_ROW` - Resize row

**Server → Client:**
- `STATE_SYNC` - Full state on connect
- `CELL_UPDATED` - Cell was changed
- `USER_JOINED` - New collaborator
- `USER_LEFT` - Collaborator left
- `CURSOR_MOVED` - Other user moved cursor
- `SELECTION_CHANGED` - Other user changed selection

## Technology Stack

| Component | Technology |
|-----------|------------|
| Frontend | React 19, TypeScript, Vite |
| Virtualization | @tanstack/react-virtual |
| State Management | Zustand |
| Backend | Node.js, Express |
| WebSocket | ws library |
| Database | PostgreSQL |
| Cache/Pub-Sub | Redis |

## Development

### Run Tests

```bash
cd backend
npm test
```

### Lint Code

```bash
cd backend && npm run lint
cd frontend && npm run lint
```

### Format Code

```bash
cd backend && npm run format
cd frontend && npm run format
```

## Future Enhancements

- [ ] HyperFormula integration for full Excel-compatible formulas
- [ ] Column/row resizing with drag handles
- [ ] Cell formatting (bold, colors, alignment)
- [ ] Copy/paste with clipboard API
- [ ] Undo/redo with history
- [ ] Multi-sheet support
- [ ] Export to Excel (.xlsx)
- [ ] Mobile touch support
- [ ] Offline mode with sync

## References

- [TanStack Virtual](https://tanstack.com/virtual/latest) - Virtualization library
- [HyperFormula](https://hyperformula.handsontable.com/) - Excel-compatible formula engine
- [Zustand](https://zustand-demo.pmnd.rs/) - State management
- [Google Sheets API](https://developers.google.com/sheets/api) - Design inspiration

## License

MIT
