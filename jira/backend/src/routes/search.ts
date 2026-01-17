import { Router } from 'express';
import * as searchService from '../services/searchService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Search issues with JQL
router.get('/', requireAuth, async (req, res) => {
  try {
    const {
      jql,
      text,
      projectId,
      limit,
      offset,
      sortField,
      sortOrder,
    } = req.query;

    const result = await searchService.searchIssuesWithJQL(
      {
        jql: jql ? String(jql) : undefined,
        text: text ? String(text) : undefined,
        projectId: projectId ? String(projectId) : undefined,
        limit: limit ? parseInt(String(limit), 10) : undefined,
        offset: offset ? parseInt(String(offset), 10) : undefined,
        sortField: sortField ? String(sortField) : undefined,
        sortOrder: sortOrder as 'asc' | 'desc' | undefined,
      },
      req.user?.id
    );

    res.json(result);
  } catch (error: unknown) {
    console.error('Search error:', error);
    if ((error as Error).message?.startsWith('Invalid JQL')) {
      return res.status(400).json({ error: (error as Error).message });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// Quick search
router.get('/quick', requireAuth, async (req, res) => {
  try {
    const { q, projectId, limit } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const issues = await searchService.quickSearch(
      String(q),
      projectId ? String(projectId) : undefined,
      limit ? parseInt(String(limit), 10) : 10
    );

    res.json({ issues });
  } catch (error) {
    console.error('Quick search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get search suggestions
router.get('/suggestions', requireAuth, async (req, res) => {
  try {
    const { field, prefix, projectId } = req.query;

    if (!field || !prefix) {
      return res.status(400).json({ error: 'Field and prefix are required' });
    }

    const suggestions = await searchService.getSearchSuggestions(
      String(field),
      String(prefix),
      projectId ? String(projectId) : undefined
    );

    res.json({ suggestions });
  } catch (error) {
    console.error('Suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

// Get filter aggregations
router.get('/aggregations', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.query;

    const aggregations = await searchService.getFilterAggregations(
      projectId ? String(projectId) : undefined
    );

    res.json({ aggregations });
  } catch (error) {
    console.error('Aggregations error:', error);
    res.status(500).json({ error: 'Failed to get aggregations' });
  }
});

// Validate JQL
router.post('/validate', requireAuth, (req, res) => {
  const { jql } = req.body;

  if (!jql) {
    return res.status(400).json({ error: 'JQL is required' });
  }

  const result = searchService.validateJQL(jql);
  res.json(result);
});

export default router;
