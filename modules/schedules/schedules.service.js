const dayjs = require("dayjs");
const fs = require("fs");
const xlsx = require("xlsx");
const { parseDepartments } = require("../../utils/departmentAccess");

const {
  listDepartmentAttendanceDocs,
  listDepartmentSchedules,
  findScopedCompanyIdsByUserId,
  listLatestAttendanceByScheduleIds,
  listLiveDashboardSchedules,
  listSchedules,
  listTrainerAttendanceDocs,
  listTrainerSchedules,
  getCollegeById,
  getCourseById,
  getScheduleByIdForAssignment,
  getScheduleByIdForDelete,
  getScheduleByIdForUpdate,
  getScheduleById,
  getTrainerByIdWithUser,
  getUserById,
  listAssociationsCompanies,
  listAssociationsCourses,
  listAssociationsColleges,
  listAssociationsDepartments,
  listCollegesByIds,
  listExistingDaySlotSchedules,
  insertManySchedules,
  bulkWriteSchedules,
  listSchedulesByIds,
  findCompanyByNameCaseInsensitive,
  createCompanyDocument,
  saveCompanyDocument,
  findCourseByTitleAndCompany,
  createCourseDocument,
  findCollegeByNameAndCourse,
  createCollegeDocument,
  findTrainerByCustomIdWithUser,
  createUserDocument,
  createTrainerDocument,
  findApprovedAttendanceByCollegeAndDateRange,
  findScheduleByCollegeCourseAndDateRange,
  findLastScheduleByCollege,
  createScheduleInstance,
  createNotificationDocument,
  createActivityLogDocument,
  createScheduleDocument,
  deleteScheduleDocument,
  saveScheduleDocument,
  updateAttendanceStatusByScheduleId,
  insertAssociationsDepartments,
  resolveTrainerScheduleFilterContext,
} = require("./schedules.repository");
const {
  ASSIGN_SCHEDULE_NOT_FOUND_MESSAGE,
  ASSIGN_SCHEDULE_SUCCESS_MESSAGE,
  BULK_CREATE_EMPTY_RESULT_MESSAGE,
  BULK_CREATE_REQUIRED_ARRAY_MESSAGE,
  CREATE_SCHEDULE_SUCCESS_MESSAGE,
  BULK_UPLOAD_NO_FILE_MESSAGE,
  BULK_UPLOAD_SHEET_NAME_MESSAGE,
  DELETE_SCHEDULE_DEFAULT_REASON,
  DELETE_SCHEDULE_NOT_FOUND_MESSAGE,
  DELETE_SCHEDULE_SUCCESS_MESSAGE,
  DEFAULT_DEPARTMENT_DAY_SLOTS,
  TRAINER_SCHEDULE_DEFAULT_STATUS,
  UPDATE_SCHEDULE_NOT_FOUND_MESSAGE,
  UPDATE_SCHEDULE_SUCCESS_MESSAGE,
} = require("./schedules.types");
const {
  getCachedTrainerScheduleResponse,
  invalidateTrainerScheduleCaches,
  setCachedTrainerScheduleResponse,
} = require("../../services/trainerScheduleCacheService");
const { sendBulkScheduleEmail, sendScheduleChangeEmail } = require("../../utils/emailService");
const { autoCreateTrainerAdminChannels } = require("../../services/streamChatService");
const { notifyTrainerSchedule } = require("../../services/notificationService");
const {
  ensureCompanyHierarchy,
  isTrainingDriveEnabled,
} = require("../drive/driveGateway");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");

const schedulesAsyncLogger = createStructuredLogger({
  service: "schedules",
  component: "async-side-effects",
});

const logScheduleAsyncTelemetry = (level, fields = {}) => {
  const method = typeof schedulesAsyncLogger[level] === "function" ? level : "info";
  schedulesAsyncLogger[method]({
    correlationId: fields.correlationId || null,
    stage: fields.stage || null,
    trainerId: fields.trainerId || null,
    documentId: fields.documentId || null,
    scheduleId: fields.scheduleId || null,
    status: fields.status || null,
    attempt: Number.isFinite(fields.attempt) ? fields.attempt : null,
    outcome: fields.outcome || null,
    cleanupMode: fields.cleanupMode || null,
    reason: fields.reason || null,
    actorUserId: fields.actorUserId || null,
    companyId: fields.companyId || null,
    courseId: fields.courseId || null,
    collegeId: fields.collegeId || null,
    departmentId: fields.departmentId || null,
    dayNumber: Number.isFinite(fields.dayNumber) ? fields.dayNumber : null,
    notifyChannel: fields.notifyChannel || null,
  });
};

const toNormalizedRoleToken = (value) => String(value || "").trim().toLowerCase();

const isSpocRole = (role) => {
  const normalizedRole = toNormalizedRoleToken(role);
  return normalizedRole === "spocadmin"
    || normalizedRole === "spoc"
    || normalizedRole === "collegeadmin"
    || normalizedRole === "companyadmin";
};

const listSchedulesFeed = async ({
  query,
  user,
  listSchedulesLoader = listSchedules,
  findScopedCompanyIdsLoader = findScopedCompanyIdsByUserId,
} = {}) => {
  const filter = {};

  if (isSpocRole(user?.role)) {
    const userId = user?._id || user?.id || null;
    const scopedCompanyIds = await findScopedCompanyIdsLoader(userId);

    if (scopedCompanyIds.length > 0) {
      filter.$or = [
        { companyId: { $in: scopedCompanyIds } },
        { createdBy: userId },
      ];
    } else if (userId) {
      filter.createdBy = userId;
    } else {
      return { success: true, count: 0, data: [] };
    }
  }


  const result = await listSchedulesLoader({
    filter,
    shouldPaginate: query.shouldPaginate,
    page: query.page,
    limit: query.limit,
  });

  if (!query.shouldPaginate) {
    return {
      success: true,
      count: result.schedules.length,
      data: result.schedules,
    };
  }

  const totalPages = result.total > 0 ? Math.ceil(result.total / query.limit) : 0;

  return {
    success: true,
    count: result.schedules.length,
    data: result.schedules,
    pagination: {
      page: query.page,
      limit: query.limit,
      total: result.total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPrevPage: query.page > 1,
    },
  };
};

const buildLatestAttendanceByScheduleId = (attendanceRows = []) => {
  const latestAttendanceByScheduleId = new Map();

  attendanceRows.forEach((attendance) => {
    const scheduleKey = String(attendance?.scheduleId || "").trim();
    if (!scheduleKey || latestAttendanceByScheduleId.has(scheduleKey)) return;
    latestAttendanceByScheduleId.set(scheduleKey, attendance);
  });

  return latestAttendanceByScheduleId;
};

const listLiveDashboardFeed = async ({
  user,
  listLiveDashboardSchedulesLoader = listLiveDashboardSchedules,
  listLatestAttendanceLoader = listLatestAttendanceByScheduleIds,
  findScopedCompanyIdsLoader = findScopedCompanyIdsByUserId,
} = {}) => {
  const today = dayjs().startOf("day").toDate();
  const tomorrow = dayjs().endOf("day").toDate();

  const filter = {
    scheduledDate: { $gte: today, $lte: tomorrow },
    status: { $ne: "cancelled" },
  };

  if (isSpocRole(user?.role)) {
    const userId = user?._id || user?.id || null;
    const scopedCompanyIds = await findScopedCompanyIdsLoader(userId);

    if (scopedCompanyIds.length > 0) {
      filter.$or = [
        { companyId: { $in: scopedCompanyIds } },
        { createdBy: userId },
      ];
    } else if (userId) {
      filter.createdBy = userId;
    } else {
      return { success: true, count: 0, data: [] };
    }
  }


  const schedules = await listLiveDashboardSchedulesLoader({ filter });
  const scheduleIds = schedules.map((schedule) => schedule?._id).filter(Boolean);
  const attendanceRows = await listLatestAttendanceLoader({ scheduleIds });
  const latestAttendanceByScheduleId = buildLatestAttendanceByScheduleId(attendanceRows);

  const liveSchedules = schedules.map((schedule) => {
    const attendance =
      latestAttendanceByScheduleId.get(String(schedule?._id || "").trim()) || null;

    return {
      ...schedule,
      liveStatus: attendance
        ? {
          status: attendance.status,
          checkInTime: attendance.checkInTime,
          checkOutTime: attendance.checkOutTime,
          location: attendance.location,
          geoStatus: attendance.geoVerificationStatus,
          verificationStatus: attendance.verificationStatus,
          lastUpdateAt: attendance.updatedAt,
        }
        : null,
    };
  });

  return {
    success: true,
    count: liveSchedules.length,
    data: liveSchedules,
  };
};

const hasAttendanceDocs = (attendance) =>
  Boolean(attendance?.attendancePdfUrl || attendance?.attendanceExcelUrl);

const hasGeoTagDocs = (attendance) =>
  Boolean(
    attendance?.signatureUrl
    || attendance?.studentsPhotoUrl
    || attendance?.checkOutGeoImageUrl
    || (Array.isArray(attendance?.checkOutGeoImageUrls) && attendance.checkOutGeoImageUrls.length)
    || (Array.isArray(attendance?.activityPhotos) && attendance.activityPhotos.length)
    || (Array.isArray(attendance?.activityVideos) && attendance.activityVideos.length),
  );

const normalizeGeoVerificationToken = (value) =>
  String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

const deriveCheckoutGeoState = (attendance) => {
  const checkOutVerification = normalizeGeoVerificationToken(attendance?.checkOutVerificationStatus);
  if (checkOutVerification) {
    if (
      checkOutVerification === "auto_verified"
      || checkOutVerification === "approved"
      || checkOutVerification === "verified"
      || checkOutVerification === "completed"
    ) {
      return "approved";
    }

    if (checkOutVerification === "rejected" || checkOutVerification === "manually_rejected") {
      return "rejected";
    }

    if (
      checkOutVerification === "manual_review_required"
      || checkOutVerification === "manual_review"
      || checkOutVerification === "review_required"
    ) {
      return "manual_review_required";
    }

    if (checkOutVerification === "pending_checkout" || checkOutVerification === "pending") {
      return "pending";
    }
  }

  const legacyGeoVerification = normalizeGeoVerificationToken(attendance?.geoVerificationStatus);
  if (legacyGeoVerification === "approved") return "approved";
  if (legacyGeoVerification === "rejected") return "rejected";
  return "pending";
};

