const express = require("express");
const router = express.Router();
const {
  createAssignScheduleController,
  createBulkCreateScheduleController,
  createBulkUploadScheduleController,
  createCreateScheduleController,
  createDeleteScheduleController,
  createUpdateScheduleController,
  departmentDaysController,
  listSchedulesController,
  liveDashboardController,
  scheduleAssociationsController,
  scheduleDetailsController,
  trainerSchedulesController,
} = require("../modules/schedules/schedules.controller");
const { resolveScheduleFolderFields } = require("../modules/schedules/schedules.drive");
const authenticate = require("../middleware/auth").authenticate;
const authorize = require("../middleware/auth").authorize;

const assignScheduleController = createAssignScheduleController({
  resolveScheduleFolderFields,
});
const createScheduleController = createCreateScheduleController({
  resolveScheduleFolderFields,
});
const bulkCreateScheduleController = createBulkCreateScheduleController({
  resolveScheduleFolderFields,
});
const bulkUploadScheduleController = createBulkUploadScheduleController({
  resolveScheduleFolderFields,
});
const updateScheduleController = createUpdateScheduleController({
  resolveScheduleFolderFields,
});
const deleteScheduleController = createDeleteScheduleController();

// @route   POST /api/schedules/create
// @desc    Create a single schedule
// @access  SPOC Admin
router.post("/create", createScheduleController);

// @route   POST /api/schedules/bulk-create
// @desc    Create multiple schedules at once
// @access  SPOC Admin
router.post("/bulk-create", authenticate, authorize(["SPOCAdmin", "SuperAdmin"]), bulkCreateScheduleController);

// @route   GET /api/schedules/all
// @desc    Get all schedules
// @access  SPOC Admin
router.get("/all", authenticate, authorize(["SPOCAdmin", "SuperAdmin"]), listSchedulesController);

// @route   GET /api/schedules/live-dashboard
// @desc    Get today's schedules with live attendance status
// @access  SPOC Admin
router.get("/live-dashboard", authenticate, authorize(["SPOCAdmin", "SuperAdmin"]), liveDashboardController);

// @route   GET /api/schedules/days?departmentId=xxx
// @desc    Get day status slots for a department
// @access  SPOC Admin, SuperAdmin
router.get("/days", authenticate, authorize(["SPOCAdmin", "SuperAdmin"]), departmentDaysController);

// @route   GET /api/schedules/trainer/:trainerId
// @desc    Get all schedules for a trainer
// @access  SPOC Admin, Trainer
router.get("/trainer/:trainerId", trainerSchedulesController);

// @route   GET /api/schedules/:id
// @desc    Get a single schedule by ID
// @access  SPOC Admin, Trainer
router.get("/:id", scheduleDetailsController);

// @route   PUT /api/schedules/:id/assign
// @desc    Assign Trainer and Date to a Schedule (Day)
// @access  SPOC Admin
router.put("/:id/assign", authenticate, authorize(["SPOCAdmin"]), assignScheduleController);

// @route   PUT /api/schedules/:id
// @desc    Update a schedule
// @access  SPOC Admin
router.put("/:id", updateScheduleController);

// @route   DELETE /api/schedules/:id
// @desc    Delete a schedule
// @access  SPOC Admin
router.delete("/:id", authenticate, authorize(["SPOCAdmin", "SuperAdmin"]), deleteScheduleController);

// @route   GET /api/schedules/associations
// @desc    Get all companies, courses, and colleges for dropdown associations
// @access  SPOC Admin
router.get("/associations/all", scheduleAssociationsController);

// @route   POST /api/schedules/bulk-upload
// @desc    Bulk upload schedules via mandatory Excel format
// @access  SPOC Admin
router.post("/bulk-upload", authenticate, authorize(["SPOCAdmin"]), bulkUploadScheduleController);

module.exports = router;

