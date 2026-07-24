/**
 * Seeds real repositories so the home page, explore, and repo pages show
 * actual content. Each repo is a genuine bare Git repo on disk (created via the
 * same git service the app uses) with an initial README commit — so file
 * browsing, commit history, and the rendered README all work, not just DB rows.
 *
 * Run with: npm run db:seed:repos  (after npm run db:seed which creates users)
 */
import { query } from './index.js';
import * as gitService from '../services/git.js';

interface SeedRepo {
  owner: string;
  name: string;
  description: string;
  language: string;
  stars: number;
  forks: number;
  readme: string;
}

const REPOS: SeedRepo[] = [
  {
    owner: 'johndoe',
    name: 'awesome-api',
    description: 'A blazing-fast REST API framework for Node.js with built-in validation.',
    language: 'TypeScript',
    stars: 1284,
    forks: 176,
    readme:
      '# awesome-api\n\nA blazing-fast REST API framework for Node.js.\n\n## Features\n\n- Type-safe routes\n- Built-in request validation\n- Middleware pipeline\n- OpenAPI generation\n\n## Install\n\n```\nnpm install awesome-api\n```\n\n## Quick start\n\nDefine a route, attach a handler, and the framework does the rest.\n',
  },
  {
    owner: 'johndoe',
    name: 'react-charts',
    description: 'Composable, accessible chart components for React 19.',
    language: 'TypeScript',
    stars: 842,
    forks: 63,
    readme:
      '# react-charts\n\nComposable, accessible chart components for React.\n\n## Charts\n\n- Line, Area, Bar\n- Sparklines\n- Gauges & stat tiles\n\nEvery chart is theme-aware and keyboard navigable.\n',
  },
  {
    owner: 'janedoe',
    name: 'go-cache',
    description: 'A distributed in-memory cache with consistent hashing, written in Go.',
    language: 'Go',
    stars: 2103,
    forks: 289,
    readme:
      '# go-cache\n\nA distributed in-memory cache with consistent hashing.\n\n## Design\n\n- 150 virtual nodes per physical node\n- LRU eviction with TTL\n- Snapshot persistence for warm restarts\n\nSee the architecture doc for the coordinator/node split.\n',
  },
  {
    owner: 'janedoe',
    name: 'ml-toolkit',
    description: 'Minimal machine-learning utilities: preprocessing, metrics, and model I/O.',
    language: 'Python',
    stars: 567,
    forks: 91,
    readme:
      '# ml-toolkit\n\nMinimal machine-learning utilities.\n\n## Modules\n\n- `preprocess` — scaling, encoding, splitting\n- `metrics` — precision, recall, F1, ROC-AUC\n- `io` — save/load models as portable artifacts\n',
  },
  {
    owner: 'admin',
    name: 'infra-scripts',
    description: 'Terraform modules and shell scripts for bootstrapping cloud infrastructure.',
    language: 'HCL',
    stars: 318,
    forks: 44,
    readme:
      '# infra-scripts\n\nTerraform modules and shell scripts for cloud infrastructure.\n\n## Modules\n\n- VPC + subnets\n- Managed Postgres\n- Kubernetes cluster\n- Observability stack\n',
  },
];

async function seedRepos(): Promise<void> {
  console.log('Seeding repositories (real git repos on disk)...');

  for (const repo of REPOS) {
    const ownerRows = await query('SELECT id FROM users WHERE username = $1', [repo.owner]);
    if (ownerRows.rows.length === 0) {
      console.warn(`  owner ${repo.owner} not found, skipping ${repo.name}`);
      continue;
    }
    const ownerId = ownerRows.rows[0].id;

    const existing = await query('SELECT id FROM repositories WHERE owner_id = $1 AND name = $2', [ownerId, repo.name]);
    if (existing.rows.length > 0) {
      console.log(`  ${repo.owner}/${repo.name} already present, skipping`);
      continue;
    }

    // The on-disk repo dir survives `docker-compose down -v` (it's on the host,
    // not a volume), so a re-seed after the DB is wiped would hit an existing
    // dir and `git init --bare` would fail — leaving zero repos. Remove any
    // stale dir first so seeding is idempotent against the filesystem too.
    await gitService.deleteRepository(repo.owner, repo.name);

    // Create the bare repo on disk, then push an initial README commit into it.
    const storagePath = await gitService.initRepository(repo.owner, repo.name);
    await gitService.initWithReadme(repo.owner, repo.name, repo.description);

    await query(
      `INSERT INTO repositories
         (owner_id, name, description, is_private, default_branch, storage_path, language, stars_count, forks_count, watchers_count)
       VALUES ($1, $2, $3, FALSE, 'main', $4, $5, $6, $7, $8)`,
      [ownerId, repo.name, repo.description, storagePath, repo.language, repo.stars, repo.forks, Math.round(repo.stars / 10)]
    );

    console.log(`  seeded ${repo.owner}/${repo.name} (${repo.language}, ★${repo.stars})`);
  }

  console.log('Repository seeding complete.');
  process.exit(0);
}

seedRepos().catch((err: Error) => {
  console.error('Repo seed error:', err);
  process.exit(1);
});
