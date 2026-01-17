# Theme Plugin

Light and dark theme toggle with system preference detection.

## Features

- **Theme Toggle**: Switch between light and dark modes
- **System Detection**: Automatically detects system preference
- **Persistent Settings**: Remembers your theme choice
- **Live Updates**: Responds to system theme changes

## Installation

From the marketplace:
1. Open the Plugin Marketplace
2. Search for "Theme"
3. Click Install

Or for development:
```bash
npm install
npm run build
```

## Usage

After installation, you'll see a theme toggle button in the toolbar. Click to switch between light and dark modes.

## Slots

This plugin contributes to:
- **toolbar** (order: 100) - Theme toggle button

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
- `theme.mode` - Current theme ('light' or 'dark')

### Events Emitted
- `theme:mode-changed` - When theme changes

### Settings
- `useSystemTheme` - Follow system preference (default: true)

## License

MIT