const isGeoVerificationApproved = (attendance) => {
  return deriveCheckoutGeoState(attendance) === "approved";
};

const isGeoVerificationRejected = (attendance) => {
  return deriveCheckoutGeoState(attendance) === "rejected";
};

const isAttendanceVerificationApproved = (attendance) => {
  const token = normalizeGeoVerificationToken(attendance?.verificationStatus);
  return (
    token === "approved"
    || token === "verified"
    || token === "completed"
    || token === "auto_verified"
    || token === "manually_verified"
  );
};

const normalizeDayStatus = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "pending") return "pending";
  if (normalized === "not_assigned") return "not_assigned";
  return null;
};

const buildDayUploadStatus = (schedule, attendance) => {
  const attendanceUploaded = Boolean(
    hasAttendanceDocs(attendance)
    || schedule?.attendanceUploaded === true,
  );
  const geoTagUploaded = Boolean(
    hasGeoTagDocs(attendance)
    || schedule?.geoTagUploaded === true,
  );
  const persistedDayStatus = normalizeDayStatus(schedule?.dayStatus);
  const normalizedScheduleStatus = String(schedule?.status || "").trim().toLowerCase();
  const hasTrainerAssigned = Boolean(schedule?.trainerId);
  const attendanceVerified = isAttendanceVerificationApproved(attendance);
  const geoVerified = isGeoVerificationApproved(attendance);
  const docsRejected =
    normalizeGeoVerificationToken(attendance?.verificationStatus) === "rejected"
    || isGeoVerificationRejected(attendance);
  const checkoutGeoState = deriveCheckoutGeoState(attendance);

  if (!hasTrainerAssigned || normalizedScheduleStatus === "cancelled") {
    return {
      attendanceUploaded,
      geoTagUploaded,
      statusCode: "not_assigned",
      statusLabel: "Not Assigned",
    };
  }

  if (attendanceUploaded && geoTagUploaded && attendanceVerified && geoVerified && !docsRejected) {
    return {
      attendanceUploaded,
      geoTagUploaded,
      statusCode: "completed",
      statusLabel: "Completed",
    };
  }

  // Backward compatibility: keep persisted completion if docs remain uploaded and not rejected.
  if (
    persistedDayStatus === "completed"
    && attendanceUploaded
    && geoTagUploaded
    && !docsRejected
    && checkoutGeoState !== "manual_review_required"
    && checkoutGeoState !== "pending"
  ) {
    return {
      attendanceUploaded,
      geoTagUploaded,
      statusCode: "completed",
      statusLabel: "Completed",
    };
  }

  if (persistedDayStatus === "pending" || persistedDayStatus === "not_assigned") {
    return {
      attendanceUploaded,
      geoTagUploaded,
      statusCode: persistedDayStatus,
      statusLabel: persistedDayStatus === "pending" ? "Pending" : "Not Assigned",
    };
  }

  return {
    attendanceUploaded,
    geoTagUploaded,
    statusCode: "pending",
    statusLabel: "Pending",
  };
};

const buildDayStatusTooltip = (
  _schedule,
  { attendanceUploaded = false, geoTagUploaded = false, statusCode = "not_assigned" } = {},
) => {
  if (statusCode === "not_assigned") return "Trainer not assigned";
  if (statusCode === "completed") return "All documents uploaded";
  if (!attendanceUploaded && !geoTagUploaded) return "Attendance and GeoTag missing";
  if (!attendanceUploaded) return "Attendance missing";
  if (!geoTagUploaded) return "GeoTag missing";
  return "Upload Missing Docs";
};

const toAttendanceEventTime = (attendance) => {
  const candidates = [
    attendance?.updatedAt,
    attendance?.createdAt,
    attendance?.checkOutVerifiedAt,
    attendance?.approvedAt,
    attendance?.checkOutCapturedAt,
  ];

  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }

  return 0;
};

const computeAttendanceSelectionScore = (attendance) => {
  const docsApproved = normalizeGeoVerificationToken(attendance?.verificationStatus) === "approved";
  const docsRejected = normalizeGeoVerificationToken(attendance?.verificationStatus) === "rejected";
  const geoState = deriveCheckoutGeoState(attendance);
  const geoApproved = geoState === "approved";
  const geoRejected = geoState === "rejected";
  const manualReviewRequired = geoState === "manual_review_required";
  const hasDocs = hasAttendanceDocs(attendance);
  const hasGeoEvidence = hasGeoTagDocs(attendance);

  if (docsApproved && geoApproved && !docsRejected && !geoRejected) return 600;
  if (docsApproved && manualReviewRequired && !docsRejected) return 500;
  if (docsApproved && hasGeoEvidence && !docsRejected) return 450;
  if (docsApproved && !docsRejected) return 420;
  if (docsRejected || geoRejected) return 300;
  if (hasDocs && hasGeoEvidence) return 220;
  if (hasDocs) return 150;
  if (hasGeoEvidence) return 120;
  return 0;
};

const isPreferredAttendanceCandidate = (candidate, current) => {
  if (!candidate) return false;
  if (!current) return true;

  const candidateScore = computeAttendanceSelectionScore(candidate);
  const currentScore = computeAttendanceSelectionScore(current);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore;
  }

  const candidateTime = toAttendanceEventTime(candidate);
  const currentTime = toAttendanceEventTime(current);
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }

  return String(candidate?._id || "") > String(current?._id || "");
};

const toScheduleEventTime = (schedule) => {
  const candidates = [
    schedule?.updatedAt,
    schedule?.scheduledDate,
    schedule?.createdAt,
  ];

  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }

  return 0;
};

const computeScheduleSelectionScore = (schedule) => {
  const dayStatus = normalizeDayStatus(schedule?.dayStatus);
  const lifecycle = String(schedule?.status || "").trim().toLowerCase();
  const hasTrainerAssigned = Boolean(schedule?.trainerId);
  const hasAttendanceUploadFlag = schedule?.attendanceUploaded === true;
  const hasGeoUploadFlag = schedule?.geoTagUploaded === true;

  if (lifecycle === "cancelled") return -100;
  if (dayStatus === "completed") return 500 + (hasTrainerAssigned ? 20 : 0);
  if (lifecycle === "completed") return 480 + (hasTrainerAssigned ? 20 : 0);
  if (dayStatus === "pending") return 320 + (hasTrainerAssigned ? 20 : 0);
  if (hasTrainerAssigned && hasAttendanceUploadFlag && hasGeoUploadFlag) return 280;
  if (hasTrainerAssigned) return 220;
  if (dayStatus === "not_assigned") return 100;
  return 0;
};

const isPreferredScheduleCandidate = (candidate, current) => {
  if (!candidate) return false;
  if (!current) return true;

  const candidateScore = computeScheduleSelectionScore(candidate);
  const currentScore = computeScheduleSelectionScore(current);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore;
  }

  const candidateTime = toScheduleEventTime(candidate);
  const currentTime = toScheduleEventTime(current);
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }

  return String(candidate?._id || "") > String(current?._id || "");
};

const indexSchedulesByDay = (schedules = []) => {
  const scheduleByDay = new Map();

  schedules.forEach((schedule) => {
    const dayNumber = Number(schedule?.dayNumber);
    if (!Number.isFinite(dayNumber) || dayNumber <= 0) return;
    const current = scheduleByDay.get(dayNumber);
    if (isPreferredScheduleCandidate(schedule, current)) {
      scheduleByDay.set(dayNumber, schedule);
    }
  });

  return scheduleByDay;
};

const buildDepartmentDaysPayload = ({
  schedules = [],
  attendanceDocs = [],
  totalDays = DEFAULT_DEPARTMENT_DAY_SLOTS,
} = {}) => {
  const scheduleByDay = indexSchedulesByDay(schedules);
  const attendanceBySchedule = new Map();

  attendanceDocs.forEach((attendance) => {
    const scheduleKey = String(attendance?.scheduleId || "").trim();
    if (!scheduleKey) return;

    const current = attendanceBySchedule.get(scheduleKey);
    if (isPreferredAttendanceCandidate(attendance, current)) {
      attendanceBySchedule.set(scheduleKey, attendance);
    }
  });

  return Array.from({ length: totalDays }, (_, index) => {
    const dayNumber = index + 1;
    const schedule = scheduleByDay.get(dayNumber) || null;
    const attendance = schedule ? attendanceBySchedule.get(String(schedule._id)) : null;
    const dayUploadStatus = buildDayUploadStatus(schedule, attendance);
    const statusTooltip = buildDayStatusTooltip(schedule, dayUploadStatus);

    return {
      id: schedule?._id || `placeholder-${dayNumber}`,
      dayNumber,
      label: `Day ${dayNumber}`,
      trainerId: schedule?.trainerId?._id || null,
      trainerName: schedule?.trainerId?.userId?.name || "Not Assigned",
      trainerCustomId: schedule?.trainerId?.trainerId || null,
      date: schedule?.scheduledDate || null,
      startTime: schedule?.startTime || null,
      endTime: schedule?.endTime || null,
      time: schedule?.startTime && schedule?.endTime ? `${schedule.startTime} - ${schedule.endTime}` : null,
      syllabusName: schedule?.subject || `Day ${dayNumber} Content`,
      status: dayUploadStatus.statusCode,
      statusLabel: dayUploadStatus.statusLabel,
      statusTooltip,
      attendanceUploaded: dayUploadStatus.attendanceUploaded,
      geoTagUploaded: dayUploadStatus.geoTagUploaded,
      verificationStatus: attendance?.verificationStatus || "pending",
      geoVerificationStatus: attendance?.geoVerificationStatus || "pending",
      checkOutVerificationStatus: attendance?.checkOutVerificationStatus || "pending_checkout",
      driveFolderId: schedule?.driveFolderId || schedule?.dayFolderId || null,
      driveFolderLink: schedule?.driveFolderLink || schedule?.dayFolderLink || null,
      dayFolderId: schedule?.dayFolderId || schedule?.driveFolderId || null,
      dayFolderLink: schedule?.dayFolderLink || schedule?.driveFolderLink || null,
      attendanceFolderId: schedule?.attendanceFolderId || null,
      attendanceFolderLink: schedule?.attendanceFolderLink || null,
      geoTagFolderId: schedule?.geoTagFolderId || null,
      geoTagFolderLink: schedule?.geoTagFolderLink || null,
      attendancePdfUrl: attendance?.attendancePdfUrl || null,
      attendanceExcelUrl: attendance?.attendanceExcelUrl || null,
      studentsPhotoUrl: attendance?.studentsPhotoUrl || null,
      signatureUrl: attendance?.signatureUrl || null,
      checkOutGeoImageUrl: attendance?.checkOutGeoImageUrl || null,
      checkOutGeoImageUrls: attendance?.checkOutGeoImageUrls || [],
      activityPhotos: attendance?.activityPhotos || [],
      activityVideos: attendance?.activityVideos || [],
      approvedBy: attendance?.approvedBy || null,
      studentsPresent: attendance?.studentsPresent || 0,
      studentsAbsent: attendance?.studentsAbsent || 0,
      checkInTime: attendance?.checkInTime || null,
      checkOutTime: attendance?.checkOutTime || null,
      geoTag: attendance?.latitude != null && attendance?.longitude != null
        ? `${attendance.latitude}, ${attendance.longitude}`
        : null,
    };
  });
};

