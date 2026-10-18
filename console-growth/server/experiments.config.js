// Experiment registry. Every experiment the app reads must be listed here.
//
//   key          Stable identifier, also the hash salt. Never reuse a key for a new experiment.
//   description  What the treatment changes, shown in the Dev toolbar.
//   unit         'user' or 'org': whose id is hashed. Use 'org' when teammates must see the same
//                thing (billing, limits); 'user' for purely personal UI.
//   variants     The first variant is the control: today's behavior, unchanged.
//   weights      Relative traffic per variant, same order as variants.
//   enabled      false is the kill switch: everyone gets the control and no exposures are logged.

export const EXPERIMENTS = [
  {
    key: 'dashboard_welcome_copy',
    description: 'Example: the Dashboard greeting names the organization.',
    unit: 'user',
    variants: ['control', 'treatment'],
    weights: [50, 50],
    enabled: true,
  },
  {
    // Large bet. Eligible: Build orgs without auto-reload whose balance runs out within 7 days
    // at their trailing spend, or already has. See EXPERIMENTS.md §2.
    key: 'credit_runway_autoreload',
    description: 'Banner on every page when credits will run out within 7 days, with one-click auto-reload.',
    unit: 'org',
    variants: ['control', 'treatment'],
    weights: [50, 50],
    enabled: true,
  },
  {
    // Small bet. Eligible: orgs with 429s in the last 7 days and credits left to buy before the
    // next tier. See EXPERIMENTS.md §3.
    key: 'rate_limit_upgrade_nudge',
    description: 'Usage page explains 429s and offers the exact purchase that unlocks the next tier.',
    unit: 'org',
    variants: ['control', 'treatment'],
    weights: [50, 50],
    enabled: true,
  },
];
