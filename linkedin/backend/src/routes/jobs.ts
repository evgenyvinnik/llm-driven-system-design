/**
 * Job routes for the LinkedIn clone.
 * Handles job listings, search, applications, and recommendations.
 * Includes admin routes for job posting and applicant management.
 *
 * Static paths (/recommended, /companies, /my/applications) are registered before
 * /:id; Express matches in order, so /:id used to swallow /companies.
 *
 * @module routes/jobs
 */
import { Router, Request, Response } from 'express';
import * as jobService from '../services/jobService.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { searchQueriesTotal } from '../utils/metrics.js';
import { parseId, sendApiError } from '../utils/errors.js';

const router = Router();

function pageParams(req: Request, defaultLimit: number): { offset: number; limit: number } {
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || defaultLimit, 1), 100);
  return { offset, limit };
}

// Search/list jobs
router.get('/', readRateLimit, async (req: Request, res: Response) => {
  try {
    const { q, location, is_remote, employment_type, experience_level, company_id } = req.query;
    const { offset, limit } = pageParams(req, 20);
    // Only an explicit "true" filters; omitting the flag must not hide remote jobs.
    const filters = {
      location: (location as string) || undefined,
      is_remote: is_remote === 'true' ? true : undefined,
      employment_type: (employment_type as string) || undefined,
      experience_level: (experience_level as string) || undefined,
    };

    if (typeof q === 'string' && q.trim()) {
      searchQueriesTotal.inc({ type: 'job' });
      const { jobs, source } = await jobService.searchJobs(q.trim(), filters, offset, limit);
      res.json({ jobs, source });
      return;
    }

    const jobs = await jobService.getJobs(
      { ...filters, company_id: company_id ? parseId(company_id, 'company_id') : undefined },
      offset,
      limit
    );
    res.json({ jobs });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error }, 'Get jobs error');
    res.status(500).json({ error: 'Failed to get jobs' });
  }
});

// Get recommended jobs for current user
router.get('/recommended', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);
    const jobs = await jobService.getRecommendedJobs(req.session.userId!, limit);
    res.json({ jobs });
  } catch (error) {
    logger.error({ error }, 'Get recommended jobs error');
    res.status(500).json({ error: 'Failed to get recommended jobs' });
  }
});

// Company routes
router.get('/companies', readRateLimit, async (req: Request, res: Response) => {
  try {
    const { offset, limit } = pageParams(req, 50);
    const companies = await jobService.getAllCompanies(offset, limit);
    res.json({ companies });
  } catch (error) {
    logger.error({ error }, 'Get companies error');
    res.status(500).json({ error: 'Failed to get companies' });
  }
});

router.get('/companies/:slug', readRateLimit, async (req: Request, res: Response) => {
  try {
    const company = await jobService.getCompanyBySlug(req.params.slug);
    if (!company) {
      res.status(404).json({ error: 'Company not found' });
      return;
    }
    res.json({ company });
  } catch (error) {
    logger.error({ error }, 'Get company error');
    res.status(500).json({ error: 'Failed to get company' });
  }
});

router.post('/companies', requireAdmin, async (req: Request, res: Response) => {
  try {
    const company = await jobService.createCompany(req.body);
    res.status(201).json({ company });
  } catch (error) {
    logger.error({ error }, 'Create company error');
    res.status(500).json({ error: 'Failed to create company' });
  }
});

// Get my applications
router.get('/my/applications', requireAuth, readRateLimit, async (req: Request, res: Response) => {
  try {
    const applications = await jobService.getUserApplications(req.session.userId!);
    res.json({ applications });
  } catch (error) {
    logger.error({ error }, 'Get applications error');
    res.status(500).json({ error: 'Failed to get applications' });
  }
});

// Update application status (admin only)
router.patch('/applications/:id/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { status } = req.body ?? {};
    if (!['pending', 'reviewed', 'accepted', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'Invalid status' });
      return;
    }
    const application = await jobService.updateApplicationStatus(parseId(req.params.id), status);

    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }

    res.json({ application });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error }, 'Update application status error');
    res.status(500).json({ error: 'Failed to update application status' });
  }
});

// Create job (admin only)
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const job = await jobService.createJob({
      ...req.body,
      posted_by_user_id: req.session.userId,
    });
    res.status(201).json({ job });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error }, 'Create job error');
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// Get single job
router.get('/:id', readRateLimit, async (req: Request, res: Response) => {
  try {
    const job = await jobService.getJobById(parseId(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Calculate match score if user is logged in
    let matchScore = null;
    if (req.session.userId) {
      matchScore = await jobService.calculateJobMatchScore(job.id, req.session.userId);
    }

    res.json({ job, match_score: matchScore });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error }, 'Get job error');
    res.status(500).json({ error: 'Failed to get job' });
  }
});

// Apply for job
router.post('/:id/apply', requireAuth, writeRateLimit, async (req: Request, res: Response) => {
  try {
    const application = await jobService.applyForJob(
      parseId(req.params.id),
      req.session.userId!,
      {
        resume_url: typeof req.body?.resume_url === 'string' ? req.body.resume_url : undefined,
        cover_letter: typeof req.body?.cover_letter === 'string' ? req.body.cover_letter : undefined,
      }
    );
    res.status(201).json({ application });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error }, 'Apply job error');
    res.status(500).json({ error: 'Failed to apply for job' });
  }
});

// Get job applicants (admin only)
router.get('/:id/applicants', requireAdmin, async (req: Request, res: Response) => {
  try {
    const applicants = await jobService.getJobApplicants(parseId(req.params.id));
    res.json({ applicants });
  } catch (error) {
    if (sendApiError(res, error)) return;
    logger.error({ error }, 'Get applicants error');
    res.status(500).json({ error: 'Failed to get applicants' });
  }
});

export default router;