const listDepartmentDaysFeed = async ({ departmentId }) => {
  const schedules = await listDepartmentSchedules({ departmentId });
  const scheduleByDay = indexSchedulesByDay(schedules);
  const scheduleIds = Array.from(scheduleByDay.values()).map((schedule) => schedule._id);
  const attendanceDocs = await listDepartmentAttendanceDocs({ scheduleIds });

  return buildDepartmentDaysPayload({
    schedules,
    attendanceDocs,
  });
};

const normalizeScheduleLifecycleStatus = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "COMPLETED") return "COMPLETED";
  if (normalized === "IN_PROGRESS" || normalized === "INPROGRESS") return "inprogress";
  if (normalized === "ASSIGNED" || normalized === "SCHEDULED") return TRAINER_SCHEDULE_DEFAULT_STATUS;
  if (normalized === "CANCELLED") return "cancelled";
  return String(value || "").trim() || TRAINER_SCHEDULE_DEFAULT_STATUS;
};

const deriveTrainerScheduleStatus = (schedule, attendance) => {
  const rawStatus = normalizeScheduleLifecycleStatus(schedule?.status);
  const attendanceVerification = String(attendance?.verificationStatus || "").trim().toLowerCase();
  const geoVerification = String(attendance?.geoVerificationStatus || "").trim().toLowerCase();

  if (attendanceVerification !== "approved" && attendance) {
    return TRAINER_SCHEDULE_DEFAULT_STATUS;
  }

  if (attendanceVerification === "approved" && geoVerification === "approved") {
    return "COMPLETED";
  }

  if (attendanceVerification === "approved") {
    return "inprogress";
  }

  return rawStatus;
};

const deriveTrainerScheduleActionability = (schedule, attendance) => {
  if (!schedule || typeof schedule !== "object") return false;
  if (schedule.isActive === false) return false;

  const scheduleStatus = String(schedule?.status || "").trim().toLowerCase();
  if (scheduleStatus === "cancelled" || scheduleStatus === "completed") {
    return false;
  }

  const attendanceSessionStatus = String(attendance?.status || "").trim().toLowerCase();
  if (attendanceSessionStatus === "cancelled" || attendanceSessionStatus === "canceled") {
    return false;
  }

  return Boolean(schedule?._id);
};

const buildTrainerSchedulesPayload = ({
  schedules = [],
  attendanceDocs = [],
} = {}) => {
  const latestAttendanceByScheduleId = new Map();

  attendanceDocs.forEach((attendance) => {
    const scheduleKey = String(attendance?.scheduleId || "").trim();
    const current = latestAttendanceByScheduleId.get(scheduleKey);
    if (scheduleKey && isPreferredAttendanceCandidate(attendance, current)) {
      latestAttendanceByScheduleId.set(scheduleKey, attendance);
    }
  });

  return schedules.map((schedule) => {
    const attendance = latestAttendanceByScheduleId.get(String(schedule?._id || "")) || null;
    const dayUploadStatus = buildDayUploadStatus(schedule, attendance);
    const trainerScheduleStatus = deriveTrainerScheduleStatus(schedule, attendance);
    const isActionable = deriveTrainerScheduleActionability(schedule, attendance);

    return {
      ...schedule,
      status: trainerScheduleStatus,
      rawStatus: schedule.status,
      isActionable,
      dayStatus: dayUploadStatus.statusCode,
      dayStatusLabel: dayUploadStatus.statusLabel,
      attendanceUploaded: dayUploadStatus.attendanceUploaded,
      geoTagUploaded: dayUploadStatus.geoTagUploaded,
      assignedDate: attendance ? attendance.assignedDate || null : null,
      images: attendance ? attendance.images || [] : [],
      finalStatus: attendance ? attendance.finalStatus || null : null,
      attendanceStatus: attendance ? attendance.verificationStatus : null,
      attendancePresenceStatus: attendance ? attendance.status || null : null,
      geoVerificationStatus: attendance ? attendance.geoVerificationStatus : null,
      verificationComment: attendance ? attendance.verificationComment : null,
      geoValidationComment: attendance ? attendance.geoValidationComment : null,
      checkOut: attendance ? attendance.checkOut || null : null,
    };
  });
};

const listTrainerSchedulesFeed = async ({
  trainerId,
  month,
  year,
  status,
  resolveTrainerScheduleFilterContextLoader = resolveTrainerScheduleFilterContext,
  getCachedTrainerScheduleResponseLoader = getCachedTrainerScheduleResponse,
  setCachedTrainerScheduleResponseLoader = setCachedTrainerScheduleResponse,
  listTrainerSchedulesLoader = listTrainerSchedules,
  listTrainerAttendanceDocsLoader = listTrainerAttendanceDocs,
} = {}) => {
  const trainerFilterContext = await resolveTrainerScheduleFilterContextLoader({
    trainerIdentifier: trainerId,
  });
  const effectiveTrainerFilterIds = trainerFilterContext.filterTrainerIds;
  const cacheTrainerId = trainerFilterContext.cacheTrainerId || trainerId;

  if (!effectiveTrainerFilterIds.length) {
    return {
      success: true,
      count: 0,
      data: [],
    };
  }

  const cacheParams = { trainerId: cacheTrainerId, month, year, status };
  const cachedResponse = await getCachedTrainerScheduleResponseLoader(cacheParams);

  if (cachedResponse) {
    return cachedResponse;
  }

  const filter = {
    trainerId: effectiveTrainerFilterIds.length === 1
      ? effectiveTrainerFilterIds[0]
      : { $in: effectiveTrainerFilterIds },
    isActive: { $ne: false },
  };

  if (status) {
    filter.status = status;
  }

  if (month && year) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);
    filter.scheduledDate = {
      $gte: startDate,
      $lt: endDate,
    };
  }

  const schedules = await listTrainerSchedulesLoader({ filter });
  const scheduleIds = schedules.map((schedule) => schedule._id);
  const attendanceDocs = await listTrainerAttendanceDocsLoader({ scheduleIds });
  const schedulesWithAttendance = buildTrainerSchedulesPayload({
    schedules,
    attendanceDocs,
  });

  const responsePayload = {
    success: true,
    count: schedulesWithAttendance.length,
    data: schedulesWithAttendance,
  };

  await setCachedTrainerScheduleResponseLoader(cacheParams, responsePayload);

  return responsePayload;
};

const getScheduleDetailsFeed = async ({
  scheduleId,
  scheduleLoader = getScheduleById,
} = {}) => scheduleLoader({ scheduleId });

const toDateKey = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const keyForSchedule = (schedule = {}) => ([
  String(schedule.trainerId || ""),
  String(schedule.collegeId || ""),
  String(schedule.departmentId || "null"),
  String(schedule.dayNumber ?? ""),
  String(toDateKey(schedule.scheduledDate) || ""),
].join("::"));

const keyForDaySlot = (schedule = {}) => ([
  String(schedule.collegeId || ""),
  String(schedule.departmentId || "null"),
  String(schedule.dayNumber ?? ""),
].join("::"));

const getCaseInsensitiveCellValue = (row = {}, key = "") => {
  const normalizedKey = String(key || "").toLowerCase().replace(/\s/g, "");
  const actualKey = Object.keys(row || {}).find(
    (columnKey) => String(columnKey || "").toLowerCase().replace(/\s/g, "") === normalizedKey,
  );
  return actualKey ? row[actualKey] : null;
};

