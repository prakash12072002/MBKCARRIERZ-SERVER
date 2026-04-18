const {
  parseComplaintCreatePayload,
  parseComplaintIdParams,
  parseComplaintListQuery,
  parseComplaintUpdatePayload,
} = require("./complaints.schema");
const {
  createComplaintTicket,
  getComplaintDetails,
  listComplaintsFeed,
  updateComplaintRecord,
} = require("./complaints.service");

const handleControllerError = (res, error, fallbackMessage) => {
  const statusCode = Number(error?.statusCode || 500);
  return res.status(statusCode).json({
    success: false,
    message: error?.message || fallbackMessage,
  });
};

const listComplaintsController = async (req, res) => {
  try {
    const query = parseComplaintListQuery(req.query);
    const payload = await listComplaintsFeed({
      query,
      user: req.user,
    });
    return res.json(payload);
  } catch (error) {
    return handleControllerError(res, error, "Failed to fetch complaints");
  }
};

const getComplaintByIdController = async (req, res) => {
  try {
    const params = parseComplaintIdParams(req.params);
    const payload = await getComplaintDetails({
      complaintId: params.complaintId,
      user: req.user,
    });
    return res.json(payload);
  } catch (error) {
    return handleControllerError(res, error, "Failed to fetch complaint");
  }
};

const createComplaintController = async (req, res) => {
  try {
    const payload = parseComplaintCreatePayload(req.body);
    const result = await createComplaintTicket({
      payload,
      user: req.user,
      file: req.file,
      io: req.app.get("io"),
    });
    return res.status(201).json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to create complaint");
  }
};

const updateComplaintController = async (req, res) => {
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
    return handleControllerError(res, error, "Failed to update complaint");
  }
};

module.exports = {
  listComplaintsController,
  getComplaintByIdController,
  createComplaintController,
  updateComplaintController,
};
