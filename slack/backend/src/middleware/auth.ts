import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

export function requireWorkspace(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.workspaceId) {
    res.status(400).json({ error: 'Workspace context required. Please select a workspace.' });
    return;
  }
  next();
}