const createScheduleFeed = async ({
  payload = {},
  actorUserId = null,
  io = null,
  resolveScheduleFolderFields = async () => ({}),
  createScheduleLoader = createScheduleDocument,
  getCollegeByIdLoader = getCollegeById,
  getTrainerByIdLoader = getTrainerByIdWithUser,
  getCourseByIdLoader = getCourseById,
  getUserByIdLoader = getUserById,
  sendScheduleChangeEmailLoader = sendScheduleChangeEmail,
  sendInAppNotificationLoader,
  createTrainerAdminChannelsLoader = autoCreateTrainerAdminChannels,
  invalidateTrainerScheduleCachesLoader = invalidateTrainerScheduleCaches,
} = {}) => {
  const {
    trainerId,
    companyId,
    courseId,
    collegeId,
    departmentId,
    dayNumber,
    scheduledDate,
    startTime,
    endTime,
    subject,
    createdBy: payloadCreatedBy,
  } = payload;

  const createdBy = payloadCreatedBy || actorUserId;
  const college = await getCollegeByIdLoader({ collegeId });

  let folderFields = {};
  try {
    folderFields = await resolveScheduleFolderFields({
      companyId,
      courseId,
      collegeId,
      departmentId,
      dayNumber,
      fallbackFields: payload,
    }) || {};
  } catch (driveError) {
    schedulesAsyncLogger.warn({
      correlationId: null,
      stage: "create_schedule_drive_folder_resolution_failed",
      status: "drive",
      outcome: "skipped",
      reason: driveError?.message || "Unknown drive error",
      companyId: companyId ? String(companyId) : null,
      courseId: courseId ? String(courseId) : null,
      collegeId: collegeId ? String(collegeId) : null,
      departmentId: departmentId ? String(departmentId) : null,
      dayNumber: Number.isFinite(Number(dayNumber)) ? Number(dayNumber) : null,
    });
  }

  const schedule = await createScheduleLoader({
    schedulePayload: {
      trainerId,
      companyId,
      courseId,
      collegeId,
      departmentId: departmentId || null,
      collegeLocation: college?.location || {},
      dayNumber,
      scheduledDate,
      startTime,
      endTime,
      subject,
      createdBy,
      status: "scheduled",
      ...(folderFields || {}),
    },
  });

  if (trainerId && typeof invalidateTrainerScheduleCachesLoader === "function") {
    await invalidateTrainerScheduleCachesLoader(trainerId);
  }

  const sideEffectCorrelationId = createCorrelationId("sched_create");
  const sideEffectTask = (async () => {
    try {
      const trainer = await getTrainerByIdLoader({ trainerId });
      if (trainer && trainer.userId && trainer.userId.email) {
        const collegeForNotification = await getCollegeByIdLoader({ collegeId });
        const courseForNotification = await getCourseByIdLoader({ courseId });
        const spocName = collegeForNotification?.principalName || "N/A";
        const spocPhone = collegeForNotification?.phone || "";
        const mapLink = collegeForNotification?.location?.mapUrl || (
          collegeForNotification?.location?.lat && collegeForNotification?.location?.lng
            ? `https://www.google.com/maps?q=${collegeForNotification.location.lat},${collegeForNotification.location.lng}`
            : ""
        );

        if (typeof sendScheduleChangeEmailLoader === "function") {
          await sendScheduleChangeEmailLoader(
            trainer.userId.email,
            trainer.name || trainer.userId.name,
            {
              date: dayjs(scheduledDate).format("DD-MM-YYYY"),
              day: dayNumber ? `Day ${dayNumber}` : dayjs(scheduledDate).format("dddd"),
              college: collegeForNotification?.name || "Assigned College",
              course: courseForNotification?.title || "Assigned Course",
              startTime,
              endTime,
              location: collegeForNotification?.location?.address || "",
              mapLink,
              spocName,
              spocPhone,
            },
            "assignment",
            "New training session assigned by administrator.",
          );
        }

        try {
          if (typeof sendInAppNotificationLoader === "function") {
            await sendInAppNotificationLoader(io, {
              userId: trainer.userId._id,
              role: "Trainer",
              title: "Training Assigned",
              message: `Training Assigned - ${courseForNotification?.title || "TEST COURSE"} (${dayNumber ? `Day ${dayNumber}` : "Day 1"}). ${collegeForNotification?.name} on ${dayjs(scheduledDate).format("DD-MM-YYYY")} (${startTime} - ${endTime}). CoNDAct SPOC: ${spocName} (${spocPhone})`,
              type: "Schedule",
              link: "/trainer/schedule",
            });
          }
        } catch (error) {
          logScheduleAsyncTelemetry("warn", {
            correlationId: sideEffectCorrelationId,
            stage: "create_schedule_in_app_notification_failed",
            status: "notification",
            outcome: "failed",
            cleanupMode: "none",
            reason: error?.message || "Unknown error",
            actorUserId: actorUserId || createdBy,
            trainerId: trainer?.userId?._id ? String(trainer.userId._id) : null,
            scheduleId: schedule?._id ? String(schedule._id) : null,
            companyId: companyId ? String(companyId) : null,
            courseId: courseId ? String(courseId) : null,
            collegeId: collegeId ? String(collegeId) : null,
            dayNumber: Number.parseInt(dayNumber, 10),
            notifyChannel: "in_app",
          });
        }

        const adminUser = await getUserByIdLoader({ userId: actorUserId || createdBy });
        if (adminUser && typeof createTrainerAdminChannelsLoader === "function") {
          await createTrainerAdminChannelsLoader(trainer.userId, [adminUser]);
        }
      }
    } catch (notifyError) {
      logScheduleAsyncTelemetry("warn", {
        correlationId: sideEffectCorrelationId,
        stage: "create_schedule_side_effect_failed",
        status: "notification",
        outcome: "failed",
        cleanupMode: "none",
        reason: notifyError?.message || "Unknown error",
        actorUserId: actorUserId || createdBy,
        trainerId: trainerId ? String(trainerId) : null,
        scheduleId: schedule?._id ? String(schedule._id) : null,
        companyId: companyId ? String(companyId) : null,
        courseId: courseId ? String(courseId) : null,
        collegeId: collegeId ? String(collegeId) : null,
        dayNumber: Number.parseInt(dayNumber, 10),
      });
    }
  })();

  return {
    responsePayload: {
      success: true,
      message: CREATE_SCHEDULE_SUCCESS_MESSAGE,
      data: schedule,
    },
    sideEffectTask,
  };
};

const bulkCreateSchedulesFeed = async ({
  payload = {},
  actorUserId = null,
  io = null,
  resolveScheduleFolderFields = async () => ({}),
  listCollegesByIdsLoader = listCollegesByIds,
  listExistingDaySlotSchedulesLoader = listExistingDaySlotSchedules,
  insertManySchedulesLoader = insertManySchedules,
  bulkWriteSchedulesLoader = bulkWriteSchedules,
  listSchedulesByIdsLoader = listSchedulesByIds,
  getTrainerByIdLoader = getTrainerByIdWithUser,
  getCollegeByIdLoader = getCollegeById,
  getCourseByIdLoader = getCourseById,
  getUserByIdLoader = getUserById,
  sendBulkScheduleEmailLoader = sendBulkScheduleEmail,
  sendInAppNotificationLoader,
  createTrainerAdminChannelsLoader = autoCreateTrainerAdminChannels,
  invalidateTrainerScheduleCachesLoader = invalidateTrainerScheduleCaches,
} = {}) => {
  const schedules = payload?.schedules;
  const createdBy = payload?.createdBy;

  if (!Array.isArray(schedules) || schedules.length === 0) {
    const error = new Error(BULK_CREATE_REQUIRED_ARRAY_MESSAGE);
    error.statusCode = 400;
    throw error;
  }

  const skippedDetails = [];
  const seenPayloadDaySlots = new Set();
  const sanitizedSchedules = [];

  schedules.forEach((schedule, index) => {
    const rowNumber = index + 1;
    const normalized = { ...(schedule || {}) };
    const requiredMissing = !normalized.trainerId
      || !normalized.collegeId
      || normalized.dayNumber === undefined
      || !normalized.scheduledDate
      || !normalized.startTime
      || !normalized.endTime;

    if (requiredMissing) {
      skippedDetails.push({
        rowNumber,
        reason: "Missing required fields (trainerId, collegeId, dayNumber, scheduledDate, startTime, endTime)",
      });
      return;
    }

    const daySlotKey = keyForDaySlot(normalized);
    if (seenPayloadDaySlots.has(daySlotKey)) {
      skippedDetails.push({
        rowNumber,
        reason: "Duplicate day assignment in request payload (same college, department, day)",
      });
      return;
    }

    seenPayloadDaySlots.add(daySlotKey);
    sanitizedSchedules.push({
      ...normalized,
      _rowNumber: rowNumber,
    });
  });

  if (!sanitizedSchedules.length) {
    return {
      statusCode: 200,
      responsePayload: {
        success: true,
        message: BULK_CREATE_EMPTY_RESULT_MESSAGE,
        inserted: 0,
        skipped: skippedDetails.length,
        skippedDetails,
        data: [],
      },
      sideEffectTask: Promise.resolve(),
    };
  }

  const collegeIds = [...new Set(sanitizedSchedules.map((schedule) => schedule.collegeId))];
  const colleges = await listCollegesByIdsLoader({ collegeIds });
  const collegeMap = colleges.reduce((accumulator, college) => {
    accumulator[String(college?._id)] = college;
    return accumulator;
  }, {});

  const existingDaySlotCandidates = await listExistingDaySlotSchedulesLoader({
    collegeIds: [...new Set(sanitizedSchedules.map((schedule) => schedule.collegeId))],
    departmentIds: [...new Set(sanitizedSchedules.map((schedule) => schedule.departmentId || null))],
    dayNumbers: [...new Set(sanitizedSchedules.map((schedule) => schedule.dayNumber))],
  });

  const existingDaySlotMap = new Map();
  existingDaySlotCandidates.forEach((schedule) => {
    const key = keyForDaySlot(schedule);
    if (!existingDaySlotMap.has(key)) {
      existingDaySlotMap.set(key, schedule);
    }
  });

  const updateOps = [];
  const updatedScheduleIds = new Set();
  const schedulesToInsert = [];
  const seenInsertKeys = new Set();

  // eslint-disable-next-line no-restricted-syntax
  for (const schedule of sanitizedSchedules) {
    const rowNumber = schedule._rowNumber || 0;
    const daySlotKey = keyForDaySlot(schedule);
    const existingDaySlot = existingDaySlotMap.get(daySlotKey);
    const { _rowNumber, ...schedulePayload } = schedule;

    let folderFields = {};
    try {
      folderFields = await resolveScheduleFolderFields({
        companyId: schedulePayload.companyId || null,
        courseId: schedulePayload.courseId || null,
        collegeId: schedulePayload.collegeId,
        departmentId: schedulePayload.departmentId || null,
        dayNumber: schedulePayload.dayNumber,
        fallbackFields: {
          ...(typeof existingDaySlot?.toObject === "function" ? existingDaySlot.toObject() : existingDaySlot),
          ...schedulePayload,
        },
      }) || {};
    } catch (driveError) {
      schedulesAsyncLogger.warn({
        correlationId: null,
        stage: "bulk_create_schedule_drive_folder_resolution_failed",
        status: "drive",
        outcome: "skipped",
        reason: driveError?.message || "Unknown drive error",
        companyId: schedulePayload.companyId ? String(schedulePayload.companyId) : null,
        courseId: schedulePayload.courseId ? String(schedulePayload.courseId) : null,
        collegeId: schedulePayload.collegeId ? String(schedulePayload.collegeId) : null,
        departmentId: schedulePayload.departmentId ? String(schedulePayload.departmentId) : null,
        dayNumber: Number.isFinite(Number(schedulePayload.dayNumber)) ? Number(schedulePayload.dayNumber) : null,
      });
    }

    if (existingDaySlot?._id) {
      updateOps.push({
        updateOne: {
          filter: { _id: existingDaySlot._id },
          update: {
            $set: {
              trainerId: schedulePayload.trainerId,
              companyId: schedulePayload.companyId || null,
              courseId: schedulePayload.courseId || null,
              collegeId: schedulePayload.collegeId,
              departmentId: schedulePayload.departmentId || null,
              dayNumber: schedulePayload.dayNumber,
              scheduledDate: schedulePayload.scheduledDate,
              startTime: schedulePayload.startTime,
              endTime: schedulePayload.endTime,
              subject: schedulePayload.subject || null,
              status: "scheduled",
              isActive: true,
              collegeLocation: collegeMap[String(schedule.collegeId)]?.location || {},
              createdBy: createdBy || actorUserId,
              ...(folderFields || {}),
            },
          },
        },
      });
      updatedScheduleIds.add(String(existingDaySlot._id));
      // eslint-disable-next-line no-continue
      continue;
    }

    const insertKey = keyForSchedule(schedulePayload);
    if (seenInsertKeys.has(insertKey)) {
      skippedDetails.push({
        rowNumber,
        reason: "Schedule already exists for this trainer/day/date/department",
      });
      // eslint-disable-next-line no-continue
      continue;
    }

    seenInsertKeys.add(insertKey);
    schedulesToInsert.push({
      ...schedulePayload,
      collegeLocation: collegeMap[String(schedule.collegeId)]?.location || {},
      createdBy: createdBy || actorUserId,
      status: "scheduled",
      ...(folderFields || {}),
    });
  }

  let createdSchedules = [];
  if (schedulesToInsert.length) {
    createdSchedules = await insertManySchedulesLoader({ schedules: schedulesToInsert });
  }

  if (updateOps.length) {
    await bulkWriteSchedulesLoader({ operations: updateOps });
  }

  let updatedSchedules = [];
  if (updatedScheduleIds.size) {
    updatedSchedules = await listSchedulesByIdsLoader({
      scheduleIds: [...updatedScheduleIds],
    });
  }

  const affectedSchedules = [...updatedSchedules, ...createdSchedules];

  const affectedTrainerIds = [...new Set(affectedSchedules.map(s => s.trainerId).filter(Boolean))];
  if (affectedTrainerIds.length && typeof invalidateTrainerScheduleCachesLoader === "function") {
    await invalidateTrainerScheduleCachesLoader(affectedTrainerIds);
  }

  const bulkCreateCorrelationId = createCorrelationId("sched_bulk_create");
  const sideEffectTask = (async () => {
    try {
      const trainerAssignments = {};

      // eslint-disable-next-line no-restricted-syntax
      for (const schedule of affectedSchedules) {
        if (!schedule?.trainerId) {
          // eslint-disable-next-line no-continue
          continue;
        }

        const trainerKey = schedule.trainerId.toString();
        if (!trainerAssignments[trainerKey]) trainerAssignments[trainerKey] = [];

        const college = await getCollegeByIdLoader({ collegeId: schedule.collegeId });
        const course = await getCourseByIdLoader({ courseId: schedule.courseId });
        const mapLink = college?.location?.mapUrl || (
          college?.location?.lat && college?.location?.lng
            ? `https://www.google.com/maps?q=${college.location.lat},${college.location.lng}`
            : ""
        );

        trainerAssignments[trainerKey].push({
          date: dayjs(schedule.scheduledDate).format("DD-MM-YYYY"),
          day: schedule.dayNumber ? `Day ${schedule.dayNumber}` : dayjs(schedule.scheduledDate).format("dddd"),
          college: college?.name || "Assigned College",
          course: course?.title || "Assigned Course",
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          location: college?.location?.address || "",
          mapLink,
          spocName: college?.principalName || "N/A",
          spocPhone: college?.phone || "",
        });
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const trainerKey in trainerAssignments) {
        const trainer = await getTrainerByIdLoader({ trainerId: trainerKey });
        if (trainer && trainer.userId && trainer.userId.email) {
          const assignments = trainerAssignments[trainerKey];
          if (typeof sendBulkScheduleEmailLoader === "function") {
            await sendBulkScheduleEmailLoader(
              trainer.userId.email,
              trainer.name || trainer.userId.name,
              assignments,
            );
          }

          try {
            if (typeof sendInAppNotificationLoader === "function") {
              await sendInAppNotificationLoader(io, {
                userId: trainer.userId._id,
                role: "Trainer",
                title: "Training Assigned",
                message: `Training Assigned - ${assignments.length} Sessions. Check your portal for details.`,
                type: "Schedule",
                link: "/trainer/schedule",
              });
            }
          } catch (error) {
            logScheduleAsyncTelemetry("warn", {
              correlationId: bulkCreateCorrelationId,
              stage: "bulk_create_in_app_notification_failed",
              status: "notification",
              outcome: "failed",
              cleanupMode: "none",
              reason: error?.message || "Unknown error",
              actorUserId: actorUserId,
              trainerId: trainer?.userId?._id ? String(trainer.userId._id) : null,
              notifyChannel: "in_app",
            });
          }
        }
      }

      try {
        const actingAdminId = actorUserId || (affectedSchedules[0]?.createdBy);
        const adminUser = actingAdminId ? await getUserByIdLoader({ userId: actingAdminId }) : null;
        if (adminUser) {
          const uniqueTrainerIds = Object.keys(trainerAssignments);
          // eslint-disable-next-line no-restricted-syntax
          for (const trainerKey of uniqueTrainerIds) {
            const trainer = await getTrainerByIdLoader({ trainerId: trainerKey });
            if (trainer && trainer.userId && typeof createTrainerAdminChannelsLoader === "function") {
              await createTrainerAdminChannelsLoader(trainer.userId, [adminUser]);
            }
          }
        }
      } catch (chatError) {
        logScheduleAsyncTelemetry("warn", {
          correlationId: bulkCreateCorrelationId,
          stage: "bulk_create_chat_channel_setup_failed",
          status: "chat_setup",
          outcome: "failed",
          cleanupMode: "none",
          reason: chatError?.message || "Unknown error",
          actorUserId: actorUserId,
          notifyChannel: "chat",
        });
      }
    } catch (notifyError) {
      logScheduleAsyncTelemetry("warn", {
        correlationId: bulkCreateCorrelationId,
        stage: "bulk_create_side_effect_failed",
        status: "notification",
        outcome: "failed",
        cleanupMode: "none",
        reason: notifyError?.message || "Unknown error",
        actorUserId: actorUserId,
      });
    }
  })();

  return {
    statusCode: 200,
    responsePayload: {
      success: true,
      message: `${createdSchedules.length} schedules created, ${updatedSchedules.length} schedules updated`,
      inserted: createdSchedules.length,
      updated: updatedSchedules.length,
      skipped: skippedDetails.length,
      skippedDetails,
      data: affectedSchedules,
    },
    sideEffectTask,
  };
};

