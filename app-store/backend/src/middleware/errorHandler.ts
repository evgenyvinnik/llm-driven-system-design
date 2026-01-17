import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  console.error('Error:', err);

  if (err.message.includes('already exists') || err.message.includes('already reviewed')) {
    res.status(409).json({ error: err.message });
    return;
  }

  if (err.message.includes('Invalid') || err.message.includes('not found')) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err.message.includes('Not authorized') || err.message.includes('Insufficient')) {
    res.status(403).json({ error: err.message });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}
