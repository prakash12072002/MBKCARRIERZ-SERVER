const express = require("express");
const { authenticate } = require("../../middleware/auth");
const {
  getAttendanceCollegeController,
  getAttendanceDocumentsController,
  getAttendanceScheduleController,
  getAttendanceTrainerController,
  listAttendanceSubmissionsController,
  getAttendanceSubmissionDetailsController,
  verifyAttendanceSubmissionController,
  rejectAttendanceDocumentController,
  verifyAttendanceDocumentController,
  verifyGeoTagController,
  rejectGeoTagController,
} = require("./attendance.controller");

const router = express.Router();

router.use(authenticate);
router.get("/", listAttendanceSubmissionsController);
router.get("/schedule/:scheduleId", getAttendanceScheduleController);
router.get("/trainer/:trainerId", getAttendanceTrainerController);
router.get("/college/:collegeId", getAttendanceCollegeController);
router.get("/documents", getAttendanceDocumentsController);
router.get("/:id/details", getAttendanceSubmissionDetailsController);
router.put("/:id/verify", verifyAttendanceSubmissionController);
router.post("/verify-document", verifyAttendanceDocumentController);
router.post("/reject-document", rejectAttendanceDocumentController);
router.post("/verify-geo", verifyGeoTagController);
router.post("/reject-geo", rejectGeoTagController);

module.exports = router;