const bulkUploadSchedulesFeed = async ({
  payload = {},
  actorUserId = null,
  actorUserName = null,
  resolveScheduleFolderFields = async () => ({}),
  readWorkbookLoader = (filePath) => xlsx.readFile(filePath),
  sheetToRowsLoader = (sheet) => xlsx.utils.sheet_to_json(sheet),
  fileExistsLoader = (filePath) => fs.existsSync(filePath),
  deleteFileLoader = (filePath) => fs.unlinkSync(filePath),
  findCompanyByNameLoader = findCompanyByNameCaseInsensitive,
  createCompanyLoader = createCompanyDocument,
  saveCompanyLoader = saveCompanyDocument,
  ensureCompanyHierarchyLoader = ensureCompanyHierarchy,
  isTrainingDriveEnabledLoader = isTrainingDriveEnabled,
  findCourseByTitleAndCompanyLoader = findCourseByTitleAndCompany,
  createCourseLoader = createCourseDocument,
  findCollegeByNameAndCourseLoader = findCollegeByNameAndCourse,
  createCollegeLoader = createCollegeDocument,
  findTrainerByCustomIdLoader = findTrainerByCustomIdWithUser,
  createUserLoader = createUserDocument,
  createTrainerLoader = createTrainerDocument,
  findApprovedAttendanceByCollegeAndDateRangeLoader = findApprovedAttendanceByCollegeAndDateRange,
  findScheduleByCollegeCourseAndDateRangeLoader = findScheduleByCollegeCourseAndDateRange,
  findLastScheduleByCollegeLoader = findLastScheduleByCollege,
  createScheduleInstanceLoader = createScheduleInstance,
  saveScheduleLoader = saveScheduleDocument,
  invalidateTrainerScheduleCachesLoader = invalidateTrainerScheduleCaches,
  createNotificationLoader = createNotificationDocument,
  createActivityLogLoader = createActivityLogDocument,
  sendBulkScheduleEmailLoader = sendBulkScheduleEmail,
  notifyTrainerScheduleLoader = notifyTrainerSchedule,
} = {}) => {
  const file = payload?.file || null;
  const user = payload?.user || null;
  const effectiveActorUserId = actorUserId || user?.id || user?._id || null;
  const effectiveActorUserName = actorUserName || user?.name || "SPOC Admin";
  const bulkUploadCorrelationId = createCorrelationId("sched_bulk_upload");

  const cleanupFile = () => {
    const filePath = file?.path;
    if (!filePath) return;
    try {
      if (fileExistsLoader(filePath)) deleteFileLoader(filePath);
    } catch (_error) {}
  };

  try {
    if (!file) {
      const error = new Error(BULK_UPLOAD_NO_FILE_MESSAGE);
      error.statusCode = 400;
      throw error;
    }

    const workbook = readWorkbookLoader(file.path);
    const sheet = workbook?.Sheets?.Schedule;

    if (!sheet) {
      cleanupFile();
      const error = new Error(BULK_UPLOAD_SHEET_NAME_MESSAGE);
      error.statusCode = 400;
      throw error;
    }

    const rows = sheetToRowsLoader(sheet);
    const schedulesToInsert = [];
    const skipped = [];
    const trainerAssignments = {};

    const trainersCache = {};
    const companiesCache = {};
    const coursesCache = {};
    const collegesCache = {};

    // eslint-disable-next-line no-plusplus
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowNum = index + 2;

      try {
        const companyName = getCaseInsensitiveCellValue(row, "Company")?.toString().trim();
        const courseTitle = getCaseInsensitiveCellValue(row, "Course")?.toString().trim();
        const collegeName = getCaseInsensitiveCellValue(row, "College")?.toString().trim();
        const trainerCustomId = getCaseInsensitiveCellValue(row, "TrainerID")?.toString().trim();
        const dateVal = getCaseInsensitiveCellValue(row, "Date");
        const dayName = getCaseInsensitiveCellValue(row, "Day")?.toString().trim();
        const startTime = getCaseInsensitiveCellValue(row, "StartTime")?.toString().trim() || "09:00";
        const endTime = getCaseInsensitiveCellValue(row, "EndTime")?.toString().trim() || "17:00";

        if (!trainerCustomId || !dateVal || !collegeName) {
          throw new Error(`Missing required fields in Row ${rowNum}. Found Columns: ${Object.keys(row).join(", ")}`);
        }

        if (startTime >= endTime) {
          throw new Error(`Invalid Time: Start Time (${startTime}) must be before End Time (${endTime})`);
        }

        if (!companiesCache[companyName]) {
          let company = await findCompanyByNameLoader({ companyName });

          if (!company && companyName.toLowerCase().startsWith("test")) {
            company = await createCompanyLoader({
              payload: {
                name: companyName,
                registrationNumber: `TEST-${Date.now()}`,
                address: "Test Address",
              },
            });

            if (typeof isTrainingDriveEnabledLoader === "function" && isTrainingDriveEnabledLoader()) {
              try {
                const hierarchy = await ensureCompanyHierarchyLoader({ company });
                if (hierarchy?.companyFolder?.id) {
                  company.driveFolderId = hierarchy.companyFolder.id;
                  company.driveFolderName = hierarchy.companyFolder.name;
                  company.driveFolderLink = hierarchy.companyFolder.link;
                  await saveCompanyLoader({ company });
                }
              } catch (driveError) {
                logScheduleAsyncTelemetry("warn", {
                  correlationId: bulkUploadCorrelationId,
                  stage: "bulk_upload_company_drive_folder_create_failed",
                  status: "drive_setup",
                  outcome: "failed",
                  cleanupMode: "none",
                  reason: driveError?.message || "Unknown error",
                  actorUserId: effectiveActorUserId,
                  companyId: company?._id ? String(company._id) : null,
                  notifyChannel: "drive",
                });
              }
            }
          }

          if (!company) throw new Error(`Company "${companyName}" not found. Please match an existing company or use "TEST".`);
          companiesCache[companyName] = company._id;
        }

        if (!coursesCache[courseTitle]) {
          let course = await findCourseByTitleAndCompanyLoader({
            courseTitle,
            companyId: companiesCache[companyName],
          });

          if (!course && courseTitle.toLowerCase().startsWith("test")) {
            course = await createCourseLoader({
              payload: {
                title: courseTitle,
                companyId: companiesCache[companyName],
                duration: 1,
              },
            });
          }

          if (!course) throw new Error(`Course "${courseTitle}" not found for this company.`);
          coursesCache[courseTitle] = course._id;
        }

        if (!collegesCache[collegeName]) {
          let college = await findCollegeByNameAndCourseLoader({
            collegeName,
            courseId: coursesCache[courseTitle],
          });

          if (!college && collegeName.toLowerCase().startsWith("test")) {
            college = await createCollegeLoader({
              payload: {
                name: collegeName,
                companyId: companiesCache[companyName],
                courseId: coursesCache[courseTitle],
                location: "Test Location",
              },
            });
          }

          if (!college) throw new Error(`College "${collegeName}" not found for this course.`);
          collegesCache[collegeName] = college;
        }

        if (!trainersCache[trainerCustomId]) {
          let trainer = await findTrainerByCustomIdLoader({ trainerCustomId });

          if (!trainer && trainerCustomId.toLowerCase().startsWith("test")) {
            const email = `test.trainer.${Date.now()}@example.com`;
            const testUser = await createUserLoader({
              payload: {
                name: trainerCustomId,
                email,
                password: "password123",
                role: "trainer",
                isVerified: true,
              },
            });
            trainer = await createTrainerLoader({
              payload: {
                trainerId: trainerCustomId,
                userId: testUser._id,
                name: trainerCustomId,
              },
            });
            trainer.userId = testUser;
          }

          if (!trainer) throw new Error(`Trainer ${trainerCustomId} not found.`);
          trainersCache[trainerCustomId] = trainer;
        }

        let parsedDate;
        if (typeof dateVal === "number") {
          parsedDate = new Date(Math.round((dateVal - 25569) * 86400 * 1000));
        } else {
          parsedDate = new Date(dateVal);
        }
        const formattedDate = dayjs(parsedDate).format("YYYY-MM-DD");
        if (formattedDate === "Invalid Date") throw new Error(`Invalid Date: ${dateVal}`);

        const startDate = dayjs(formattedDate).startOf("day").toDate();
        const endDate = dayjs(formattedDate).endOf("day").toDate();

        const existingAttendance = await findApprovedAttendanceByCollegeAndDateRangeLoader({
          collegeId: collegesCache[collegeName]._id,
          startDate,
          endDate,
        });
        if (existingAttendance) {
          throw new Error("Attendance Lock: An approved attendance record already exists for this date. Schedule cannot be modified.");
        }

        let schedule = await findScheduleByCollegeCourseAndDateRangeLoader({
          collegeId: collegesCache[collegeName]._id,
          courseId: coursesCache[courseTitle],
          startDate,
          endDate,
        });

        if (!schedule) {
          const lastSchedule = await findLastScheduleByCollegeLoader({
            collegeId: collegesCache[collegeName]._id,
          });
          const nextDay = (lastSchedule?.dayNumber || 0) + 1;
          schedule = await createScheduleInstanceLoader({
            payload: {
              collegeId: collegesCache[collegeName]._id,
              courseId: coursesCache[courseTitle],
              companyId: companiesCache[companyName],
              dayNumber: nextDay,
              scheduledDate: dayjs(formattedDate).toDate(),
              source: "excel",
            },
          });
        }

        schedule.trainerId = trainersCache[trainerCustomId]._id;
        schedule.startTime = startTime;
        schedule.endTime = endTime;

        const validDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
        if (dayName && validDays.includes(dayName)) {
          schedule.dayOfWeek = dayName;
        } else {
          schedule.dayOfWeek = dayjs(formattedDate).format("dddd");
        }

        schedule.createdBy = effectiveActorUserId;
        schedule.status = "scheduled";
        schedule.collegeLocation = collegesCache[collegeName].location;
        const fallbackFields = typeof schedule.toObject === "function" ? schedule.toObject() : { ...schedule };
        const folderFields = await resolveScheduleFolderFields({
          companyId: schedule.companyId || null,
          courseId: schedule.courseId || null,
          collegeId: schedule.collegeId,
          departmentId: schedule.departmentId || null,
          dayNumber: schedule.dayNumber,
          fallbackFields,
        });
        Object.assign(schedule, folderFields || {});

        await saveScheduleLoader({ schedule });

        if (!trainerAssignments[trainerCustomId]) trainerAssignments[trainerCustomId] = [];
        trainerAssignments[trainerCustomId].push({
          date: formattedDate,
          day: schedule.dayOfWeek,
          college: collegeName,
          course: courseTitle,
          startTime,
          endTime,
          spocName: collegesCache[collegeName].principalName || "N/A",
          spocPhone: collegesCache[collegeName].phone || "N/A",
        });

        schedulesToInsert.push(schedule);
      } catch (error) {
        skipped.push({ rowNumber: rowNum, reason: error.message });
      }
    }

    await invalidateTrainerScheduleCachesLoader(
      schedulesToInsert.map((schedule) => schedule?.trainerId),
    );

    if (schedulesToInsert.length > 0) {
      // eslint-disable-next-line no-restricted-syntax
      for (const trainerKey in trainerAssignments) {
        const trainer = trainersCache[trainerKey];
        const assignments = trainerAssignments[trainerKey];

        if (trainer.userId) {
          await createNotificationLoader({
            payload: {
              userId: trainer.userId._id,
              title: "New Schedules Assigned",
              message: `You have been assigned ${assignments.length} new training sessions. Check your dashboard for details.`,
              type: "info",
              link: "/trainer/schedule",
            },
          });

          if (trainer.userId.email && typeof sendBulkScheduleEmailLoader === "function") {
            sendBulkScheduleEmailLoader(
              trainer.userId.email,
              trainer.name || trainer.userId.name,
              assignments,
            ).catch((error) => {
              logScheduleAsyncTelemetry("warn", {
                correlationId: bulkUploadCorrelationId,
                stage: "bulk_upload_email_failed",
                status: "notification",
                outcome: "failed",
                cleanupMode: "none",
                reason: error?.message || "Unknown error",
                actorUserId: effectiveActorUserId,
                trainerId: trainer?.userId?._id ? String(trainer.userId._id) : null,
                notifyChannel: "email",
              });
            });
          }
        }

        if (typeof notifyTrainerScheduleLoader === "function") {
          notifyTrainerScheduleLoader(
            trainer,
            { name: assignments[0]?.college },
            assignments,
          ).catch((error) => {
            logScheduleAsyncTelemetry("warn", {
              correlationId: bulkUploadCorrelationId,
              stage: "bulk_upload_sms_whatsapp_failed",
              status: "notification",
              outcome: "failed",
              cleanupMode: "none",
              reason: error?.message || "Unknown error",
              actorUserId: effectiveActorUserId,
              trainerId: trainer?._id ? String(trainer._id) : null,
              notifyChannel: "sms_whatsapp",
            });
          });
        }
      }

      await createNotificationLoader({
        payload: {
          userId: effectiveActorUserId,
          title: "Bulk Schedule Uploaded",
          message: `Successfully uploaded ${schedulesToInsert.length} schedules. ${skipped.length} rows were skipped.`,
          type: "success",
          link: "/spoc/schedule",
        },
      });

      await createActivityLogLoader({
        payload: {
          userId: effectiveActorUserId,
          userName: effectiveActorUserName,
          role: "SPOCAdmin",
          action: "BULK_SCHEDULE_UPLOAD",
          entityType: "Schedule",
          details: {
            successCount: schedulesToInsert.length,
            skippedCount: skipped.length,
            fileName: file.originalname,
          },
        },
      });
    }

    cleanupFile();

    return {
      statusCode: 200,
      responsePayload: {
        success: true,
        inserted: schedulesToInsert.length,
        skipped: skipped.length,
        skippedDetails: skipped,
        data: {
          success: schedulesToInsert.length,
          failed: skipped.length,
          errors: skipped.map((item) => `Row ${item.rowNumber}: ${item.reason}`),
        },
      },
    };
  } catch (error) {
    cleanupFile();
    throw error;
  }
};

