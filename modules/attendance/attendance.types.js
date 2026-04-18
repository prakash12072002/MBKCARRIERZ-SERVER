const ATTENDANCE_VERIFICATION_STATUSES = Object.freeze([
  "pending",
  "approved",
  "rejected",
]);

const ATTENDANCE_VIEWS = Object.freeze({
  GEO_VERIFICATION: "geo-verification",
});

const ATTENDANCE_ALLOWED_READ_ROLES = Object.freeze([
  "superadmin",
  "spocadmin",
  "admin",
  "accountant",
  "accoundant",
]);

const ATTENDANCE_ALLOWED_VERIFY_ROLES = Object.freeze([
  "superadmin",
  "spocadmin",
  "admin",
]);

const DEFAULT_ATTENDANCE_PAGE = 1;
const DEFAULT_ATTENDANCE_LIMIT = 20;
const MAX_ATTENDANCE_LIMIT = 100;
const ATTENDANCE_FETCH_FAILED_MESSAGE = "Failed to fetch attendance";
const ATTENDANCE_FETCH_DOCUMENTS_FAILED_MESSAGE = "Failed to fetch attendance documents";
const ATTENDANCE_DOCUMENT_STATUS_FILTERS = Object.freeze([
  "pending",
  "verified",
  "rejected",
]);
const ATTENDANCE_DOCUMENT_FILE_TYPES = Object.freeze([
  "attendance",
  "geotag",
  "other",
]);

const ATTENDANCE_MANUAL_CREATE_FAILED_MESSAGE = "Failed to create manual attendance";
const ATTENDANCE_MANUAL_CREATE_SUCCESS_MESSAGE = "Manual attendance created successfully";

module.exports = {
  ATTENDANCE_VERIFICATION_STATUSES,
  ATTENDANCE_VIEWS,
  ATTENDANCE_ALLOWED_READ_ROLES,
  ATTENDANCE_ALLOWED_VERIFY_ROLES,
  DEFAULT_ATTENDANCE_PAGE,
  DEFAULT_ATTENDANCE_LIMIT,
  MAX_ATTENDANCE_LIMIT,
  ATTENDANCE_FETCH_FAILED_MESSAGE,
  ATTENDANCE_FETCH_DOCUMENTS_FAILED_MESSAGE,
  ATTENDANCE_DOCUMENT_STATUS_FILTERS,
  ATTENDANCE_DOCUMENT_FILE_TYPES,
  ATTENDANCE_MANUAL_CREATE_FAILED_MESSAGE,
  ATTENDANCE_MANUAL_CREATE_SUCCESS_MESSAGE,
};
