import { Request, Response } from 'express';
import { reviewService } from '../services/reviewService.js';

export async function getReviewsForApp(req: Request, res: Response): Promise<void> {
  const { appId } = req.params;
  const { page = '1', limit = '20', sortBy = 'recent' } = req.query;

  const reviews = await reviewService.getReviewsForApp(appId, {
    page: parseInt(page as string, 10),
    limit: Math.min(parseInt(limit as string, 10), 50),
    sortBy: sortBy as string,
  });

  res.json(reviews);
}

export async function getRatingSummary(req: Request, res: Response): Promise<void> {
  const { appId } = req.params;
  const summary = await reviewService.getRatingSummary(appId);
  res.json({ data: summary });
}

export async function createReview(req: Request, res: Response): Promise<void> {
  const { appId } = req.params;
  const { rating, title, body } = req.body;

  if (!rating || rating < 1 || rating > 5) {
    res.status(400).json({ error: 'Rating must be between 1 and 5' });
    return;
  }

  const review = await reviewService.createReview(
    req.user!.id,
    appId,
    { rating, title, body }
  );

  res.status(201).json({ data: review });
}

export async function updateReview(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { rating, title, body } = req.body;

  if (rating && (rating < 1 || rating > 5)) {
    res.status(400).json({ error: 'Rating must be between 1 and 5' });
    return;
  }

  const review = await reviewService.updateReview(id, req.user!.id, { rating, title, body });

  if (!review) {
    res.status(404).json({ error: 'Review not found or not authorized' });
    return;
  }

  res.json({ data: review });
}

export async function deleteReview(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const deleted = await reviewService.deleteReview(id, req.user!.id);

  if (!deleted) {
    res.status(404).json({ error: 'Review not found or not authorized' });
    return;
  }

  res.json({ success: true });
}

export async function voteReview(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { helpful } = req.body;

  if (typeof helpful !== 'boolean') {
    res.status(400).json({ error: 'helpful must be a boolean' });
    return;
  }

  await reviewService.voteReview(id, req.user!.id, helpful);
  res.json({ success: true });
}

export async function respondToReview(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { response } = req.body;

  if (!response || typeof response !== 'string') {
    res.status(400).json({ error: 'Response text is required' });
    return;
  }

  const review = await reviewService.addDeveloperResponse(id, req.user!.id, response);

  if (!review) {
    res.status(404).json({ error: 'Review not found' });
    return;
  }

  res.json({ data: review });
}