const createScheduleNotFoundError = () => {
  const error = new Error(ASSIGN_SCHEDULE_NOT_FOUND_MESSAGE);
  error.statusCode = 404;
  return error;
};

const assignScheduleFeed = async ({
  scheduleId,
  payload = {},
  actorUserId = null,
  io = null,
  resolveScheduleFolderFields = async () => ({}),
  listScheduleById = getScheduleByIdForUpdate,
  saveScheduleLoader = saveScheduleDocument,
  getTrainerByIdLoader = getTrainerByIdWithUser,
  getCollegeByIdLoader = getCollegeById,
  getCourseByIdLoader = getCourseById,
  getUserByIdLoader = getUserById,
  sendScheduleChangeEmailLoader = sendScheduleChangeEmail,
  sendInAppNotificationLoader,
  createTrainerAdminChannelsLoader = autoCreateTrainerAdminChannels,
  invalidateTrainerScheduleCachesLoader = invalidateTrainerScheduleCaches,
} = {}) => {
  const { trainerId, scheduledDate, startTime, endTime } = payload;
  const schedule = await listScheduleById({ scheduleId });
  const previousTrainerId = schedule?.trainerId ? String(schedule.trainerId) : null;
  const assignCorrelationId = createCorrelationId("sched_assign");

  if (!schedule) {
    throw createScheduleNotFoundError();
  }

  schedule.trainerId = trainerId;
  schedule.scheduledDate = scheduledDate;
  schedule.startTime = startTime || schedule.startTime;
  schedule.endTime = endTime || schedule.endTime;
  schedule.status = "scheduled";

  const folderFields = await resolveScheduleFolderFields({
    companyId: schedule.companyId || null,
    courseId: schedule.courseId || null,
    collegeId: schedule.collegeId,
    departmentId: schedule.departmentId || null,
    dayNumber: schedule.dayNumber,
    fallbackFields: typeof schedule.toObject === "function" ? schedule.toObject() : schedule,
  });
  Object.assign(schedule, folderFields || {});

  const updatedSchedule = await saveScheduleLoader({ schedule });

  try {
    const trainer = await getTrainerByIdLoader({ trainerId });
    if (trainer && trainer.userId && trainer.userId.email) {
      const college = await getCollegeByIdLoader({ collegeId: schedule.collegeId });
      const course = await getCourseByIdLoader({ courseId: schedule.courseId });
      const spocName = college?.principalName || "N/A";
      const spocPhone = college?.phone || "";

      const mapLink = college?.location?.mapUrl || (
        college?.location?.lat && college?.location?.lng
          ? `https://www.google.com/maps?q=${college.location.lat},${college.location.lng}`
          : ""
      );

      if (typeof sendScheduleChangeEmailLoader === "function") {
        await sendScheduleChangeEmailLoader(
          trainer.userId.email,
          trainer.name || trainer.userId.name,
          {
            date: dayjs(scheduledDate).format("DD-MM-YYYY"),
            day: schedule.dayNumber ? `Day ${schedule.dayNumber}` : dayjs(scheduledDate).format("dddd"),
            college: college?.name || "Assigned College",
            course: course?.title || "Assigned Course",
            startTime: startTime || schedule.startTime,
            endTime: endTime || schedule.endTime,
            location: college?.location?.address || "",
            mapLink,
            spocName,
            spocPhone,
          },
          "assignment",
          "Training has been assigned.",
        );
      }

      try {
        if (typeof sendInAppNotificationLoader === "function") {
          await sendInAppNotificationLoader(io, {
            userId: trainer.userId._id,
            role: "Trainer",
            title: "Training Assigned",
            message: `Training Assigned - ${course?.title || "TEST COURSE"} (${schedule.dayNumber ? `Day ${schedule.dayNumber}` : "Day 1"}). ${college?.name} on ${dayjs(scheduledDate).format("DD-MM-YYYY")} (${startTime || schedule.startTime} - ${endTime || schedule.endTime}). CoNDAct SPOC: ${spocName} (${spocPhone})`,
            type: "Schedule",
            link: "/trainer/schedule",
          });
        }
      } catch (error) {
        logScheduleAsyncTelemetry("warn", {
          correlationId: assignCorrelationId,
          stage: "assign_schedule_in_app_notification_failed",
          status: "notification",
          outcome: "failed",
          cleanupMode: "none",
          reason: error?.message || "Unknown error",
          actorUserId: actorUserId,
          trainerId: trainer?.userId?._id ? String(trainer.userId._id) : null,
          scheduleId: updatedSchedule?._id ? String(updatedSchedule._id) : String(scheduleId),
          notifyChannel: "in_app",
        });
      }

      const adminUser = await getUserByIdLoader({ userId: actorUserId });
      if (adminUser && typeof createTrainerAdminChannelsLoader === "function") {
        await createTrainerAdminChannelsLoader(trainer.userId, [adminUser]);
      }
    }
  } catch (notifyError) {
    logScheduleAsyncTelemetry("warn", {
      correlationId: assignCorrelationId,
      stage: "assign_schedule_side_effect_failed",
      status: "notification",
      outcome: "failed",
      cleanupMode: "none",
      reason: notifyError?.message || "Unknown error",
      actorUserId: actorUserId,
      trainerId: trainerId ? String(trainerId) : null,
      scheduleId: updatedSchedule?._id ? String(updatedSchedule._id) : String(scheduleId),
    });
  }

  if (typeof invalidateTrainerScheduleCachesLoader === "function") {
    await invalidateTrainerScheduleCachesLoader([previousTrainerId, updatedSchedule?.trainerId]);
  }

  return {
    success: true,
    message: ASSIGN_SCHEDULE_SUCCESS_MESSAGE,
    data: updatedSchedule,
  };
};

