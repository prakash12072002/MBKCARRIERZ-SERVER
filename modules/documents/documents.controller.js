const {
  parseMyDocumentsContext,
  parseTrainerApproachContext,
  parseTrainerApproachParams,
  parseTrainerMoveToReviewContext,
  parseTrainerMoveToReviewParams,
  parseSubmitVerificationContext,
  parseUploadDocumentBody,
  parseUploadDocumentContext,
  parseTrainerStatusBody,
  parseTrainerStatusParams,
  parseTrainerDocumentsParams,
  parseVerifyDocumentBody,
  parseVerifyDocumentParams,
} = require("./documents.schema");
const {
  approachTrainerDocumentsFeed,
  listMyDocumentsFeed,
  moveTrainerToReviewFeed,
  listTrainerDocumentsFeed,
  submitVerificationFeed,
  uploadTrainerDocumentFeed,
  updateTrainerStatusFeed,
  verifyDocumentFeed,
} = require("./documents.service");
const {
  ACCESS_DENIED_MESSAGE,
  FETCH_DOCUMENTS_FAILED_MESSAGE,
  MOVE_TO_REVIEW_FAILED_MESSAGE,
  DOCUMENT_UPLOAD_FAILED_MESSAGE,
  SUBMIT_VERIFICATION_FAILED_MESSAGE,
  TRAINER_REMINDER_FAILED_MESSAGE,
  UPDATE_TRAINER_STATUS_FAILED_MESSAGE,
  VERIFY_DOCUMENT_FAILED_MESSAGE,
} = require("./documents.types");
const {
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");
const { logControllerError } = require("../../shared/utils/controllerTelemetry");

const documentsControllerLogger = createStructuredLogger({
  service: "documents",
  component: "controller",
});

const logDocumentsControllerError = (req, stage, error, fields = {}) =>
  logControllerError(documentsControllerLogger, {
    req,
    stage,
    error,
    fields,
    correlationPrefix: "doc_ctrl",
  });

const createMyDocumentsController = ({
  getMyDocumentsFeed = listMyDocumentsFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseMyDocumentsContext(req.user);
    const payload = await getMyDocumentsFeed({
      userId: context.userId,
    });
    return res.json(payload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    logDocumentsControllerError(req, "list_my_documents_failed", error);
    return res.status(500).json({
      success: false,
      message: FETCH_DOCUMENTS_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const myDocumentsController = createMyDocumentsController();

const createTrainerDocumentsController = ({
  getTrainerDocumentsFeed = listTrainerDocumentsFeed,
} = {}) => async (req, res) => {
  try {
    const params = parseTrainerDocumentsParams(req.params);
    const payload = await getTrainerDocumentsFeed({
      trainerId: params.trainerId,
    });
    return res.json(payload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    logDocumentsControllerError(req, "list_trainer_documents_failed", error);
    return res.status(500).json({
      success: false,
      message: FETCH_DOCUMENTS_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const trainerDocumentsController = createTrainerDocumentsController();

const createVerifyDocumentController = ({
  getVerifyDocumentFeed = verifyDocumentFeed,
} = {}) => async (req, res) => {
  try {
    const params = parseVerifyDocumentParams(req.params);
    const payload = parseVerifyDocumentBody(req.body);

    const responsePayload = await getVerifyDocumentFeed({
      documentId: params.documentId,
      payload,
      actorUserId: req?.user?.id || req?.user?._id || null,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    logDocumentsControllerError(req, "verify_document_failed", error);
    return res.status(500).json({
      success: false,
      message: VERIFY_DOCUMENT_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const verifyDocumentController = createVerifyDocumentController();

const createTrainerStatusController = ({
  getTrainerStatusFeed = updateTrainerStatusFeed,
} = {}) => async (req, res) => {
  try {
    const params = parseTrainerStatusParams(req.params);
    const payload = parseTrainerStatusBody(req.body);

    const responsePayload = await getTrainerStatusFeed({
      trainerId: params.trainerId,
      payload,
      actorUserId: req?.user?.id || req?.user?._id || null,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      const responsePayload = {
        success: false,
        message: error.message,
      };

      if (typeof error.data !== "undefined") {
        responsePayload.data = error.data;
      }

      return res.status(error.statusCode).json(responsePayload);
    }

    logDocumentsControllerError(req, "update_trainer_document_status_failed", error);
    return res.status(500).json({
      success: false,
      message: UPDATE_TRAINER_STATUS_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const trainerStatusController = createTrainerStatusController();

const createTrainerApproachController = ({
  getTrainerApproachFeed = approachTrainerDocumentsFeed,
} = {}) => async (req, res) => {
  try {
    const params = parseTrainerApproachParams(req.params);
    const context = parseTrainerApproachContext(req.user);

    const responsePayload = await getTrainerApproachFeed({
      trainerId: params.trainerId,
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      if (
        error.statusCode === 403 &&
        String(error.message || "").trim() === ACCESS_DENIED_MESSAGE
      ) {
        return res.status(403).json({
          success: false,
          message: ACCESS_DENIED_MESSAGE,
        });
      }

      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    logDocumentsControllerError(req, "send_trainer_document_reminder_failed", error);
    return res.status(500).json({
      success: false,
      message: TRAINER_REMINDER_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const trainerApproachController = createTrainerApproachController();

const createMoveToReviewController = ({
  getMoveToReviewFeed = moveTrainerToReviewFeed,
} = {}) => async (req, res) => {
  try {
    const params = parseTrainerMoveToReviewParams(req.params);
    const context = parseTrainerMoveToReviewContext(req.user);

    const responsePayload = await getMoveToReviewFeed({
      trainerId: params.trainerId,
      actorRole: context.actorRole,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      const responsePayload = {
        success: false,
        message: error.message,
      };

      if (typeof error.data !== "undefined") {
        responsePayload.data = error.data;
      }

      return res.status(error.statusCode).json(responsePayload);
    }

    logDocumentsControllerError(req, "move_trainer_to_review_failed", error);
    return res.status(500).json({
      success: false,
      message: MOVE_TO_REVIEW_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const trainerMoveToReviewController = createMoveToReviewController();

const createSubmitVerificationController = ({
  getSubmitVerificationFeed = submitVerificationFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseSubmitVerificationContext(req.user);

    const responsePayload = await getSubmitVerificationFeed({
      actorUserId: context.actorUserId,
      actorRole: context.actorRole,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      const responsePayload = {
        success: false,
        message: error.message,
      };

      if (typeof error.data !== "undefined") {
        responsePayload.data = error.data;
      }

      return res.status(error.statusCode).json(responsePayload);
    }

    logDocumentsControllerError(req, "submit_verification_failed", error);
    return res.status(500).json({
      success: false,
      message: SUBMIT_VERIFICATION_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const submitVerificationController = createSubmitVerificationController();

const createUploadDocumentController = ({
  getUploadDocumentFeed = uploadTrainerDocumentFeed,
} = {}) => async (req, res) => {
  try {
    const payload = parseUploadDocumentBody(req.body);
    const context = parseUploadDocumentContext(req.user);

    const responsePayload = await getUploadDocumentFeed({
      payload,
      file: req.file,
      actorUser: context.actorUser,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      if (error.responsePayload) {
        return res.status(error.statusCode).json(error.responsePayload);
      }

      const responsePayload = {
        success: false,
        message: error.message,
      };

      if (typeof error.data !== "undefined") {
        responsePayload.data = error.data;
      }

      return res.status(error.statusCode).json(responsePayload);
    }

    const errorMessage = error?.message || DOCUMENT_UPLOAD_FAILED_MESSAGE;
    const isDriveSetupIssue =
      typeof errorMessage === "string" &&
      (errorMessage.includes("Google Drive setup issue") ||
        errorMessage.includes("domain-wide delegation") ||
        errorMessage.includes("Service accounts do not have storage quota"));

    const statusCode = isDriveSetupIssue ? 400 : 500;

    logDocumentsControllerError(req, "upload_document_failed", error, {
      statusCode,
    });
    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: error?.message,
    });
  }
};

const uploadDocumentController = createUploadDocumentController();

module.exports = {
  createMoveToReviewController,
  createSubmitVerificationController,
  createUploadDocumentController,
  createTrainerApproachController,
  createMyDocumentsController,
  createTrainerStatusController,
  createTrainerDocumentsController,
  createVerifyDocumentController,
  myDocumentsController,
  submitVerificationController,
  uploadDocumentController,
  trainerMoveToReviewController,
  trainerApproachController,
  trainerStatusController,
  trainerDocumentsController,
  verifyDocumentController,
};
