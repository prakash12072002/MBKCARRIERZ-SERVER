const { DRIVE_DAY_SUBFOLDERS, DRIVE_LEGACY_FOLDER_NAMES } = require("./drive.types");

const DAY_FOLDER_REGEX = /^day[\s_-]*(\d{1,2})$/i;
const ATTENDANCE_FOLDER_NAME_REGEX = new RegExp(`^${DRIVE_DAY_SUBFOLDERS.attendance}$`, "i");
const GEOTAG_FOLDER_NAME_REGEX = new RegExp(`^${DRIVE_DAY_SUBFOLDERS.geoTag}$`, "i");
const CHECKOUT_FOLDER_NAME_REGEX = new RegExp(`^${DRIVE_LEGACY_FOLDER_NAMES.checkout}$`, "i");

const toEpochMillis = (value) => {
  const epoch = Date.parse(String(value || "").trim());
  return Number.isFinite(epoch) ? epoch : Number.MAX_SAFE_INTEGER;
};

const parseDayNumberFromFolderName = (folderName = "") => {
  const normalized = String(folderName || "").trim();
  const match = normalized.match(DAY_FOLDER_REGEX);
  if (!match) return null;
  const dayNumber = Number.parseInt(match[1], 10);
  return Number.isFinite(dayNumber) && dayNumber > 0 ? dayNumber : null;
};

const isAttendanceFolderName = (folderName = "") =>
  ATTENDANCE_FOLDER_NAME_REGEX.test(String(folderName || "").trim());

const isGeoTagFolderName = (folderName = "") =>
  GEOTAG_FOLDER_NAME_REGEX.test(String(folderName || "").trim());

const isLegacyCheckoutFolderName = (folderName = "") =>
  CHECKOUT_FOLDER_NAME_REGEX.test(String(folderName || "").trim());

module.exports = {
  toEpochMillis,
  parseDayNumberFromFolderName,
  isAttendanceFolderName,
  isGeoTagFolderName,
  isLegacyCheckoutFolderName,
};

