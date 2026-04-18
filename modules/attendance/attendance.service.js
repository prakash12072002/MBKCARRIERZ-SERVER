const {
  normalizeAttendanceVerificationStatus,
} = require("../../utils/statusNormalizer");
const {
  invalidateTrainerScheduleCaches,
} = require("../../services/trainerScheduleCacheService");
const {
  ATTENDANCE_ALLOWED_READ_ROLES,
  ATTENDANCE_ALLOWED_VERIFY_ROLES,
} = require("./attendance.types");
const {
  buildAttendanceSearchFilters,
  findAttendanceByCollegeId,
  findAttendanceDocuments,
  findAttendanceByTrainerId,
  findAttendanceByScheduleId,
  findAttendanceVerificationPage,
  findAttendanceDetailsById,
  updateAttendanceVerificationStatus,
  updateScheduleDocumentStatus,
  findAttendanceByScheduleOrDocument,
  updateGeoVerificationStatus,
  createManualAttendanceRecord,
} = require("./attendance.repository");

const toPortalRole = (value) => String(value || "").trim().toLowerCase();

const assertAccess = (user = {}, allowedRoles = []) => {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
    return;
  }

  const userRole = toPortalRole(user?.role);
  if (!allowedRoles.includes(userRole)) {
    const accessError = new Error("Access denied.");
    accessError.statusCode = 403;
    throw accessError;
  }
};

const toPaginationPayload = ({ page, limit, total = 0 }) => {
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
};

const pushAndCondition = (filters = {}, condition = null) => {
  if (!condition || typeof condition !== "object") {
    return;
  }

  if (!Array.isArray(filters.$and)) {
    filters.$and = [];
  }
  filters.$and.push(condition);
};

const listAttendanceSubmissions = async ({ query, user }) => {
  assertAccess(user, ATTENDANCE_ALLOWED_READ_ROLES);

  if (query.hasInvalidStartDate) {
    const error = new Error("Invalid startDate. Use a valid date or YYYY-MM-DD format.");
    error.statusCode = 400;
    throw error;
  }

  if (query.hasInvalidEndDate) {
    const error = new Error("Invalid endDate. Use a valid date or YYYY-MM-DD format.");
    error.statusCode = 400;
    throw error;
  }

  const filters = {};

  if (query.view === "geo-verification") {
    // Keep geo-verification parity for canonical and legacy checkout submissions.
    // Some historical/manual rows have geo evidence but missing checkout timestamp;
    // those must still remain visible for SPOC/Admin review.
    pushAndCondition(filters, {
      $or: [
        { checkOutTime: { $exists: true, $ne: null } },
        { "checkOut.time": { $exists: true, $ne: null } },
        { checkOutGeoImageUrl: { $exists: true, $ne: null } },
        { checkOutGeoImageUrls: { $exists: true, $type: "array", $ne: [] } },
        { "checkOut.photos.0": { $exists: true } },
      ],
    });
  }

  if (query.verificationStatus) {
    filters.verificationStatus = query.verificationStatus;
  }

  if (query.geoVerificationStatus) {
    filters.geoVerificationStatus = query.geoVerificationStatus;
  }

  if (query.checkOutVerificationStatus) {
    if (query.checkOutVerificationStatus === "PENDING_OR_REVIEW") {
      pushAndCondition(filters, {
        $or: [
          {
            checkOutVerificationStatus: {
              $in: ["PENDING_CHECKOUT", "MANUAL_REVIEW_REQUIRED", "MANUAL_REVIEW"],
            },
          },
          {
            checkOutVerificationStatus: { $exists: false },
            geoVerificationStatus: "pending",
          },
          {
            checkOutVerificationStatus: null,
            geoVerificationStatus: "pending",
          },
        ],
      });
    } else if (query.checkOutVerificationStatus === "COMPLETED_OR_VERIFIED") {
      pushAndCondition(filters, {
        checkOutVerificationStatus: { $in: ["AUTO_VERIFIED", "VERIFIED"] },
      });
    } else if (query.checkOutVerificationStatus === "MANUAL_REVIEW_REQUIRED") {
      pushAndCondition(filters, {
        $or: [
          { checkOutVerificationStatus: { $in: ["MANUAL_REVIEW_REQUIRED", "MANUAL_REVIEW"] } },
          {
            checkOutVerificationStatus: { $exists: false },
            geoVerificationStatus: "pending",
            checkOutVerificationReason: { $exists: true, $ne: null },
          },
          {
            checkOutVerificationStatus: null,
            geoVerificationStatus: "pending",
            checkOutVerificationReason: { $exists: true, $ne: null },
          },
        ],
      });
    } else if (query.checkOutVerificationStatus === "REJECTED") {
      pushAndCondition(filters, {
        checkOutVerificationStatus: { $in: ["REJECTED", "MANUAL_REJECTED"] },
      });
    } else {
      filters.checkOutVerificationStatus = query.checkOutVerificationStatus;
    }
  }

  if (query.startDate || query.endDate) {
    filters.date = {};
    if (query.startDate) {
      filters.date.$gte = query.startDate;
    }
    if (query.endDate) {
      filters.date.$lte = query.endDate;
    }
  }

  const searchFilters = await buildAttendanceSearchFilters(query.search);
  if (searchFilters.length > 0) {
    filters.$or = searchFilters;
  } else if (query.hasSearch) {
    return {
      success: true,
      data: [],
      pagination: query.shouldPaginate
        ? toPaginationPayload({
          page: query.page,
          limit: query.limit,
          total: 0,
        })
        : undefined,
    };
  }

  const { data, total } = await findAttendanceVerificationPage({
    filters,
    view: query.view,
    shouldPaginate: query.shouldPaginate,
    page: query.page,
    limit: query.limit,
  });

  return {
    success: true,
    data,
    pagination: query.shouldPaginate
      ? toPaginationPayload({
        page: query.page,
        limit: query.limit,
        total,
      })
      : undefined,
  };
};

