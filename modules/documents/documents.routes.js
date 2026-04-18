const express = require("express");
const { authenticate, authenticateOptional } = require("../../middleware/auth");
const scanFile = require("../../middleware/virusScan");
const { uploadTrainerDocumentMiddleware } = require("./documents.upload");
const {
  myDocumentsController,
  submitVerificationController,
  uploadDocumentController,
  trainerMoveToReviewController,
  trainerApproachController,
  trainerStatusController,
  trainerDocumentsController,
  verifyDocumentController,
} = require("./documents.controller");

const router = express.Router();

router.post(
  "/upload",
  authenticateOptional,
  uploadTrainerDocumentMiddleware,
  scanFile,
  uploadDocumentController,
);
router.get("/my-documents", authenticate, myDocumentsController);
router.get("/trainer/:trainerId", authenticate, trainerDocumentsController);
router.post("/trainer/:trainerId/approach", authenticate, trainerApproachController);
router.put(
  "/trainer/:trainerId/move-to-review",
  authenticate,
  trainerMoveToReviewController,
);
router.put("/submit-verification", authenticate, submitVerificationController);
router.put("/trainer/:trainerId/status", authenticate, trainerStatusController);
router.put("/:id/verify", authenticate, verifyDocumentController);

module.exports = router;
