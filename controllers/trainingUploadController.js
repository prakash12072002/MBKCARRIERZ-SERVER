const {
  syncTrainingHierarchyByIds,
} = require("../services/trainingFolderService");
const {
  getTrainingDayFiles,
  getTrainingDayStatus,
  uploadTrainingFiles,
} = require("../services/trainingUploadService");

const resolveErrorStatus = (error) => {
  const message = String(error?.message || "").toLowerCase();

  if (
    message.includes("not found")
    || message.includes("missing departmentid")
  ) {
    return 404;
  }

  if (
    message.includes("not allowed")
    || message.includes("only super admin")
    || message.includes("assigned day and batch")
  ) {
    return 403;
  }

  if (
    message.includes("required")
    || message.includes("invalid")
    || message.includes("unsupported")
    || message.includes("security alert")
    || message.includes("at least one file")
    || message.includes("provide one of")
    || message.includes("not configured")
  ) {
    return 400;
  }

  return 500;
};

const syncHierarchy = async (req, res) => {
  try {
    const {
      companyId = null,
      courseId = null,
      collegeId = null,
      departmentId = null,
      totalDays,
      createMissingSchedules = true,
    } = req.body || {};

    const result = await syncTrainingHierarchyByIds({
      companyId,
      courseId,
      collegeId,
      departmentId,
      totalDays,
      createMissingSchedules,
      createdBy: req.user?.id || req.user?._id || null,
    });

    return res.json({
      success: true,
      message: "Training hierarchy synced with Google Drive",
      data: result,
    });
  } catch (error) {
    const status = resolveErrorStatus(error);
    console.error("[TRAINING-PLATFORM] Failed to sync hierarchy:", error);
    return res.status(status).json({
      success: false,
      message: error.message || "Failed to sync training hierarchy",
    });
  }
};

const uploadDayFiles = async (req, res) => {
  try {
    const dayId = req.params.dayId || req.body?.dayId || null;
    const fileType = req.body?.fileType || req.body?.type || null;

    const result = await uploadTrainingFiles({
      user: req.user,
      requesterTrainer: req.trainingAccess?.trainerProfile || null,
      dayId,
      fileType,
      files: Array.isArray(req.files) ? req.files : [],
    });

    return res.status(201).json({
      success: true,
      message: "Training files uploaded successfully",
      data: result,
    });
  } catch (error) {
    const status = resolveErrorStatus(error);
    console.error("[TRAINING-PLATFORM] Failed to upload files:", error);
    return res.status(status).json({
      success: false,
      message: error.message || "Failed to upload training files",
    });
  }
};

const getDayFiles = async (req, res) => {
  try {
    const { dayId } = req.params;
    const { fileType = null, status = null } = req.query || {};

    const result = await getTrainingDayFiles({
      dayId,
      fileType,
      status,
      user: req.user,
      requesterTrainer: req.trainingAccess?.trainerProfile || null,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    const status = resolveErrorStatus(error);
    console.error("[TRAINING-PLATFORM] Failed to fetch day files:", error);
    return res.status(status).json({
      success: false,
      message: error.message || "Failed to fetch training files",
    });
  }
};

const getDayStatus = async (req, res) => {
  try {
    const { dayId } = req.params;
    const result = await getTrainingDayStatus({
      dayId,
      user: req.user,
      requesterTrainer: req.trainingAccess?.trainerProfile || null,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    const status = resolveErrorStatus(error);
    console.error("[TRAINING-PLATFORM] Failed to fetch day status:", error);
    return res.status(status).json({
      success: false,
      message: error.message || "Failed to fetch day status",
    });
  }
};

module.exports = {
  syncHierarchy,
  uploadDayFiles,
  getDayFiles,
  getDayStatus,
};
