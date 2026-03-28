const express = require("express");
const router = express.Router();

const {
  attachTrainingRequester,
  requireTrainingFileManager,
  requireTrainingFileViewer,
  requireTrainingHierarchyManager,
} = require("../middleware/trainingAccess");
const { authenticate } = require("../middleware/auth");
const { uploadTrainingAssets } = require("../config/trainingUpload");
const {
  getDayFiles,
  getDayStatus,
  syncHierarchy,
  uploadDayFiles,
} = require("../controllers/trainingUploadController");

router.post(
  "/hierarchy/sync",
  authenticate,
  requireTrainingHierarchyManager,
  syncHierarchy,
);

router.post(
  "/days/:dayId/upload",
  authenticate,
  attachTrainingRequester,
  requireTrainingFileManager,
  uploadTrainingAssets,
  uploadDayFiles,
);

router.post(
  "/upload",
  authenticate,
  attachTrainingRequester,
  requireTrainingFileManager,
  uploadTrainingAssets,
  uploadDayFiles,
);

router.get(
  "/days/:dayId/files",
  authenticate,
  attachTrainingRequester,
  requireTrainingFileViewer,
  getDayFiles,
);

router.get(
  "/days/:dayId/status",
  authenticate,
  attachTrainingRequester,
  requireTrainingFileViewer,
  getDayStatus,
);

router.use((error, _req, res, _next) => {
  if (!error) {
    return res.status(500).json({
      success: false,
      message: "Unexpected training-platform error",
    });
  }

  const status = error.message?.includes("Unsupported file type") ? 400 : 500;
  return res.status(status).json({
    success: false,
    message: error.message || "Training-platform request failed",
  });
});

module.exports = router;
