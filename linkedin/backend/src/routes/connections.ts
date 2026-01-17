/**
 * Connection routes for the LinkedIn clone.
 * Manages the professional network graph - connection requests,
 * acceptance/rejection, and network analysis (PYMK, mutual connections).
 *
 * @module routes/connections
 */
import { Router, Request, Response } from 'express';
import * as connectionService from '../services/connectionService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Get my connections
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 20;

    const connections = await connectionService.getConnectionsWithData(
      req.session.userId!,
      offset,
      limit
    );

    res.json({ connections });
  } catch (error) {
    console.error('Get connections error:', error);
    res.status(500).json({ error: 'Failed to get connections' });
  }
});

// Get pending connection requests
router.get('/requests', requireAuth, async (req: Request, res: Response) => {
  try {
    const requests = await connectionService.getPendingRequests(req.session.userId!);
    res.json({ requests });
  } catch (error) {
    console.error('Get requests error:', error);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

// Send connection request
router.post('/request', requireAuth, async (req: Request, res: Response) => {
  try {
    const { userId, message } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'User ID required' });
      return;
    }

    if (userId === req.session.userId) {
      res.status(400).json({ error: 'Cannot connect with yourself' });
      return;
    }

    const request = await connectionService.sendConnectionRequest(
      req.session.userId!,
      userId,
      message
    );

    res.status(201).json({ request });
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Send request error:', error);
    res.status(500).json({ error: 'Failed to send request' });
  }
});

// Accept connection request
router.post('/requests/:id/accept', requireAuth, async (req: Request, res: Response) => {
  try {
    await connectionService.acceptConnectionRequest(
      parseInt(req.params.id),
      req.session.userId!
    );
    res.json({ message: 'Connection accepted' });
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Accept request error:', error);
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

// Reject connection request
router.post('/requests/:id/reject', requireAuth, async (req: Request, res: Response) => {
  try {
    await connectionService.rejectConnectionRequest(
      parseInt(req.params.id),
      req.session.userId!
    );
    res.json({ message: 'Connection rejected' });
  } catch (error) {
    console.error('Reject request error:', error);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

// Remove connection
router.delete('/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    await connectionService.removeConnection(
      req.session.userId!,
      parseInt(req.params.userId)
    );
    res.json({ message: 'Connection removed' });
  } catch (error) {
    console.error('Remove connection error:', error);
    res.status(500).json({ error: 'Failed to remove connection' });
  }
});

// Get connection degree with a user
router.get('/degree/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const degree = await connectionService.getConnectionDegree(
      req.session.userId!,
      parseInt(req.params.userId)
    );
    res.json({ degree });
  } catch (error) {
    console.error('Get degree error:', error);
    res.status(500).json({ error: 'Failed to get connection degree' });
  }
});

// Get mutual connections
router.get('/mutual/:userId', requireAuth, async (req: Request, res: Response) => {
  try {
    const mutualIds = await connectionService.getMutualConnections(
      req.session.userId!,
      parseInt(req.params.userId)
    );

    const users = await connectionService.getConnectionsWithData(
      req.session.userId!,
      0,
      100
    );

    const mutualSet = new Set(mutualIds);
    const mutualConnections = users.filter(u => mutualSet.has(u.id));

    res.json({ mutual_connections: mutualConnections });
  } catch (error) {
    console.error('Get mutual connections error:', error);
    res.status(500).json({ error: 'Failed to get mutual connections' });
  }
});

// Get second-degree connections
router.get('/second-degree', requireAuth, async (req: Request, res: Response) => {
  try {
    const secondDegree = await connectionService.getSecondDegreeConnections(req.session.userId!);
    res.json({ connections: secondDegree.slice(0, 50) });
  } catch (error) {
    console.error('Get second-degree error:', error);
    res.status(500).json({ error: 'Failed to get second-degree connections' });
  }
});

// Get PYMK (People You May Know)
router.get('/pymk', requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const pymk = await connectionService.getPeopleYouMayKnow(req.session.userId!, limit);
    res.json({ people: pymk });
  } catch (error) {
    console.error('Get PYMK error:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

export default router;
