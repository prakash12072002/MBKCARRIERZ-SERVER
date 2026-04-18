const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../middleware/auth");
const {
  createFullStructureHandler,
  createSyncDbHandler,
} = require("../modules/drive/drive.controller");

router.post(
  "/full-structure",
  authenticate,
  authorize(["SuperAdmin", "Admin"]),
  createFullStructureHandler(),
);

router.post(
  "/sync-db",
  authenticate,
  authorize(["SuperAdmin", "Admin"]),
  createSyncDbHandler(),
);

module.exports = router;
module.exports.createSyncDbHandler = createSyncDbHandler;
