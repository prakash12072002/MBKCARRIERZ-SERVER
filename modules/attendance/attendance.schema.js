const mongoose = require("mongoose");
const {
  normalizeAttendanceVerificationStatus,
} = require("../../utils/statusNormalizer");
const {
  ATTENDANCE_VERIFICATION_STATUSES,
  ATTENDANCE_VIEWS,
  DEFAULT_ATTENDANCE_PAGE,
  DEFAULT_ATTENDANCE_LIMIT,
  MAX_ATTENDANCE_LIMIT,
  ATTENDANCE_DOCUMENT_STATUS_FILTERS,
  ATTENDANCE_DOCUMENT_FILE_TYPES,
} = require("./attendance.types");

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const toSafeTrimmedString = (value) => String(value || "").trim();
const toNormalizedToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const parseAttendanceDateBoundary = (value, boundary = "start") => {
  const normalized = toSafeTrimmedString(value);
  if (!normalized) {
    return null;
  }

  const parsedDate = new Date(normalized);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  if (boundary === "end") {
    parsedDate.setHours(23, 59, 59, 999);
  } else {
    parsedDate.setHours(0, 0, 0, 0);
  }

  return parsedDate;
};

const shouldPaginateAttendance = (query = {}) =>
  Object.prototype.hasOwnProperty.call(query, "page")
  || Object.prototype.hasOwnProperty.call(query, "limit");

const parseVerificationStatus = (value) => {
  const rawToken = toNormalizedToken(value);
  const normalized = normalizeAttendanceVerificationStatus(
    rawToken === "completed" ? "approved" : value,
    "",
  );
  if (!ATTENDANCE_VERIFICATION_STATUSES.includes(normalized)) {
    return "";
  }
  return normalized;
};

const parseCheckOutVerificationStatus = (value) => {
  const token = toNormalizedToken(value);
  if (!token || token === "all") {
    return "";
  }

  if (
    token === "pending"
    || token === "pending_checkout"
    || token === "pending_or_review"
    || token === "in_progress"
    || token === "under_review"
  ) {
    return "PENDING_OR_REVIEW";
  }

  if (
    token === "completed"
    || token === "auto_verified"
    || token === "approved"
    || token === "verified"
    || token === "manual_verified"
    || token === "manually_verified"
  ) {
    return "COMPLETED_OR_VERIFIED";
  }

  if (
    token === "manual_review_required"
    || token === "manual_review"
    || token === "review_required"
  ) {
    return "MANUAL_REVIEW_REQUIRED";
  }

  if (
    token === "rejected"
    || token === "reject"
    || token === "manual_rejected"
    || token === "manually_rejected"
  ) {
    return "REJECTED";
  }

  return "";
};

const parseAttendanceListQuery = (query = {}) => {
  const page = toPositiveInteger(query.page, DEFAULT_ATTENDANCE_PAGE);
  const requestedLimit = toPositiveInteger(query.limit, DEFAULT_ATTENDANCE_LIMIT);
  const limit = Math.min(requestedLimit, MAX_ATTENDANCE_LIMIT);
  const view = toSafeTrimmedString(query.view).toLowerCase();
  const search = toSafeTrimmedString(query.search);
  const verificationStatus = parseVerificationStatus(query.verificationStatus);
  const geoVerificationStatus = parseVerificationStatus(query.geoVerificationStatus);
  const checkOutVerificationStatus = parseCheckOutVerificationStatus(
    query.checkOutVerificationStatus,
  );
  const startDate = parseAttendanceDateBoundary(query.startDate, "start");
  const endDate = parseAttendanceDateBoundary(query.endDate, "end");

  const hasInvalidStartDate = Boolean(query.startDate) && !startDate;
  const hasInvalidEndDate = Boolean(query.endDate) && !endDate;

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    shouldPaginate: shouldPaginateAttendance(query),
    view: view === ATTENDANCE_VIEWS.GEO_VERIFICATION
      ? ATTENDANCE_VIEWS.GEO_VERIFICATION
      : "",
    search,
    hasSearch: Boolean(search),
    verificationStatus,
    geoVerificationStatus,
    checkOutVerificationStatus,
    startDate,
    endDate,
    hasInvalidStartDate,
    hasInvalidEndDate,
  };
};

const parseAttendanceDetailsParams = (params = {}) => ({
  attendanceId: toSafeTrimmedString(params.id),
});

const parseAttendanceVerifyParams = (params = {}) => ({
  attendanceId: toSafeTrimmedString(params.id),
});

const parseAttendanceVerifyPayload = (body = {}) => {
  const status = parseVerificationStatus(body.status);
  const comment = toSafeTrimmedString(body.comment);
  const approvedBy = toSafeTrimmedString(body.approvedBy) || null;

  return {
    status,
    comment,
    approvedBy,
  };
};

const parseAttendanceDocumentVerifyPayload = (body = {}) => {
  const documentId = toSafeTrimmedString(body.documentId);
  const spocId = toSafeTrimmedString(body.spocId);

  if (!documentId || !mongoose.Types.ObjectId.isValid(documentId)) {
    throw createBadRequestError("Valid documentId is required");
  }

  if (spocId && !mongoose.Types.ObjectId.isValid(spocId)) {
    throw createBadRequestError("Invalid spocId");
  }

  return { documentId, spocId };
};

