const {
  DEFAULT_COMPLAINT_PAGE_LIMIT,
  MAX_COMPLAINT_PAGE_LIMIT,
} = require("./complaints.types");

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const toSafeTrimmedString = (value) => String(value || "").trim();

const toBooleanFlag = (value) =>
  value === true || String(value || "").trim().toLowerCase() === "true";

const shouldPaginate = (query = {}) =>
  Object.prototype.hasOwnProperty.call(query, "page")
  || Object.prototype.hasOwnProperty.call(query, "limit");

const parseComplaintDate = (value) => {
  const normalized = toSafeTrimmedString(value);
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  parsed.setHours(0, 0, 0, 0);
  return parsed;
};

const parseComplaintIdParams = (params = {}) => ({
  complaintId: toSafeTrimmedString(params.id),
});

const parseComplaintListQuery = (query = {}) => {
  const page = toPositiveInteger(query.page, 1);
  const requestedLimit = toPositiveInteger(
    query.limit,
    DEFAULT_COMPLAINT_PAGE_LIMIT,
  );

  return {
    page,
    limit: Math.min(requestedLimit, MAX_COMPLAINT_PAGE_LIMIT),
    shouldPaginate: shouldPaginate(query),
    status: toSafeTrimmedString(query.status),
    category: toSafeTrimmedString(query.category),
    search: toSafeTrimmedString(query.search),
    date: parseComplaintDate(query.date),
    hasDateFilter: Boolean(query.date),
  };
};

const parseComplaintCreatePayload = (body = {}) => ({
  type: toSafeTrimmedString(body.type) || "Complaint",
  category: toSafeTrimmedString(body.category) || "Other",
  companyId: toSafeTrimmedString(body.companyId) || null,
  collegeId: toSafeTrimmedString(body.collegeId) || null,
  scheduleId: toSafeTrimmedString(body.scheduleId) || null,
  subject: toSafeTrimmedString(body.subject) || "No Subject",
  description: toSafeTrimmedString(body.description),
  priority: toSafeTrimmedString(body.priority) || "Medium",
  isAnonymous: toBooleanFlag(body.isAnonymous),
});

const parseComplaintUpdatePayload = (body = {}) => ({
  status: toSafeTrimmedString(body.status),
  adminRemarks: body.adminRemarks,
  internalNotes: body.internalNotes,
  assignedTo: body.assignedTo,
});

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = {
  parseComplaintIdParams,
  parseComplaintListQuery,
  parseComplaintCreatePayload,
  parseComplaintUpdatePayload,
  escapeRegex,
};
