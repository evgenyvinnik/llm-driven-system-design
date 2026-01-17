// Word Count Plugin
// Displays word and character counts in the status bar

import { manifest } from './manifest';
import { WordCount } from './WordCount';

export { manifest, WordCount };

export function activate(): void {
  console.log('[word-count] Plugin activated');
}
