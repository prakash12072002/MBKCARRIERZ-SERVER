const fs = require("fs");
const multer = require("multer");
const path = require("path");

const TRAINING_UPLOAD_TMP_DIR = path.join(
  __dirname,
  "..",
  "uploads",
  "training-platform",
  "tmp",
);

if (!fs.existsSync(TRAINING_UPLOAD_TMP_DIR)) {
  fs.mkdirSync(TRAINING_UPLOAD_TMP_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, TRAINING_UPLOAD_TMP_DIR);
  },
  filename: (_req, file, cb) => {
    const safeExtension = path.extname(file.originalname || "").toLowerCase();
    cb(
      null,
      `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExtension}`,
    );
  },
});

const GENERIC_ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".xls",
  ".xlsx",
  ".jpg",
  ".jpeg",
  ".png",
  ".mp4",
]);

const GENERIC_ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "image/jpeg",
  "image/png",
  "video/mp4",
]);

const trainingAssetMulter = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 10,
  },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    const mimeType = String(file.mimetype || "").toLowerCase();

    if (
      GENERIC_ALLOWED_EXTENSIONS.has(extension) ||
      GENERIC_ALLOWED_MIME_TYPES.has(mimeType)
    ) {
      return cb(null, true);
    }

    return cb(
      new Error(
        "Unsupported file type. Allowed: PDF, XLS, XLSX, JPG, JPEG, PNG, MP4",
      ),
    );
  },
}).fields([
  { name: "files", maxCount: 10 },
  { name: "file", maxCount: 1 },
]);

const uploadTrainingAssets = (req, res, next) => {
  trainingAssetMulter(req, res, (error) => {
    if (error) return next(error);

    const groupedFiles = req.files && typeof req.files === "object" ? req.files : {};
    req.files = [
      ...(Array.isArray(groupedFiles.files) ? groupedFiles.files : []),
      ...(Array.isArray(groupedFiles.file) ? groupedFiles.file : []),
    ];

    return next();
  });
};

module.exports = {
  TRAINING_UPLOAD_TMP_DIR,
  uploadTrainingAssets,
};
