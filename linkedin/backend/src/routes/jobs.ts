/**
 * Job routes for the LinkedIn clone.
 * Handles job listings, search, applications, and recommendations.
 * Includes admin routes for job posting and applicant management.
 *
 * @module routes/jobs
 */
import { Router, Request, Response } from 'express';
import * as jobService from '../services/jobService.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

// Search/list jobs
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      q,
      location,
      is_remote,
      employment_type,
      experience_level,
      company_id,
      offset,
      limit,
    } = req.query;

    let jobs;
    if (q) {
      jobs = await jobService.searchJobs(
        q as string,
        {
          location: location as string,
          is_remote: is_remote === 'true',
          employment_type: employment_type as string,
          experience_level: experience_level as string,
        },
        parseInt(offset as string) || 0,
        parseInt(limit as string) || 20
      );
    } else {
      jobs = await jobService.getJobs(
        {
          company_id: company_id ? parseInt(company_id as string) : undefined,
          location: location as string,
          is_remote: is_remote === 'true' ? true : undefined,
          employment_type: employment_type as string,
          experience_level: experience_level as string,
        },
        parseInt(offset as string) || 0,
        parseInt(limit as string) || 20
      );
    }

    res.json({ jobs });
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({ error: 'Failed to get jobs' });
  }
});

// Get recommended jobs for current user
router.get('/recommended', requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const jobs = await jobService.getRecommendedJobs(req.session.userId!, limit);
    res.json({ jobs });
  } catch (error) {
    console.error('Get recommended jobs error:', error);
    res.status(500).json({ error: 'Failed to get recommended jobs' });
  }
});

// Get single job
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const job = await jobService.getJobById(parseInt(req.params.id));
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
    console.error('Get job error:', error);
    res.status(500).json({ error: 'Failed to get job' });
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
    console.error('Create job error:', error);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// Apply for job
router.post('/:id/apply', requireAuth, async (req: Request, res: Response) => {
  try {
    const application = await jobService.applyForJob(
      parseInt(req.params.id),
      req.session.userId!,
      req.body
    );
    res.status(201).json({ application });
  } catch (error) {
    console.error('Apply job error:', error);
    res.status(500).json({ error: 'Failed to apply for job' });
  }
});

// Get my applications
router.get('/my/applications', requireAuth, async (req: Request, res: Response) => {
  try {
    const applications = await jobService.getUserApplications(req.session.userId!);
    res.json({ applications });
  } catch (error) {
    console.error('Get applications error:', error);
    res.status(500).json({ error: 'Failed to get applications' });
  }
});

// Get job applicants (admin only)
router.get('/:id/applicants', requireAdmin, async (req: Request, res: Response) => {
  try {
    const applicants = await jobService.getJobApplicants(parseInt(req.params.id));
    res.json({ applicants });
  } catch (error) {
    console.error('Get applicants error:', error);
    res.status(500).json({ error: 'Failed to get applicants' });
  }
});

// Update application status (admin only)
router.patch('/applications/:id/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const application = await jobService.updateApplicationStatus(parseInt(req.params.id), status);

    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }

    res.json({ application });
  } catch (error) {
    console.error('Update application status error:', error);
    res.status(500).json({ error: 'Failed to update application status' });
  }
});

// Company routes
router.get('/companies', async (req: Request, res: Response) => {
  try {
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 50;
    const companies = await jobService.getAllCompanies(offset, limit);
    res.json({ companies });
  } catch (error) {
    console.error('Get companies error:', error);
    res.status(500).json({ error: 'Failed to get companies' });
  }
});

router.get('/companies/:slug', async (req: Request, res: Response) => {
  try {
    const company = await jobService.getCompanyBySlug(req.params.slug);
    if (!company) {
      res.status(404).json({ error: 'Company not found' });
      return;
    }
    res.json({ company });
  } catch (error) {
    console.error('Get company error:', error);
    res.status(500).json({ error: 'Failed to get company' });
  }
});

router.post('/companies', requireAdmin, async (req: Request, res: Response) => {
  try {
    const company = await jobService.createCompany(req.body);
    res.status(201).json({ company });
  } catch (error) {
    console.error('Create company error:', error);
    res.status(500).json({ error: 'Failed to create company' });
  }
});

export default router;
