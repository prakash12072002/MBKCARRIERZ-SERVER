const express = require("express");
const { authenticate, authorize } = require("../../middleware/auth");
const {
  assignScheduleController,
  bulkCreateScheduleController,
  bulkUploadScheduleController,
  createScheduleController,
  deleteScheduleController,
  departmentDaysController,
  listSchedulesController,
  liveDashboardController,
  scheduleAssociationsController,
  scheduleDetailsController,
  trainerSchedulesController,
  updateScheduleController,
} = require("./schedules.controller");

const router = express.Router();

router.get(
  "/all",
  authenticate,
  authorize(["SPOCAdmin", "SuperAdmin"]),
  listSchedulesController,
);

router.get(
  "/live-dashboard",
  authenticate,
  authorize(["SPOCAdmin", "SuperAdmin"]),
  liveDashboardController,
);

router.get(
  "/days",
  authenticate,
  authorize(["SPOCAdmin", "SuperAdmin"]),
  departmentDaysController,
);

router.get(
  "/associations/all",
  scheduleAssociationsController,
);

router.get(
  "/trainer/:trainerId",
  trainerSchedulesController,
);

router.post(
  "/create",
  authenticate,
  authorize(["SPOCAdmin", "SuperAdmin"]),
  createScheduleController,
);

router.post(
  "/bulk-create",
  authenticate,
  authorize(["SPOCAdmin", "SuperAdmin"]),
  bulkCreateScheduleController,
);

router.post(
  "/bulk-upload",
  authenticate,
  authorize(["SPOCAdmin"]),
  bulkUploadScheduleController,
);

router.get(
  "/:id",
  scheduleDetailsController,
);

router.put(
  "/:id/assign",
  authenticate,
  authorize(["SPOCAdmin"]),
  assignScheduleController,
);

router.put(
  "/:id",
  updateScheduleController,
);

router.delete(
  "/:id",
  authenticate,
  authorize(["SPOCAdmin", "SuperAdmin"]),
  deleteScheduleController,
);

module.exports = router;