const createUpdateScheduleNotFoundError = () => {
  const error = new Error(UPDATE_SCHEDULE_NOT_FOUND_MESSAGE);
  error.statusCode = 404;
  return error;
};

const updateScheduleFeed = async ({
  scheduleId,
  payload = {},
  io = null,
  resolveScheduleFolderFields = async () => ({}),
  listScheduleById = getScheduleByIdForAssignment,
  saveScheduleLoader = saveScheduleDocument,
  getTrainerByIdLoader = getTrainerByIdWithUser,
  getCollegeByIdLoader = getCollegeById,
  getCourseByIdLoader = getCourseById,
  sendScheduleChangeEmailLoader = sendScheduleChangeEmail,
  sendInAppNotificationLoader,
  invalidateTrainerScheduleCachesLoader = invalidateTrainerScheduleCaches,
} = {}) => {
  const schedule = await listScheduleById({ scheduleId });
  const previousTrainerId = schedule?.trainerId ? String(schedule.trainerId) : null;
  const updateCorrelationId = createCorrelationId("sched_update");

  if (!schedule) {
    throw createUpdateScheduleNotFoundError();
  }

  if (payload?.trainerId !== undefined) schedule.trainerId = payload.trainerId;
  if (payload?.scheduledDate !== undefined) schedule.scheduledDate = payload.scheduledDate;
  if (payload?.startTime !== undefined) schedule.startTime = payload.startTime;
  if (payload?.endTime !== undefined) schedule.endTime = payload.endTime;
  if (payload?.status !== undefined) schedule.status = payload.status;
  if (payload?.subject !== undefined) schedule.subject = payload.subject;
  if (payload?.dayNumber !== undefined) schedule.dayNumber = payload.dayNumber;
  if (payload?.departmentId !== undefined) schedule.departmentId = payload.departmentId || null;
  if (payload?.collegeId !== undefined) schedule.collegeId = payload.collegeId;
  if (payload?.companyId !== undefined) schedule.companyId = payload.companyId || null;
  if (payload?.courseId !== undefined) schedule.courseId = payload.courseId || null;
  if (payload?.attendanceUploaded !== undefined) {
    schedule.attendanceUploaded = Boolean(payload.attendanceUploaded);
  }
  if (payload?.geoTagUploaded !== undefined) {
    schedule.geoTagUploaded = Boolean(payload.geoTagUploaded);
  }
  if (payload?.dayStatus !== undefined) schedule.dayStatus = payload.dayStatus;

  const safeBody = { ...payload };
  [
    "driveFolderId", "driveFolderName", "driveFolderLink",
    "dayFolderId", "dayFolderName", "dayFolderLink",
    "attendanceFolderId", "attendanceFolderName", "attendanceFolderLink",
    "geoTagFolderId", "geoTagFolderName", "geoTagFolderLink",
    "attendanceUploaded", "geoTagUploaded", "dayStatus", "dayStatusUpdatedAt",
  ].forEach((field) => delete safeBody[field]);
  Object.assign(schedule, safeBody);

  const folderFields = await resolveScheduleFolderFields({
    companyId: schedule.companyId || null,
    courseId: schedule.courseId || null,
    collegeId: schedule.collegeId,
    departmentId: schedule.departmentId || null,
    dayNumber: schedule.dayNumber,
    fallbackFields: typeof schedule.toObject === "function" ? schedule.toObject() : schedule,
  });
  Object.assign(schedule, folderFields || {});
  const reason = payload?.rescheduleReason || "General schedule update by administrator.";

  const updatedSchedule = await saveScheduleLoader({ schedule });

  if (updatedSchedule?.trainerId) {
    try {
      const trainer = await getTrainerByIdLoader({ trainerId: updatedSchedule.trainerId });
      if (trainer && trainer.userId && trainer.userId.email) {
        const college = await getCollegeByIdLoader({ collegeId: updatedSchedule.collegeId });
        const course = await getCourseByIdLoader({ courseId: updatedSchedule.courseId });

        const spocName = college?.principalName || "N/A";
        const spocPhone = college?.phone || "";
        const mapLink = college?.location?.mapUrl || (
          college?.location?.lat && college?.location?.lng
            ? `https://www.google.com/maps?q=${college.location.lat},${college.location.lng}`
            : ""
        );

        const oldDateFormatted = schedule?.scheduledDate
          ? dayjs(schedule.scheduledDate).format("DD-MM-YYYY")
          : null;
        const newDateFormatted = updatedSchedule?.scheduledDate
          ? dayjs(new Date(updatedSchedule.scheduledDate)).format("DD-MM-YYYY")
          : "N/A";

        if (newDateFormatted === "Invalid Date") {
          logScheduleAsyncTelemetry("error", {
            correlationId: updateCorrelationId,
            stage: "update_schedule_email_invalid_date",
            status: "notification",
            outcome: "failed",
            cleanupMode: "none",
            reason: `Invalid scheduledDate: ${updatedSchedule?.scheduledDate || "unknown"}`,
            trainerId: trainer?.userId?._id ? String(trainer.userId._id) : null,
            scheduleId: updatedSchedule?._id ? String(updatedSchedule._id) : String(scheduleId),
            notifyChannel: "email",
          });
        }

        if (typeof sendScheduleChangeEmailLoader === "function") {
          await sendScheduleChangeEmailLoader(
            trainer.userId.email,
            trainer.name || trainer.userId.name,
            {
              date: newDateFormatted,
              oldDate: oldDateFormatted !== newDateFormatted ? oldDateFormatted : null,
              day: updatedSchedule.dayNumber
                ? `Day ${updatedSchedule.dayNumber}`
                : dayjs(updatedSchedule.scheduledDate).format("dddd"),
              college: college?.name || "Assigned College",
              course: course?.title || "Assigned Course",
              startTime: updatedSchedule.startTime,
              endTime: updatedSchedule.endTime,
              location: college?.location?.address || "",
              mapLink,
              spocName,
              spocPhone,
            },
            "reschedule",
            reason,
          );
        }

        try {
          if (typeof sendInAppNotificationLoader === "function") {
            await sendInAppNotificationLoader(io, {
              userId: trainer.userId._id,
              role: "Trainer",
              title: "Training Rescheduled",
              message: `Training Rescheduled - ${course?.title || "TEST COURSE"} (${updatedSchedule.dayNumber ? `Day ${updatedSchedule.dayNumber}` : "Day 1"}). New Date: ${newDateFormatted} (${updatedSchedule.startTime} - ${updatedSchedule.endTime}). CoNDAct SPOC: ${spocName} (${spocPhone})`,
              type: "Schedule",
              link: "/trainer/schedule",
            });
          }
        } catch (error) {
          logScheduleAsyncTelemetry("warn", {
            correlationId: updateCorrelationId,
            stage: "update_schedule_in_app_notification_failed",
            status: "notification",
            outcome: "failed",
            cleanupMode: "none",
            reason: error?.message || "Unknown error",
            trainerId: trainer?.userId?._id ? String(trainer.userId._id) : null,
            scheduleId: updatedSchedule?._id ? String(updatedSchedule._id) : String(scheduleId),
            notifyChannel: "in_app",
          });
        }
      }
    } catch (notifyError) {
      logScheduleAsyncTelemetry("warn", {
        correlationId: updateCorrelationId,
        stage: "update_schedule_side_effect_failed",
        status: "notification",
        outcome: "failed",
        cleanupMode: "none",
        reason: notifyError?.message || "Unknown error",
        trainerId: updatedSchedule?.trainerId ? String(updatedSchedule.trainerId) : null,
        scheduleId: updatedSchedule?._id ? String(updatedSchedule._id) : String(scheduleId),
      });
    }
  }

  if (typeof invalidateTrainerScheduleCachesLoader === "function") {
    await invalidateTrainerScheduleCachesLoader([previousTrainerId, updatedSchedule?.trainerId]);
  }

  return {
    success: true,
    message: UPDATE_SCHEDULE_SUCCESS_MESSAGE,
    data: updatedSchedule,
  };
};

