# Paper Background Plugin

A plugin for the Pluggable Text Editor that provides different paper styles for the editor background.

## Features

- **6 Paper Styles**: Plain, Ruled, Checkered, Dotted, Graph, Legal Pad
- **Dark Mode Support**: Automatically adjusts colors for dark mode
- **Persistent Settings**: Remembers your paper selection

## Installation

From the marketplace:
1. Open the Plugin Marketplace
2. Search for "Paper Background"
3. Click Install

Or for development:
```bash
npm install
npm run build
```

## Usage

After installation, you'll see a "Paper" dropdown in the toolbar. Select your preferred paper style.

## Slots

This plugin contributes to:
- **canvas** (order: 0) - The paper background layer
- **toolbar** (order: 100) - The paper selection dropdown

## Development

```bash
# Install dependencies
npm install

# Build the plugin
npm run build

# Watch for changes during development
npm run dev
```

## API

### State Keys Used
- `theme.paper` - Current paper style ID

### Events Emitted
- `theme:paper-changed` - When user changes paper style

## Available Papers

| ID | Name | Description |
|-----|------|-------------|
| `plain` | Plain | Clean white background |
| `ruled` | Ruled | Blue horizontal lines like notebook paper |
| `checkered` | Checkered | Grid pattern |
| `dotted` | Dotted | Dot grid pattern |
| `graph` | Graph | Fine green graph paper grid |
| `legal` | Legal Pad | Yellow with orange lines |

## License

MIT
