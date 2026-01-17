# Word Count Plugin

Displays real-time word, character, and line counts in the status bar.

## Features

- **Live Stats**: Updates as you type
- **Word Count**: Number of words in the document
- **Character Count**: Total characters including spaces
- **Line Count**: Number of lines

## Installation

From the marketplace:
1. Open the Plugin Marketplace
2. Search for "Word Count"
3. Click Install

Or for development:
```bash
npm install
npm run build
```

## Usage

After installation, word count statistics appear in the status bar at the bottom of the editor.

## Slots

This plugin contributes to:
- **statusbar** (order: 0) - Word/character/line counts

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
- `editor.content` - Subscribed to for counting

### Settings
- `showWords` - Show/hide word count (default: true)
- `showChars` - Show/hide character count (default: true)
- `showLines` - Show/hide line count (default: true)

## License

MIT