const createDeleteScheduleNotFoundError = () => {
  const error = new Error(DELETE_SCHEDULE_NOT_FOUND_MESSAGE);
  error.statusCode = 404;
  return error;
};

const deleteScheduleFeed = async ({
  scheduleId,
  payload = {},
  io = null,
  listScheduleById = getScheduleByIdForDelete,
  deleteScheduleLoader = deleteScheduleDocument,
  getTrainerByIdLoader = getTrainerByIdWithUser,
  getCollegeByIdLoader = getCollegeById,
  getCourseByIdLoader = getCourseById,
  sendScheduleChangeEmailLoader = sendScheduleChangeEmail,
  sendInAppNotificationLoader,
  invalidateTrainerScheduleCachesLoader = invalidateTrainerScheduleCaches,
  updateAttendanceStatusLoader = updateAttendanceStatusByScheduleId,
} = {}) => {
  const schedule = await listScheduleById({ scheduleId });
  const deleteCorrelationId = createCorrelationId("sched_delete");

  if (!schedule) {
    throw createDeleteScheduleNotFoundError();
  }

  const deletedTrainerId = schedule?.trainerId ? String(schedule.trainerId) : null;

  const reason = payload?.reason || DELETE_SCHEDULE_DEFAULT_REASON;

  if (schedule.trainerId) {
    try {
      const trainer = await getTrainerByIdLoader({ trainerId: schedule.trainerId });
      if (trainer && trainer.userId && trainer.userId.email) {
        const college = await getCollegeByIdLoader({ collegeId: schedule.collegeId });
        const course = await getCourseByIdLoader({ courseId: schedule.courseId });

        const spocName = college?.principalName || "N/A";
        const spocPhone = college?.phone || "";

        if (typeof sendScheduleChangeEmailLoader === "function") {
          await sendScheduleChangeEmailLoader(
            trainer.userId.email,
            trainer.name || trainer.userId.name,
            {
              date: dayjs(schedule.scheduledDate).format("DD-MM-YYYY"),
              day: schedule.dayNumber
                ? `Day ${schedule.dayNumber}`
                : dayjs(schedule.scheduledDate).format("dddd"),
              college: college?.name || "Assigned College",
              course: course?.title || "Assigned Course",
              startTime: schedule.startTime,
              endTime: schedule.endTime,
              spocName,
              spocPhone,
            },
            "cancellation",
            reason,
          );
        }

        try {
          if (typeof sendInAppNotificationLoader === "function") {
            await sendInAppNotificationLoader(io, {
              userId: trainer.userId._id,
              role: "Trainer",
              title: "Training Cancelled",
              message: `Training Cancelled - ${course?.title || "TEST COURSE"}. ${college?.name} on ${dayjs(schedule.scheduledDate).format("DD-MM-YYYY")}. Reason: ${reason}. CoNDAct SPOC: ${spocName} (${spocPhone})`,
              type: "Schedule",
              link: "/trainer/schedule",
            });
          }
        } catch (error) {
          logScheduleAsyncTelemetry("warn", {
            correlationId: deleteCorrelationId,
            stage: "delete_schedule_in_app_notification_failed",
            status: "notification",
            outcome: "failed",
            cleanupMode: "none",
            reason: error?.message || "Unknown error",
            trainerId: trainer?.userId?._id ? String(trainer.userId._id) : null,
            scheduleId: schedule?._id ? String(schedule._id) : String(scheduleId),
            notifyChannel: "in_app",
          });
        }
      }
    } catch (notifyError) {
      logScheduleAsyncTelemetry("warn", {
        correlationId: deleteCorrelationId,
        stage: "delete_schedule_side_effect_failed",
        status: "notification",
        outcome: "failed",
        cleanupMode: "none",
        reason: notifyError?.message || "Unknown error",
        trainerId: schedule?.trainerId ? String(schedule.trainerId) : null,
        scheduleId: schedule?._id ? String(schedule._id) : String(scheduleId),
      });
    }
  }

  await deleteScheduleLoader({ schedule });

  if (typeof updateAttendanceStatusLoader === "function") {
    await updateAttendanceStatusLoader({ scheduleId, status: "cancelled" });
  }

  if (typeof invalidateTrainerScheduleCachesLoader === "function") {
    await invalidateTrainerScheduleCachesLoader([deletedTrainerId]);
  }

  return {
    success: true,
    message: DELETE_SCHEDULE_SUCCESS_MESSAGE,
  };
};

const normalizeDepartmentName = (value) => String(value || "").trim().toLowerCase();

const isDuplicateDepartmentInsertError = (error) =>
  error?.code === 11000 || error?.name === "BulkWriteError";

const mapAssociationsPayload = ({
  companiesRaw = [],
  coursesRaw = [],
  collegesRaw = [],
  departmentsRaw = [],
} = {}) => ({
  companies: companiesRaw.map((company) => ({
    id: company._id,
    name: company.name,
  })),
  courses: coursesRaw.map((course) => ({
    id: course._id,
    name: course.title,
    companyId: course.companyId,
  })),
  colleges: collegesRaw.map((college) => ({
    id: college._id,
    name: college.name,
    companyId: college.companyId,
    courseId: college.courseId,
  })),
  departments: departmentsRaw.map((department) => ({
    id: department._id,
    name: department.name,
    companyId: department.companyId,
    courseId: department.courseId,
    collegeId: department.collegeId,
  })),
});

const buildMissingDepartmentsFromColleges = ({
  collegesRaw = [],
  departmentsRaw = [],
} = {}) => {
  const existingDepartmentKeys = new Set(
    departmentsRaw.map(
      (department) =>
        `${String(department?.collegeId || "")}::${normalizeDepartmentName(department?.name)}`,
    ),
  );

  const departmentsToInsert = [];
  collegesRaw.forEach((college) => {
    const departmentNames = parseDepartments(college?.department);
    departmentNames.forEach((departmentName) => {
      const key = `${String(college?._id || "")}::${normalizeDepartmentName(departmentName)}`;
      if (!key || existingDepartmentKeys.has(key)) return;
      existingDepartmentKeys.add(key);

      departmentsToInsert.push({
        name: departmentName,
        companyId: college?.companyId || null,
        courseId: college?.courseId || null,
        collegeId: college?._id || null,
        isActive: true,
      });
    });
  });

  return departmentsToInsert;
};

const listScheduleAssociationsFeed = async ({
  listCompanies = listAssociationsCompanies,
  listCourses = listAssociationsCourses,
  listColleges = listAssociationsColleges,
  listDepartments = listAssociationsDepartments,
  insertDepartments = insertAssociationsDepartments,
} = {}) => {
  const companiesRaw = await listCompanies();
  const coursesRaw = await listCourses();
  const collegesRaw = await listColleges();
  let departmentsRaw = await listDepartments();

  const departmentsToInsert = buildMissingDepartmentsFromColleges({
    collegesRaw,
    departmentsRaw,
  });

  if (departmentsToInsert.length) {
    try {
      await insertDepartments({ departments: departmentsToInsert });
    } catch (error) {
      if (!isDuplicateDepartmentInsertError(error)) {
        throw error;
      }
    }

    departmentsRaw = await listDepartments();
  }

  return {
    success: true,
    data: mapAssociationsPayload({
      companiesRaw,
      coursesRaw,
      collegesRaw,
      departmentsRaw,
    }),
  };
};

module.exports = {
  assignScheduleFeed,
  bulkCreateSchedulesFeed,
  bulkUploadSchedulesFeed,
  buildDepartmentDaysPayload,
  buildTrainerSchedulesPayload,
  createScheduleFeed,
  deleteScheduleFeed,
  getScheduleDetailsFeed,
  listScheduleAssociationsFeed,
  listDepartmentDaysFeed,
  listSchedulesFeed,
  listLiveDashboardFeed,
  listTrainerSchedulesFeed,
  updateScheduleFeed,
};
