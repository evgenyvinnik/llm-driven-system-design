import { Router } from 'express';
import { getAllAssignments, getExperiment, logExposure } from '../lib/experiments.js';
import { notFound } from '../lib/errors.js';

const router = Router();

// Assignments for the current user and org, with Dev toolbar overrides applied.
router.get('/experiments', (req, res) => {
  res.json({ experiments: getAllAssignments(req) });
});

// The client reports exposures here rather than through POST /api/events, so the variant on
// the exposure always comes from the server's assignment, never from the browser.
router.post('/experiments/:key/exposure', (req, res) => {
  if (!getExperiment(req.params.key)) throw notFound(`Unknown experiment "${req.params.key}".`);
  const props = req.body?.props && typeof req.body.props === 'object' ? req.body.props : {};
  const record = logExposure(req, req.params.key, { ...props, path: req.body?.path ?? null }, { source: 'client' });
  res.status(202).json({ logged: Boolean(record), variant: record?.props.variant ?? null });
});

export default router;
