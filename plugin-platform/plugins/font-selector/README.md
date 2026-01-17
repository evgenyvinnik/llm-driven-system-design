# Font Selector Plugin

Choose fonts and sizes for your text in the Pluggable Text Editor.

## Features

- **7 Font Families**: System, Serif, Sans Serif, Monospace, Comic, Handwriting, Typewriter
- **12 Font Sizes**: From 10px to 64px
- **Live Preview**: See font in the dropdown
- **Persistent Settings**: Remembers your selections

## Installation

From the marketplace:
1. Open the Plugin Marketplace
2. Search for "Font Selector"
3. Click Install

Or for development:
```bash
npm install
npm run build
```

## Usage

After installation, you'll see "Font" and "Size" dropdowns in the toolbar. Select your preferred font family and size.

## Slots

This plugin contributes to:
- **toolbar** (order: 10) - Font and size dropdowns

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
- `format.fontFamily` - Current font family CSS value
- `format.fontSize` - Current font size in pixels

### Events Emitted
- `format:font-changed` - When font family changes
- `format:size-changed` - When font size changes

### Settings
- `defaultFont` - Default font family (default: 'system-ui')
- `defaultSize` - Default font size (default: 16)

## Available Fonts

| ID | Name | Font Stack |
|-----|------|------------|
| `system` | System | system-ui, -apple-system, sans-serif |
| `serif` | Serif | Georgia, "Times New Roman", serif |
| `sans` | Sans Serif | Arial, Helvetica, sans-serif |
| `mono` | Monospace | Monaco, "Courier New", monospace |
| `comic` | Comic | "Comic Sans MS", cursive |
| `handwriting` | Handwriting | "Brush Script MT", cursive |
| `typewriter` | Typewriter | "American Typewriter", monospace |

## License

MIT
