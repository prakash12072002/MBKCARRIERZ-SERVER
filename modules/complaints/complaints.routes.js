const express = require("express");
const { authenticate } = require("../../middleware/auth");
const upload = require("../../middleware/upload");
const {
  listComplaintsController,
  getComplaintByIdController,
  createComplaintController,
  updateComplaintController,
} = require("./complaints.controller");

const router = express.Router();

router.use(authenticate);
router.post("/", upload.single("attachment"), createComplaintController);
router.get("/:id", getComplaintByIdController);
router.put("/:id", updateComplaintController);
router.get("/", listComplaintsController);

module.exports = router;
