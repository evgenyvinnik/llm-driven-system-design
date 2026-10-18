import { createApp } from './app.js';

// API_PORT rather than PORT: tools that start the dev server often set PORT for the web port.
const port = Number(process.env.API_PORT ?? 3001);

createApp().listen(port, () => {
  console.log(`[api] Console API listening on http://localhost:${port}`);
});
