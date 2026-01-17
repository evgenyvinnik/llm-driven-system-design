import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';
import crypto from 'crypto';

const router = Router();

interface ExperimentRow {
  id: string;
  name: string;
  description: string | null;
  allocation_percent: number;
  variants: string;
  target_groups: string;
  metrics: string[];
  status: string;
  start_date: Date | null;
  end_date: Date | null;
  created_at: Date;
}

interface AllocationRow {
  experiment_id: string;
  variant_id: string;
}

interface Variant {
  id: string;
  name: string;
  weight: number;
  config: Record<string, unknown>;
}

/**
 * Simple hash function for consistent allocation
 */
function murmurhash(str: string): number {
  const hash = crypto.createHash('md5').update(str).digest();
  return hash.readUInt32LE(0);
}

/**
 * GET /api/experiments
 * List all experiments
 */
router.get('/', authenticate, async (_req: Request, res: Response) => {
  try {
    const experiments = await query<ExperimentRow>(
      `SELECT * FROM experiments ORDER BY created_at DESC`
    );

    res.json({
      experiments: experiments.map((exp) => ({
        id: exp.id,
        name: exp.name,
        description: exp.description,
        allocationPercent: exp.allocation_percent,
        variants: JSON.parse(exp.variants),
        targetGroups: JSON.parse(exp.target_groups),
        metrics: exp.metrics,
        status: exp.status,
        startDate: exp.start_date,
        endDate: exp.end_date,
      })),
    });
  } catch (error) {
    console.error('List experiments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/experiments/:id
 * Get experiment details
 */
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const experiment = await queryOne<ExperimentRow>(
      'SELECT * FROM experiments WHERE id = $1',
      [id]
    );

    if (!experiment) {
      res.status(404).json({ error: 'Experiment not found' });
      return;
    }

    res.json({
      experiment: {
        id: experiment.id,
        name: experiment.name,
        description: experiment.description,
        allocationPercent: experiment.allocation_percent,
        variants: JSON.parse(experiment.variants),
        targetGroups: JSON.parse(experiment.target_groups),
        metrics: experiment.metrics,
        status: experiment.status,
        startDate: experiment.start_date,
        endDate: experiment.end_date,
      },
    });
  } catch (error) {
    console.error('Get experiment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/experiments
 * Create a new experiment
 */
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const {
      name,
      description,
      allocationPercent = 100,
      variants,
      targetGroups = {},
      metrics = [],
      startDate,
      endDate,
    } = req.body;

    if (!name || !variants || !Array.isArray(variants) || variants.length < 2) {
      res.status(400).json({ error: 'Name and at least 2 variants required' });
      return;
    }

    // Validate variant weights sum to 100
    const totalWeight = variants.reduce((sum: number, v: Variant) => sum + (v.weight || 0), 0);
    if (totalWeight !== 100) {
      res.status(400).json({ error: 'Variant weights must sum to 100' });
      return;
    }

    const experiment = await queryOne<ExperimentRow>(
      `INSERT INTO experiments (name, description, allocation_percent, variants, target_groups, metrics, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name,
        description,
        allocationPercent,
        JSON.stringify(variants),
        JSON.stringify(targetGroups),
        metrics,
        startDate,
        endDate,
      ]
    );

    if (!experiment) {
      res.status(500).json({ error: 'Failed to create experiment' });
      return;
    }

    res.status(201).json({
      experiment: {
        id: experiment.id,
        name: experiment.name,
        description: experiment.description,
        allocationPercent: experiment.allocation_percent,
        variants: JSON.parse(experiment.variants),
        status: experiment.status,
      },
    });
  } catch (error) {
    console.error('Create experiment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/experiments/:id/status
 * Update experiment status
 */
router.put('/:id/status', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['draft', 'active', 'paused', 'completed'].includes(status)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }

    const experiment = await queryOne<ExperimentRow>(
      `UPDATE experiments SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );

    if (!experiment) {
      res.status(404).json({ error: 'Experiment not found' });
      return;
    }

    res.json({
      experiment: {
        id: experiment.id,
        name: experiment.name,
        status: experiment.status,
      },
    });
  } catch (error) {
    console.error('Update experiment status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/experiments/:id/allocation
 * Get experiment allocation for current profile
 */
router.get('/:id/allocation', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const profileId = req.profileId;

    if (!profileId) {
      res.status(400).json({ error: 'Profile selection required' });
      return;
    }

    // Check for existing allocation
    let allocation = await queryOne<AllocationRow>(
      'SELECT experiment_id, variant_id FROM experiment_allocations WHERE experiment_id = $1 AND profile_id = $2',
      [id, profileId]
    );

    if (allocation) {
      res.json({ variantId: allocation.variant_id });
      return;
    }

    // Get experiment
    const experiment = await queryOne<ExperimentRow>(
      'SELECT * FROM experiments WHERE id = $1 AND status = $2',
      [id, 'active']
    );

    if (!experiment) {
      res.json({ variantId: null });
      return;
    }

    // Allocate user to variant
    const variantId = allocateToExperiment(profileId, experiment);

    if (variantId) {
      // Store allocation
      await query(
        `INSERT INTO experiment_allocations (experiment_id, profile_id, variant_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (experiment_id, profile_id) DO UPDATE SET variant_id = $3`,
        [id, profileId, variantId]
      );
    }

    res.json({ variantId });
  } catch (error) {
    console.error('Get allocation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/experiments/allocations
 * Get all experiment allocations for current profile
 */
router.post('/allocations', authenticate, async (req: Request, res: Response) => {
  try {
    const profileId = req.profileId;

    if (!profileId) {
      res.status(400).json({ error: 'Profile selection required' });
      return;
    }

    // Get all active experiments
    const experiments = await query<ExperimentRow>(
      `SELECT * FROM experiments WHERE status = 'active'`
    );

    const allocations: Record<string, string | null> = {};

    for (const exp of experiments) {
      // Check for existing allocation
      let allocation = await queryOne<AllocationRow>(
        'SELECT variant_id FROM experiment_allocations WHERE experiment_id = $1 AND profile_id = $2',
        [exp.id, profileId]
      );

      if (allocation) {
        allocations[exp.id] = allocation.variant_id;
      } else {
        // Allocate
        const variantId = allocateToExperiment(profileId, exp);
        if (variantId) {
          await query(
            `INSERT INTO experiment_allocations (experiment_id, profile_id, variant_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (experiment_id, profile_id) DO NOTHING`,
            [exp.id, profileId, variantId]
          );
        }
        allocations[exp.id] = variantId;
      }
    }

    res.json({ allocations });
  } catch (error) {
    console.error('Get allocations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Allocate a user to an experiment variant using consistent hashing
 */
function allocateToExperiment(profileId: string, experiment: ExperimentRow): string | null {
  // Hash user+experiment for consistent allocation
  const hash = murmurhash(`${profileId}:${experiment.id}`);
  const bucket = hash % 100;

  // Check if user is in experiment population
  if (bucket >= experiment.allocation_percent) {
    return null; // Not in experiment
  }

  // Parse variants
  const variants: Variant[] = JSON.parse(experiment.variants);

  // Determine which variant based on weights
  let accumulated = 0;
  const experimentBucket = hash % experiment.allocation_percent;

  for (const variant of variants) {
    accumulated += (variant.weight / 100) * experiment.allocation_percent;
    if (experimentBucket < accumulated) {
      return variant.id;
    }
  }

  return variants[0]?.id || null;
}

export default router;
