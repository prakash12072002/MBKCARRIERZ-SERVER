const express = require("express");
const { authenticate } = require("../middleware/auth");
const upload = require("../middleware/upload");
const {
  parseComplaintCreatePayload,
  parseComplaintIdParams,
  parseComplaintListQuery,
  parseComplaintUpdatePayload,
} = require("../modules/complaints/complaints.schema");
const {
  listComplaintsFeed,
  getComplaintDetails,
  createComplaintTicket,
  updateComplaintRecord,
} = require("../modules/complaints/complaints.service");

const router = express.Router();

const handleLegacyRouteError = (
  res,
  error,
  { fallbackMessage = "Server Error", includeError = false, forbiddenMessage = "" } = {},
) => {
  const statusCode = Number(error?.statusCode || 500);
  const message = statusCode >= 500
    ? fallbackMessage
    : (
      statusCode === 403 && forbiddenMessage
        ? forbiddenMessage
        : (error?.message || fallbackMessage)
    );

  const payload = {
    success: false,
    message,
  };

  if (includeError && statusCode >= 500 && error?.message) {
    payload.error = error.message;
  }

  return res.status(statusCode).json(payload);
};

// @desc    Create a new complaint
// @route   POST /api/complaints
// @access  Private (legacy-compatible authenticated user flow)
router.post("/", authenticate, upload.single("attachment"), async (req, res) => {
  try {
    const payload = parseComplaintCreatePayload(req.body);
    const result = await createComplaintTicket({
      payload,
      user: req.user,
      file: req.file,
      io: req.app.get("io"),
      allowAnyAuthenticatedCreator: true,
    });
    return res.status(201).json(result);
  } catch (error) {
    return handleLegacyRouteError(res, error, {
      fallbackMessage: "Server Error",
    });
  }
});

// @desc    Get single complaint
// @route   GET /api/complaints/:id
// @access  Private
router.get("/:id", authenticate, async (req, res) => {
  try {
    const params = parseComplaintIdParams(req.params);
    const result = await getComplaintDetails({
      complaintId: params.complaintId,
      user: req.user,
    });
    return res.json(result);
  } catch (error) {
    return handleLegacyRouteError(res, error, {
      fallbackMessage: "Server Error",
    });
  }
});

// @desc    Update complaint
// @route   PUT /api/complaints/:id
// @access  Private
router.put("/:id", authenticate, async (req, res) => {
  try {
    const params = parseComplaintIdParams(req.params);
    const payload = parseComplaintUpdatePayload(req.body);
    const result = await updateComplaintRecord({
      complaintId: params.complaintId,
      payload,
      user: req.user,
      io: req.app.get("io"),
      ipAddress: req.ip,
    });
    return res.json(result);
  } catch (error) {
    return handleLegacyRouteError(res, error, {
      fallbackMessage: "Server Error",
      includeError: true,
      forbiddenMessage: "Not authorized",
    });
  }
});

// @desc    Get all complaints
// @route   GET /api/complaints
// @access  Private
router.get("/", authenticate, async (req, res) => {
  try {
    const query = parseComplaintListQuery(req.query);
    const result = await listComplaintsFeed({
      query,
      user: req.user,
    });
    return res.json(result);
  } catch (error) {
    return handleLegacyRouteError(res, error, {
      fallbackMessage: "Server Error",
    });
  }
});

module.exports = router;
