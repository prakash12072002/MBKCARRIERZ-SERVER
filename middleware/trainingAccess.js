const { Trainer } = require("../models");
const {
  canManageTrainingHierarchy,
  canManageTrainingFiles,
  canViewTrainingFiles,
  isTrainerRole,
  normalizeTrainingRole,
} = require("../utils/trainingPlatformRoles");

const attachTrainingRequester = async (req, res, next) => {
  try {
    const role = normalizeTrainingRole(req.user?.role);
    let trainerProfile = null;

    if (isTrainerRole(role) && req.user?.id) {
      trainerProfile = await Trainer.findOne({ userId: req.user.id }).select(
        "_id trainerId userId",
      );

      if (!trainerProfile) {
        return res.status(404).json({
          success: false,
          message: "Trainer profile not found for authenticated user",
        });
      }
    }

    req.trainingAccess = {
      role,
      trainerProfile,
      isTrainer: Boolean(trainerProfile),
    };

    return next();
  } catch (error) {
    console.error("[TRAINING-ACCESS] Failed to attach requester:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to resolve training access context",
    });
  }
};

const requireTrainingHierarchyManager = (req, res, next) => {
  if (!canManageTrainingHierarchy(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "Only Super Admin can manage the training hierarchy",
    });
  }

  return next();
};

const requireTrainingFileManager = (req, res, next) => {
  if (!canManageTrainingFiles(req.user?.role) && !isTrainerRole(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "You are not allowed to upload training files",
    });
  }

  return next();
};

const requireTrainingFileViewer = (req, res, next) => {
  if (!canViewTrainingFiles(req.user?.role)) {
    return res.status(403).json({
      success: false,
      message: "You are not allowed to view training files",
    });
  }

  return next();
};

module.exports = {
  attachTrainingRequester,
  requireTrainingHierarchyManager,
  requireTrainingFileManager,
  requireTrainingFileViewer,
};
