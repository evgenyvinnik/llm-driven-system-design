# Text Editor Plugin

The core text editing component for the Pluggable Text Editor.

## Features

- **Responsive Textarea**: Full-size text editing area
- **Auto-save**: Content saved to local storage
- **Format Support**: Respects font family and size from other plugins
- **Theme Support**: Adapts to light/dark mode

## Installation

From the marketplace:
1. Open the Plugin Marketplace
2. Search for "Text Editor"
3. Click Install

Or for development:
```bash
npm install
npm run build
```

## Usage

After installation, the text editor appears in the canvas slot. Type your content and it will be automatically saved.

## Slots

This plugin contributes to:
- **canvas** (order: 10) - The main text editing area

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
- `editor.content` - Current text content
- `editor.selection` - Current selection range
- `format.fontFamily` - Font family to use
- `format.fontSize` - Font size to use
- `theme.mode` - Current theme (light/dark)

### Events Emitted
- `editor:content-changed` - When content is modified
- `editor:selection-changed` - When selection changes

### Commands Registered
- `editor.clear` - Clear all content

## License

MIT