const parseAttendanceDocumentRejectPayload = (body = {}) => {
  const documentId = toSafeTrimmedString(body.documentId);
  const spocId = toSafeTrimmedString(body.spocId);
  const rejectReason = toSafeTrimmedString(body.rejectReason);

  if (!documentId || !mongoose.Types.ObjectId.isValid(documentId)) {
    throw createBadRequestError("Valid documentId is required");
  }

  if (spocId && !mongoose.Types.ObjectId.isValid(spocId)) {
    throw createBadRequestError("Invalid spocId");
  }

  return { documentId, spocId, rejectReason };
};

const parseAttendanceManualPayload = (body = {}) => {
  const trainerId = toSafeTrimmedString(body.trainerId);
  const collegeId = toSafeTrimmedString(body.collegeId);
  const date = toSafeTrimmedString(body.date);

  if (!trainerId || !mongoose.Types.ObjectId.isValid(trainerId)) {
    throw createBadRequestError("Valid trainerId is required");
  }

  if (!collegeId || !mongoose.Types.ObjectId.isValid(collegeId)) {
    throw createBadRequestError("Valid collegeId is required");
  }

  if (!date || Number.isNaN(new Date(date).getTime())) {
    throw createBadRequestError("Valid date is required");
  }

  return {
    trainerId,
    collegeId,
    scheduleId: toSafeTrimmedString(body.scheduleId) || null,
    dayNumber: toPositiveInteger(body.dayNumber, null),
    date: new Date(date),
    status: toSafeTrimmedString(body.status) || "Present",
    remarks: toSafeTrimmedString(body.remarks),
    studentsPresent: toPositiveInteger(body.studentsPresent, 0),
    studentsAbsent: toPositiveInteger(body.studentsAbsent, 0),
    syllabus: toSafeTrimmedString(body.syllabus) || null,
  };
};

const parseAttendanceScheduleParams = (params = {}) => ({
  scheduleId: toSafeTrimmedString(params.scheduleId),
});

const parseAttendanceTrainerParams = (params = {}) => ({
  trainerId: toSafeTrimmedString(params.trainerId),
});

const parseAttendanceTrainerQuery = (query = {}) => ({
  month: query?.month,
  year: query?.year,
});

const parseAttendanceCollegeParams = (params = {}) => ({
  collegeId: toSafeTrimmedString(params.collegeId),
});

const createBadRequestError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const parseAttendanceDocumentsQuery = (query = {}) => {
  const filters = {};
  const objectIdParams = [
    ["scheduleId", query?.scheduleId],
    ["attendanceId", query?.attendanceId],
    ["trainerId", query?.trainerId],
  ];

  for (const [key, value] of objectIdParams) {
    const normalizedValue = toSafeTrimmedString(value);
    if (!normalizedValue) continue;

    if (!mongoose.Types.ObjectId.isValid(normalizedValue)) {
      throw createBadRequestError(`Invalid ${key}`);
    }

    filters[key] = normalizedValue;
  }

  const status = toSafeTrimmedString(query?.status).toLowerCase();
  if (status) {
    if (!ATTENDANCE_DOCUMENT_STATUS_FILTERS.includes(status)) {
      throw createBadRequestError("Invalid status filter. Use pending, verified, or rejected.");
    }
    filters.status = status;
  }

  const fileType = toSafeTrimmedString(query?.fileType).toLowerCase();
  if (fileType) {
    if (!ATTENDANCE_DOCUMENT_FILE_TYPES.includes(fileType)) {
      throw createBadRequestError("Invalid fileType filter. Use attendance, geotag, or other.");
    }
    filters.fileType = fileType;
  }

  return { filters };
};

const parseAttendanceVerifyGeoPayload = (body = {}) => {
  const attendanceId = toSafeTrimmedString(body.attendanceId);
  const spocId = toSafeTrimmedString(body.spocId);

  if (!attendanceId || !mongoose.Types.ObjectId.isValid(attendanceId)) {
    throw createBadRequestError("Valid attendanceId is required");
  }

  return { attendanceId, spocId };
};

const parseAttendanceRejectGeoPayload = (body = {}) => {
  const attendanceId = toSafeTrimmedString(body.attendanceId);
  const spocId = toSafeTrimmedString(body.spocId);
  const reason = toSafeTrimmedString(body.reason);

  if (!attendanceId || !mongoose.Types.ObjectId.isValid(attendanceId)) {
    throw createBadRequestError("Valid attendanceId is required");
  }

  if (!reason) {
    throw createBadRequestError("Manual rejection requires a reason/comment");
  }

  return { attendanceId, spocId, reason };
};

module.exports = {
  parseAttendanceListQuery,
  parseAttendanceDetailsParams,
  parseAttendanceScheduleParams,
  parseAttendanceTrainerParams,
  parseAttendanceTrainerQuery,
  parseAttendanceCollegeParams,
  parseAttendanceDocumentsQuery,
  parseAttendanceVerifyParams,
  parseAttendanceVerifyPayload,
  parseAttendanceDateBoundary,
  parseAttendanceDocumentVerifyPayload,
  parseAttendanceDocumentRejectPayload,
  parseAttendanceManualPayload,
  parseAttendanceVerifyGeoPayload,
  parseAttendanceRejectGeoPayload,
};
