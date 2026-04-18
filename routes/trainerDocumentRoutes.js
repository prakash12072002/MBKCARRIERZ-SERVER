const express = require("express");
const { authenticate, authenticateOptional } = require("../middleware/auth");
const scanFile = require("../middleware/virusScan");
const {
  createMoveToReviewController,
  createSubmitVerificationController,
  createUploadDocumentController,
  createTrainerApproachController,
  createMyDocumentsController,
  createTrainerStatusController,
  createTrainerDocumentsController,
  createVerifyDocumentController,
} = require("../modules/documents/documents.controller");
const {
  uploadTrainerDocumentMiddleware,
} = require("../modules/documents/documents.upload");

const router = express.Router();

const myDocumentsController = createMyDocumentsController();
const trainerDocumentsController = createTrainerDocumentsController();
const trainerApproachController = createTrainerApproachController();
const trainerMoveToReviewController = createMoveToReviewController();
const submitVerificationController = createSubmitVerificationController();
const trainerStatusController = createTrainerStatusController();
const verifyDocumentController = createVerifyDocumentController();
const uploadDocumentController = createUploadDocumentController();

router.post(
  "/upload",
  authenticateOptional,
  uploadTrainerDocumentMiddleware,
  scanFile,
  uploadDocumentController,
);
router.get("/my-documents", authenticate, myDocumentsController);
router.get("/trainer/:trainerId", authenticate, trainerDocumentsController);
router.put("/:id/verify", authenticate, verifyDocumentController);
router.post(
  "/trainer/:trainerId/approach",
  authenticate,
  trainerApproachController,
);
router.put(
  "/trainer/:trainerId/move-to-review",
  authenticate,
  trainerMoveToReviewController,
);
router.put("/submit-verification", authenticate, submitVerificationController);
router.put("/trainer/:trainerId/status", authenticate, trainerStatusController);

module.exports = router;