const getAttendanceSubmissionDetails = async ({ attendanceId, user }) => {
  assertAccess(user, ATTENDANCE_ALLOWED_READ_ROLES);

  if (!attendanceId) {
    const error = new Error("Attendance ID is required.");
    error.statusCode = 400;
    throw error;
  }

  const data = await findAttendanceDetailsById(attendanceId);
  if (!data) {
    const error = new Error("Attendance not found");
    error.statusCode = 404;
    throw error;
  }

  return {
    success: true,
    data,
  };
};

const getAttendanceLegacyDetails = async ({
  attendanceId,
  findAttendanceDetailsByIdLoader = findAttendanceDetailsById,
} = {}) => {
  const data = await findAttendanceDetailsByIdLoader(attendanceId);
  if (!data) {
    const error = new Error("Attendance not found");
    error.statusCode = 404;
    throw error;
  }

  return {
    success: true,
    data,
  };
};

const listAttendanceByTrainer = async ({
  trainerId,
  month,
  year,
  findAttendanceByTrainerIdLoader = findAttendanceByTrainerId,
} = {}) => {
  const data = await findAttendanceByTrainerIdLoader({
    trainerId,
    month,
    year,
  });

  return {
    success: true,
    count: Array.isArray(data) ? data.length : 0,
    data: Array.isArray(data) ? data : [],
  };
};

const listAttendanceByCollege = async ({
  collegeId,
  findAttendanceByCollegeIdLoader = findAttendanceByCollegeId,
} = {}) => {
  const data = await findAttendanceByCollegeIdLoader(collegeId);
  return {
    success: true,
    data,
  };
};

const listAttendanceDocuments = async ({
  filters,
  findAttendanceDocumentsLoader = findAttendanceDocuments,
} = {}) => {
  const data = await findAttendanceDocumentsLoader({ filters });
  const normalizedData = Array.isArray(data) ? data : [];
  return {
    success: true,
    count: normalizedData.length,
    data: normalizedData,
  };
};

const listAttendanceBySchedule = async ({
  scheduleId,
  findAttendanceByScheduleIdLoader = findAttendanceByScheduleId,
} = {}) => {
  const data = await findAttendanceByScheduleIdLoader(scheduleId);
  return {
    success: true,
    data,
  };
};

const verifyAttendanceSubmission = async ({ params, payload, user }) => {
  assertAccess(user, ATTENDANCE_ALLOWED_VERIFY_ROLES);

  if (!params.attendanceId) {
    const error = new Error("Attendance submission ID is required.");
    error.statusCode = 400;
    throw error;
  }

  const normalizedStatus = normalizeAttendanceVerificationStatus(payload.status, "");
  if (!["approved", "rejected", "pending"].includes(normalizedStatus)) {
    const error = new Error(
      `Invalid status. Must be "approved", "rejected", or "pending". Received: "${payload.status}"`,
    );
    error.statusCode = 400;
    throw error;
  }

  const attendance = await updateAttendanceVerificationStatus({
    attendanceId: params.attendanceId,
    status: normalizedStatus,
    comment: payload.comment,
    approvedBy: payload.approvedBy || null,
  });

  if (!attendance) {
    const error = new Error("Attendance record not found");
    error.statusCode = 404;
    throw error;
  }

  await invalidateTrainerScheduleCaches([attendance?.trainerId]);

  return {
    success: true,
    message: "Attendance verification status updated",
    data: attendance,
  };
};

