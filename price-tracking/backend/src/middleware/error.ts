import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error(`Error: ${err.message}`, { stack: err.stack, path: req.path });

  // Handle known error types
  if (err.message.includes('already')) {
    res.status(409).json({ error: err.message });
    return;
  }

  if (err.message.includes('Invalid') || err.message.includes('required')) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err.message.includes('not found')) {
    res.status(404).json({ error: err.message });
    return;
  }

  // Default error
  res.status(500).json({ error: 'Internal server error' });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'Endpoint not found' });
}

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
    });
  });

  next();
}
