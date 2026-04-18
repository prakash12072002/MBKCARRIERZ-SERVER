const express = require("express");
const driveHierarchyRoutes = require("../../routes/driveHierarchyRoutes");

const router = express.Router();

// Keep existing route behavior, but expose Drive admin/sync routes through the
// modules/drive boundary to avoid feature modules coupling to legacy route files.
router.use("/", driveHierarchyRoutes);

module.exports = router;

