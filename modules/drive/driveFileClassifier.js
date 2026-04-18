const path = require("path");

const ATTENDANCE_EXTENSIONS = new Set([".pdf", ".xls", ".xlsx", ".csv"]);
const GEOTAG_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".webp",
  ".mp4",
  ".mov",
]);

const ATTENDANCE_NAME_HINTS = ["attendance", "sheet", "register", "excel"];
const GEOTAG_NAME_HINTS = ["geo", "tag", "checkout", "check_out", "location", "map"];

const normalizeDocumentType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "attendance") return "attendance";
  if (normalized === "geotag" || normalized === "geo" || normalized === "geotagimage") {
    return "geotag";
  }
  return "other";
};

const inferDocumentTypeFromMixedFile = (file = {}) => {
  const fileName = String(file?.name || "").trim().toLowerCase();
  const extension = String(path.extname(fileName || ""))
    .trim()
    .toLowerCase();
  const mimeType = String(file?.mimeType || "")
    .trim()
    .toLowerCase();

  if (ATTENDANCE_EXTENSIONS.has(extension)) return "attendance";
  if (GEOTAG_EXTENSIONS.has(extension)) return "geotag";
  if (mimeType.includes("pdf") || mimeType.includes("spreadsheet") || mimeType.includes("excel")) {
    return "attendance";
  }
  if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) {
    return "geotag";
  }
  if (ATTENDANCE_NAME_HINTS.some((token) => fileName.includes(token))) {
    return "attendance";
  }
  if (GEOTAG_NAME_HINTS.some((token) => fileName.includes(token))) {
    return "geotag";
  }
  return "other";
};

const pickAttendanceBackfillField = (fileName = "") => {
  const extension = String(path.extname(fileName || ""))
    .trim()
    .toLowerCase();

  if (extension === ".pdf") return "attendancePdfUrl";
  if (extension === ".xlsx" || extension === ".xls") return "attendanceExcelUrl";
  return null;
};

module.exports = {
  normalizeDocumentType,
  inferDocumentTypeFromMixedFile,
  pickAttendanceBackfillField,
  ATTENDANCE_EXTENSIONS,
  GEOTAG_EXTENSIONS,
};

