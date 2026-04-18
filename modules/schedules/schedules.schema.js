const {
  DEFAULT_SCHEDULES_PAGE,
  MAX_SCHEDULES_LIMIT,
} = require("./schedules.types");

const toPositiveInteger = (value, fallback = null) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const parseSchedulesListQuery = (query = {}) => {
  const page = toPositiveInteger(query.page, DEFAULT_SCHEDULES_PAGE);
  const requestedLimit = toPositiveInteger(query.limit, null);
  const shouldPaginate = Number.isFinite(requestedLimit) && requestedLimit > 0;
  const limit = shouldPaginate
    ? Math.min(requestedLimit, MAX_SCHEDULES_LIMIT)
    : null;

  return {
    page,
    limit,
    shouldPaginate,
  };
};

const parseLiveDashboardQuery = () => ({});
const parseAssociationsQuery = () => ({});

const parseDepartmentDaysQuery = (query = {}) => {
  const departmentId = String(query.departmentId || "").trim();

  if (!departmentId) {
    const error = new Error("departmentId is required");
    error.statusCode = 400;
    throw error;
  }

  return {
    departmentId,
  };
};

const parseTrainerScheduleParams = (params = {}) => ({
  trainerId: String(params.trainerId || "").trim(),
});

const parseScheduleDetailParams = (params = {}) => ({
  scheduleId: String(params.id || "").trim(),
});

const parseAssignScheduleParams = (params = {}) => ({
  scheduleId: String(params.id || "").trim(),
});

const parseCreateScheduleBody = (body = {}) => ({
  trainerId: body?.trainerId,
  companyId: body?.companyId,
  courseId: body?.courseId,
  collegeId: body?.collegeId,
  departmentId: body?.departmentId,
  dayNumber: body?.dayNumber,
  scheduledDate: body?.scheduledDate,
  startTime: body?.startTime,
  endTime: body?.endTime,
  subject: body?.subject,
  createdBy: body?.createdBy,
});

const parseBulkCreateScheduleBody = (body = {}) => ({
  schedules: body?.schedules,
  createdBy: body?.createdBy,
});

const parseBulkUploadScheduleContext = ({ file = null, user = null } = {}) => ({
  file,
  user,
});

const parseAssignScheduleBody = (body = {}) => ({
  trainerId: body?.trainerId,
  scheduledDate: body?.scheduledDate,
  startTime: body?.startTime,
  endTime: body?.endTime,
});

const parseUpdateScheduleParams = (params = {}) => ({
  scheduleId: String(params.id || "").trim(),
});

const parseUpdateScheduleBody = (body = {}) => ({
  ...body,
});

const parseDeleteScheduleParams = (params = {}) => ({
  scheduleId: String(params.id || "").trim(),
});

const parseDeleteSchedulePayload = ({ body = {}, query = {} } = {}) => ({
  reason: body?.reason || query?.reason,
});

const parseTrainerScheduleQuery = (query = {}) => ({
  month: query?.month,
  year: query?.year,
  status: String(query?.status || "").trim() || null,
});

module.exports = {
  parseSchedulesListQuery,
  parseLiveDashboardQuery,
  parseAssociationsQuery,
  parseDepartmentDaysQuery,
  parseTrainerScheduleParams,
  parseScheduleDetailParams,
  parseCreateScheduleBody,
  parseBulkCreateScheduleBody,
  parseBulkUploadScheduleContext,
  parseAssignScheduleParams,
  parseAssignScheduleBody,
  parseUpdateScheduleParams,
  parseUpdateScheduleBody,
  parseDeleteScheduleParams,
  parseDeleteSchedulePayload,
  parseTrainerScheduleQuery,
};