const verifyAttendanceDocument = async ({ documentId, spocId, user }) => {
  const verifiedBy = spocId || user?.id || user?._id || null;

  const document = await updateScheduleDocumentStatus({
    documentId,
    status: "verified",
    verifiedBy,
  });

  if (!document) {
    const error = new Error("Document not found");
    error.statusCode = 404;
    throw error;
  }

  let attendance = null;
  if (document.scheduleId) {
    attendance = await findAttendanceByScheduleOrDocument({
      attendanceId: document.attendanceId,
      scheduleId: document.scheduleId,
    });
  }

  return {
    success: true,
    message: "Document verified successfully",
    data: document,
    meta: {
      scheduleId: document.scheduleId,
      attendanceId: document.attendanceId,
      attendance,
    },
  };
};

const rejectAttendanceDocument = async ({ documentId, spocId, rejectReason, user }) => {
  const verifiedBy = spocId || user?.id || user?._id || null;

  const document = await updateScheduleDocumentStatus({
    documentId,
    status: "rejected",
    verifiedBy,
    rejectReason,
  });

  if (!document) {
    const error = new Error("Document not found");
    error.statusCode = 404;
    throw error;
  }

  let attendance = null;
  if (document.scheduleId) {
    attendance = await findAttendanceByScheduleOrDocument({
      attendanceId: document.attendanceId,
      scheduleId: document.scheduleId,
    });
  }

  return {
    success: true,
    message: "Document rejected successfully",
    data: document,
    meta: {
      scheduleId: document.scheduleId,
      attendanceId: document.attendanceId,
      attendance,
    },
  };
};

const markManualAttendance = async ({ payload, user }) => {
  const attendance = await createManualAttendanceRecord(payload);

  return {
    success: true,
    message: "Manual attendance created successfully",
    data: attendance,
    meta: {
      scheduleId: payload.scheduleId,
      attendanceId: attendance._id,
      attendance,
    },
  };
};

const verifyGeoVerification = async ({ attendanceId, spocId, user }) => {
  assertAccess(user, ATTENDANCE_ALLOWED_VERIFY_ROLES);

  if (!attendanceId) {
    const error = new Error("Attendance ID is required.");
    error.statusCode = 400;
    throw error;
  }

  const attendance = await updateGeoVerificationStatus({
    attendanceId,
    status: "VERIFIED",
    mode: "MANUAL",
    verifiedBy: spocId || user?.id || user?._id,
  });

  if (!attendance) {
    const error = new Error("Attendance record not found");
    error.statusCode = 404;
    throw error;
  }

  await invalidateTrainerScheduleCaches([attendance?.trainerId]);

  return {
    success: true,
    message: "Geo-tag verification approved manually",
    data: attendance,
    meta: {
      scheduleId: attendance.scheduleId,
      attendanceId: attendance._id,
      attendance,
    },
  };
};

const rejectGeoVerification = async ({ attendanceId, spocId, reason, user }) => {
  assertAccess(user, ATTENDANCE_ALLOWED_VERIFY_ROLES);

  if (!attendanceId) {
    const error = new Error("Attendance ID is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!reason) {
    const error = new Error("Rejection reason is required for manual rejection.");
    error.statusCode = 400;
    throw error;
  }

  const attendance = await updateGeoVerificationStatus({
    attendanceId,
    status: "REJECTED",
    mode: "MANUAL",
    verifiedBy: spocId || user?.id || user?._id,
    reason,
  });

  if (!attendance) {
    const error = new Error("Attendance record not found");
    error.statusCode = 404;
    throw error;
  }

  await invalidateTrainerScheduleCaches([attendance?.trainerId]);

  return {
    success: true,
    message: "Geo-tag verification rejected manually",
    data: attendance,
    meta: {
      scheduleId: attendance.scheduleId,
      attendanceId: attendance._id,
      attendance,
    },
  };
};

module.exports = {
  getAttendanceLegacyDetails,
  listAttendanceByCollege,
  listAttendanceDocuments,
  listAttendanceByTrainer,
  listAttendanceBySchedule,
  listAttendanceSubmissions,
  getAttendanceSubmissionDetails,
  verifyAttendanceSubmission,
  verifyAttendanceDocument,
  rejectAttendanceDocument,
  markManualAttendance,
  verifyGeoVerification,
  rejectGeoVerification,
};
