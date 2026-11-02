import { Router, Request, Response } from "express";
import { feedbackService } from "../services/feedbackService.js";
import { validateBundleId } from "../utils/index.js";
import { requireProvider, canAccessBundle } from "../shared/auth.js";

/**
 * Feedback Routes.
 *
 * Provides the APNs Feedback Service API for app providers.
 * Providers poll these endpoints to learn about invalidated device tokens
 * so they can stop sending notifications to those devices.
 *
 * Requires a provider JWT whose key covers the app (or an admin session).
 *
 * Routes:
 * - GET /:appBundleId - Get feedback entries for an app
 * - DELETE /:appBundleId - Clear processed feedback entries
 */
const router = Router();

router.use(requireProvider());

/** 403 body when a provider asks for another app's feedback. */
const NOT_IN_SCOPE_RESPONSE = {
  error: "Forbidden",
  message: "This provider key does not cover that app",
};

/**
 * Get feedback entries for an app.
 * Returns invalid tokens that should be removed from the provider's database.
 * Supports filtering by timestamp to get only new feedback since last check.
 *
 * @route GET /api/v1/feedback/:appBundleId
 * @param appBundleId - App bundle identifier
 * @query since - ISO date string to filter feedback after
 * @returns {feedback: FeedbackEntry[]}
 */
router.get("/:appBundleId", async (req: Request, res: Response) => {
  try {
    const { appBundleId } = req.params;
    const { since } = req.query;

    if (!validateBundleId(appBundleId)) {
      return res.status(400).json({
        error: "InvalidBundleId",
        message: "Invalid app bundle ID format",
      });
    }

    if (!canAccessBundle(req.principal, appBundleId)) {
      return res.status(403).json(NOT_IN_SCOPE_RESPONSE);
    }

    const sinceDate = since ? new Date(since as string) : undefined;

    const feedback = await feedbackService.getFeedback(appBundleId, sinceDate);

    return res.json({ feedback });
  } catch (error) {
    console.error("Error getting feedback:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to get feedback",
    });
  }
});

/**
 * Clear feedback entries for an app.
 * Called after provider has processed the feedback and updated their database.
 *
 * @route DELETE /api/v1/feedback/:appBundleId
 * @param appBundleId - App bundle identifier
 * @query before - ISO date string to clear feedback before
 * @returns {cleared: number}
 */
router.delete("/:appBundleId", async (req: Request, res: Response) => {
  try {
    const { appBundleId } = req.params;
    const { before } = req.query;

    if (!validateBundleId(appBundleId)) {
      return res.status(400).json({
        error: "InvalidBundleId",
        message: "Invalid app bundle ID format",
      });
    }

    if (!canAccessBundle(req.principal, appBundleId)) {
      return res.status(403).json(NOT_IN_SCOPE_RESPONSE);
    }

    const beforeDate = before ? new Date(before as string) : undefined;

    const cleared = await feedbackService.clearFeedback(appBundleId, beforeDate);

    return res.json({ cleared });
  } catch (error) {
    console.error("Error clearing feedback:", error);
    return res.status(500).json({
      error: "InternalServerError",
      message: "Failed to clear feedback",
    });
  }
});

export default router;
