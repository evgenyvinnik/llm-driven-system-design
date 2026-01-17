import { Router } from 'express';
import { templateService } from '../services/templates.js';
import { adminMiddleware } from '../middleware/auth.js';

const router = Router();

// Get all templates
router.get('/', async (req, res) => {
  try {
    const templates = await templateService.getAllTemplates();
    res.json({ templates });
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
});

// Get template by ID
router.get('/:id', async (req, res) => {
  try {
    const template = await templateService.getTemplate(req.params.id);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json(template);
  } catch (error) {
    console.error('Get template error:', error);
    res.status(500).json({ error: 'Failed to get template' });
  }
});

// Create template (admin only)
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { id, name, description, channels, variables } = req.body;

    if (!id || !name || !channels) {
      return res.status(400).json({ error: 'id, name, and channels are required' });
    }

    // Validate ID format
    if (!/^[a-z0-9_-]+$/.test(id)) {
      return res.status(400).json({ error: 'id must contain only lowercase letters, numbers, hyphens, and underscores' });
    }

    const template = await templateService.createTemplate({
      id,
      name,
      description,
      channels,
      variables,
      createdBy: req.user.id,
    });

    res.status(201).json(template);
  } catch (error) {
    console.error('Create template error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Template with this ID already exists' });
    }
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// Update template (admin only)
router.patch('/:id', adminMiddleware, async (req, res) => {
  try {
    const { name, description, channels, variables } = req.body;

    const template = await templateService.updateTemplate(req.params.id, {
      name,
      description,
      channels,
      variables,
    });

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json(template);
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// Delete template (admin only)
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    const deleted = await templateService.deleteTemplate(req.params.id);

    if (!deleted) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({ message: 'Template deleted' });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// Preview template rendering
router.post('/:id/preview', async (req, res) => {
  try {
    const template = await templateService.getTemplate(req.params.id);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { channel, data } = req.body;

    if (!channel) {
      return res.status(400).json({ error: 'channel is required' });
    }

    try {
      const rendered = templateService.renderTemplate(template, channel, data || {});
      res.json({ rendered });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  } catch (error) {
    console.error('Preview template error:', error);
    res.status(500).json({ error: 'Failed to preview template' });
  }
});

export default router;
