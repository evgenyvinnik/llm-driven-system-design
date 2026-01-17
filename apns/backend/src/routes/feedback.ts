import { Router, Request, Response } from "express";
import { feedbackService } from "../services/feedbackService.js";
import { validateBundleId } from "../utils/index.js";

const router = Router();

// Get feedback for an app
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

// Clear feedback for an app
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
