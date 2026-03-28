import express from "express";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const router = express.Router();

// Load CommonJS modules using require
const authRoutes = require("./authRoutes.js");
const trainerRoutes = require("./trainerRoutes.js");
const collegeRoutes = require("./collegeRoutes.js");
const attendanceRoutes = require("./attendanceRoutes.js");
const financialRoutes = require("./financialRoutes.js");
const salaryRoutes = require("./salaryRoutes.js");
const scheduleRoutes = require("./scheduleRoutes.js");
const userRoutes = require("./userRoutes.js");
const trainerAttendanceRoutes = require("./trainerAttendanceRoutes.js");
const trainerDocumentRoutes = require("./trainerDocumentRoutes.js");
const companyRoutes = require("./companyRoutes.js");
const courseRoutes = require("./courseRoutes.js");
const dashboardRoutes = require("./dashboardRoutes.js");
const publicRoutes = require("./publicRoutes.js");
const cityRoutes = require("./cityRoutes.js");
const studentRoutes = require("./studentRoutes.js");
const companyPortalRoutes = require("./companyPortalRoutes.js");
const companyInviteRoutes = require("./companyInviteRoutes.js");
const departmentRoutes = require("./departmentRoutes.js");
const driveHierarchyRoutes = require("./driveHierarchyRoutes.js");
const trainingPlatformRoutes = require("./trainingPlatformRoutes.js");
const captchaRoute = require("./captchaRoute.js");
import chatRoutes from "./chatRoutes.mjs";
import messageRoutes from "./messageRoutes.mjs";
import mediaRoutes from "./mediaRoutes.mjs";
import uploadRoutes from "./uploadRoutes.mjs";
const complaintRoutes = require("./complaintRoutes.js");
const notificationRoutes = require("./notificationRoutes.js");
const adminTrainerRoutes = require("./adminTrainerRoutes.js");
import streamWebhookRoute from "./streamWebhookRoute.mjs";


// Middleware
const { auth: authenticate } = require("../middleware/auth.js");

router.use("/auth", authRoutes);
router.use("/captcha", captchaRoute);
router.use("/public", publicRoutes);
router.use("/users", userRoutes);
router.use("/students", studentRoutes); 
router.use("/companies", companyRoutes);
router.use("/company-invite", companyInviteRoutes);
router.use("/colleges", collegeRoutes);
router.use("/courses", courseRoutes);
router.use("/trainers", trainerRoutes);
router.use("/schedules", scheduleRoutes);
router.post(
  "/upload-image",
  attendanceRoutes.uploadSingleGeoImageMiddleware,
  attendanceRoutes.uploadSingleGeoImageHandler,
);
router.use("/attendance", attendanceRoutes);
router.use("/trainer-attendance", trainerAttendanceRoutes);
router.use("/trainer-documents", trainerDocumentRoutes);
router.use("/financials", financialRoutes);
router.use("/salaries", salaryRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/cities", cityRoutes);
router.use("/complaints", complaintRoutes);
router.use("/notifications", notificationRoutes);
router.use("/company-portal", companyPortalRoutes);
router.use("/departments", departmentRoutes);
router.use("/drive-hierarchy", driveHierarchyRoutes);
router.use("/training-platform", trainingPlatformRoutes);
router.use("/admin/trainers", adminTrainerRoutes);
router.use("/chat", authenticate, chatRoutes);
router.use("/message", messageRoutes);
router.use("/media", authenticate, mediaRoutes);
router.use("/upload", authenticate, uploadRoutes);
router.use("/webhooks", streamWebhookRoute);

export default router;
