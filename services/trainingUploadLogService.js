const fs = require("fs");
const path = require("path");

const TRAINING_UPLOAD_LOG_PATH = path.join(
  __dirname,
  "..",
  "training_upload_audit.log",
);

const appendLogLine = (payload) => {
  try {
    fs.appendFileSync(
      TRAINING_UPLOAD_LOG_PATH,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...payload,
      })}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("[TRAINING-UPLOAD] Failed to write audit log:", error.message);
  }
};

const logTrainingUploadSuccess = (payload = {}) => {
  appendLogLine({ level: "info", event: "training_upload_success", ...payload });
};

const logTrainingUploadError = (payload = {}, error = null) => {
  appendLogLine({
    level: "error",
    event: "training_upload_error",
    ...payload,
    errorMessage: error?.message || null,
    errorStack: error?.stack || null,
  });
};

module.exports = {
  TRAINING_UPLOAD_LOG_PATH,
  logTrainingUploadSuccess,
  logTrainingUploadError,
};
