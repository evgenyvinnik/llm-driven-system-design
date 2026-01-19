import { Router, Request, Response } from 'express';
import { templateService, ChannelTemplate } from '../services/templates.js';
import { adminMiddleware } from '../middleware/auth.js';

const router: Router = Router();

interface CreateTemplateRequest {
  id: string;
  name: string;
  description?: string;
  channels: Record<string, ChannelTemplate>;
  variables?: string[];
}

interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  channels?: Record<string, ChannelTemplate>;
  variables?: string[];
}

interface PreviewTemplateRequest {
  channel: string;
  data?: Record<string, unknown>;
}

interface DatabaseError extends Error {
  code?: string;
}

// Get all templates
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const templates = await templateService.getAllTemplates();
    res.json({ templates });
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
});

// Get template by ID
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const template = await templateService.getTemplate(req.params.id as string);

    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json(template);
  } catch (error) {
    console.error('Get template error:', error);
    res.status(500).json({ error: 'Failed to get template' });
  }
});

// Create template (admin only)
router.post('/', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, name, description, channels, variables } = req.body as CreateTemplateRequest;

    if (!id || !name || !channels) {
      res.status(400).json({ error: 'id, name, and channels are required' });
      return;
    }

    // Validate ID format
    if (!/^[a-z0-9_-]+$/.test(id)) {
      res.status(400).json({ error: 'id must contain only lowercase letters, numbers, hyphens, and underscores' });
      return;
    }

    const template = await templateService.createTemplate({
      id,
      name,
      description,
      channels,
      variables,
      createdBy: req.user!.id,
    });

    res.status(201).json(template);
  } catch (error) {
    console.error('Create template error:', error);
    if ((error as DatabaseError).code === '23505') {
      res.status(409).json({ error: 'Template with this ID already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// Update template (admin only)
router.patch('/:id', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, description, channels, variables } = req.body as UpdateTemplateRequest;

    const template = await templateService.updateTemplate(req.params.id as string, {
      name,
      description,
      channels,
      variables,
    });

    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json(template);
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// Delete template (admin only)
router.delete('/:id', adminMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await templateService.deleteTemplate(req.params.id as string);

    if (!deleted) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ message: 'Template deleted' });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// Preview template rendering
router.post('/:id/preview', async (req: Request, res: Response): Promise<void> => {
  try {
    const template = await templateService.getTemplate(req.params.id as string);

    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const { channel, data } = req.body as PreviewTemplateRequest;

    if (!channel) {
      res.status(400).json({ error: 'channel is required' });
      return;
    }

    try {
      const rendered = templateService.renderTemplate(template, channel, data || {});
      res.json({ rendered });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  } catch (error) {
    console.error('Preview template error:', error);
    res.status(500).json({ error: 'Failed to preview template' });
  }
});

export default router;
