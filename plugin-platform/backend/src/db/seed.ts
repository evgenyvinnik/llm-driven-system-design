import bcrypt from 'bcryptjs';
import { pool } from '../shared/db.js';
import { logger } from '../shared/logger.js';

async function seed() {
  const client = await pool.connect();

  try {
    // Create official developer account
    const passwordHash = await bcrypt.hash('dev123', 10);

    const { rows: [developer] } = await client.query(`
      INSERT INTO users (username, email, password_hash, display_name, is_developer)
      VALUES ('official', 'plugins@editor.local', $1, 'Official Plugins', true)
      ON CONFLICT (username) DO UPDATE SET display_name = 'Official Plugins'
      RETURNING id
    `, [passwordHash]);

    logger.info({ developerId: developer.id }, 'Created/updated official developer account');

    // Seed the bundled plugins
    const plugins = [
      {
        id: 'paper-background',
        name: 'Paper Background',
        description: 'Choose different paper styles for your editor background. Includes plain, ruled, checkered, dotted, graph, and legal pad styles.',
        category: 'appearance',
        is_official: true,
        manifest: {
          id: 'paper-background',
          name: 'Paper Background',
          version: '1.0.0',
          description: 'Choose different paper styles for your editor background',
          contributes: {
            slots: [
              { slot: 'canvas', component: 'PaperBackground', order: 0 },
              { slot: 'toolbar', component: 'PaperSelector', order: 100 }
            ]
          }
        }
      },
      {
        id: 'font-selector',
        name: 'Font Selector',
        description: 'Choose fonts and sizes for your text. Includes system, serif, sans-serif, monospace, and handwriting fonts.',
        category: 'formatting',
        is_official: true,
        manifest: {
          id: 'font-selector',
          name: 'Font Selector',
          version: '1.0.0',
          description: 'Choose fonts and sizes for your text',
          contributes: {
            slots: [
              { slot: 'toolbar', component: 'FontSelector', order: 10 }
            ]
          }
        }
      },
      {
        id: 'text-editor',
        name: 'Text Editor',
        description: 'Core text editing functionality. Provides the main text input area with auto-save.',
        category: 'core',
        is_official: true,
        manifest: {
          id: 'text-editor',
          name: 'Text Editor',
          version: '1.0.0',
          description: 'Core text editing functionality',
          contributes: {
            slots: [
              { slot: 'canvas', component: 'TextEditor', order: 50 }
            ]
          }
        }
      },
      {
        id: 'word-count',
        name: 'Word Count',
        description: 'Display word, character, and line counts in the status bar. Updates in real-time as you type.',
        category: 'productivity',
        is_official: true,
        manifest: {
          id: 'word-count',
          name: 'Word Count',
          version: '1.0.0',
          description: 'Display word and character counts',
          contributes: {
            slots: [
              { slot: 'statusbar', component: 'WordCount', order: 100 }
            ]
          }
        }
      },
      {
        id: 'theme',
        name: 'Theme Switcher',
        description: 'Toggle between light and dark mode. Automatically detects system preference.',
        category: 'appearance',
        is_official: true,
        manifest: {
          id: 'theme',
          name: 'Theme Switcher',
          version: '1.0.0',
          description: 'Toggle between light and dark mode',
          contributes: {
            slots: [
              { slot: 'toolbar', component: 'ThemeToggle', order: 200 }
            ]
          }
        }
      }
    ];

    for (const plugin of plugins) {
      // Insert plugin
      await client.query(`
        INSERT INTO plugins (id, author_id, name, description, category, is_official, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'published')
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          category = EXCLUDED.category,
          updated_at = NOW()
      `, [plugin.id, developer.id, plugin.name, plugin.description, plugin.category, plugin.is_official]);

      // Insert version
      await client.query(`
        INSERT INTO plugin_versions (plugin_id, version, bundle_url, manifest)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (plugin_id, version) DO NOTHING
      `, [plugin.id, '1.0.0', `/plugins/${plugin.id}/bundle.js`, JSON.stringify(plugin.manifest)]);

      // Add tags
      const tags = [plugin.category, 'official', 'bundled'];
      for (const tag of tags) {
        await client.query(`
          INSERT INTO plugin_tags (plugin_id, tag)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [plugin.id, tag]);
      }

      logger.info({ pluginId: plugin.id }, 'Seeded plugin');
    }

    logger.info('Seed completed successfully');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  logger.error(err, 'Seed failed');
  process.exit(1);
});
