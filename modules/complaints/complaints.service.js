const {
  sendComplaintNotificationEmail,
  sendComplaintStatusUpdateEmail,
} = require("../../utils/emailService");
const { sendNotification } = require("../../services/notificationService");
const {
  COMPLAINT_ALLOWED_CREATE_ROLES,
  COMPLAINT_ALLOWED_LIST_ROLES,
  COMPLAINT_ALLOWED_UPDATE_ROLES,
} = require("./complaints.types");
const {
  createComplaint,
  createComplaintActivityLog,
  findCollegeNameById,
  findComplaintById,
  findComplaintByIdDetailed,
  findSuperAdmins,
  findUserByIdForEmail,
  listComplaints,
  saveComplaint,
} = require("./complaints.repository");
const { escapeRegex } = require("./complaints.schema");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");

const complaintsAsyncLogger = createStructuredLogger({
  service: "complaints",
  component: "async-side-effects",
});

const logComplaintAsyncTelemetry = (level, fields = {}) => {
  const method = typeof complaintsAsyncLogger[level] === "function" ? level : "info";
  complaintsAsyncLogger[method]({
    correlationId: fields.correlationId || null,
    stage: fields.stage || null,
    trainerId: fields.trainerId || null,
    status: fields.status || null,
    outcome: fields.outcome || null,
    cleanupMode: fields.cleanupMode || null,
    reason: fields.reason || null,
    complaintId: fields.complaintId || null,
    complaintType: fields.complaintType || null,
    priority: fields.priority || null,
  });
};

const toPortalRole = (value) => String(value || "").trim().toLowerCase();

const assertRoleAccess = (user = {}, allowedRoles = []) => {
  const role = toPortalRole(user?.role);
  if (!allowedRoles.includes(role)) {
    const accessError = new Error("Access denied");
    accessError.statusCode = 403;
    throw accessError;
  }
};

const toPaginationPayload = ({ page, limit, total }) => {
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

const buildRoleScopedComplaintFilter = (user = {}) => {
  const role = toPortalRole(user.role);
  const filter = {};

  if (role === "trainer") {
    filter.trainerId = user.id;
  } else if (role === "spocadmin" || role === "collegeadmin") {
    filter.assignedTo = user.id;
  } else if (role === "accountant" || role === "accoundant") {
    filter.category = "Payment Issue";
  } else if (role === "company") {
    const denied = new Error("Access Denied");
    denied.statusCode = 403;
    throw denied;
  } else if (role !== "superadmin") {
    const denied = new Error("Access Denied");
    denied.statusCode = 403;
    throw denied;
  }

  return filter;
};

const buildSearchQuery = (searchText = "") => {
  const normalizedSearch = String(searchText || "").trim();
  if (!normalizedSearch) return null;

  const isObjectId = /^[0-9a-fA-F]{24}$/.test(normalizedSearch);
  if (isObjectId) {
    return [{ _id: normalizedSearch }, { trainerId: normalizedSearch }];
  }

  const searchRegex = new RegExp(escapeRegex(normalizedSearch), "i");
  return [
    { variableTrainerName: searchRegex },
    { trainerName: searchRegex },
    { subject: searchRegex },
  ];
};

const listComplaintsFeed = async ({ query, user }) => {
  assertRoleAccess(user, COMPLAINT_ALLOWED_LIST_ROLES);

  const filters = buildRoleScopedComplaintFilter(user);

  if (query.status) {
    filters.status = query.status;
  }

  if (query.category && !filters.category) {
    filters.category = query.category;
  }

  if (query.hasDateFilter && query.date) {
    const dateStart = new Date(query.date);
    const dateEnd = new Date(query.date);
    dateEnd.setHours(23, 59, 59, 999);
    filters.createdAt = { $gte: dateStart, $lte: dateEnd };
  }

  const searchQuery = buildSearchQuery(query.search);
  if (searchQuery?.length) {
    filters.$or = searchQuery;
  }

  const result = await listComplaints({
    filters,
    shouldPaginate: query.shouldPaginate,
    page: query.page,
    limit: query.limit,
  });

  return {
    success: true,
    count: query.shouldPaginate ? result.total : result.data.length,
    data: result.data,
    pagination: query.shouldPaginate
      ? toPaginationPayload({
        page: query.page,
        limit: query.limit,
        total: result.total,
      })
      : undefined,
  };
};

const getComplaintDetails = async ({ complaintId, user }) => {
  assertRoleAccess(user, COMPLAINT_ALLOWED_LIST_ROLES);

  const complaint = await findComplaintByIdDetailed(complaintId);
  if (!complaint) {
    const notFound = new Error("Complaint not found");
    notFound.statusCode = 404;
    throw notFound;
  }

  const role = toPortalRole(user.role);
  const complaintTrainerId = String(complaint?.trainerId?._id || complaint?.trainerId || "");
  const complaintAssignedTo = String(complaint?.assignedTo || "");

  if (role === "trainer" && complaintTrainerId !== String(user.id || "")) {
    const denied = new Error("Not authorized");
    denied.statusCode = 403;
    throw denied;
  }

  if (
    (role === "spocadmin" || role === "collegeadmin")
    && (!complaintAssignedTo || complaintAssignedTo !== String(user.id || ""))
  ) {
    const denied = new Error("Not authorized");
    denied.statusCode = 403;
    throw denied;
  }

  if ((role === "accountant" || role === "accoundant") && complaint.category !== "Payment Issue") {
    const denied = new Error("Not authorized");
    denied.statusCode = 403;
    throw denied;
  }

  return {
    success: true,
    data: complaint,
  };
};

const createComplaintTicket = async ({
  payload,
  user,
  file,
  io,
  allowAnyAuthenticatedCreator = false,
}) => {
  if (!allowAnyAuthenticatedCreator) {
    assertRoleAccess(user, COMPLAINT_ALLOWED_CREATE_ROLES);
  }

  const attachmentUrl = file?.path ? String(file.path).replace(/\\/g, "/") : null;
  const now = new Date();
  let slaHours = 48;
  if (payload.priority === "High") slaHours = 24;
  if (payload.priority === "Low") slaHours = 72;
  const slaDeadline = new Date(now.getTime() + slaHours * 60 * 60 * 1000);

  const complaint = await createComplaint({
    trainerId: user._id,
    trainerName: user.name,
    variableTrainerName: payload.isAnonymous ? "Anonymous" : user.name,
    type: payload.type,
    category: payload.category,
    companyId: payload.companyId,
    collegeId: payload.collegeId,
    scheduleId: payload.scheduleId,
    subject: payload.subject,
    description: payload.description,
    attachmentUrl,
    priority: payload.priority,
    status: "Open",
    isAnonymous: payload.isAnonymous,
    slaDeadline,
  });

  const superAdmins = await findSuperAdmins();
  if (superAdmins.length > 0) {
    const displayName = payload.isAnonymous ? "Anonymous Trainer" : user.name;

    if (io) {
      for (const admin of superAdmins) {
        await sendNotification(io, {
          userId: admin._id,
          role: admin.role,
          title: `New ${payload.type}: ${payload.subject}`,
          message: `${displayName} submitted a ${payload.type}. Priority: ${payload.priority}`,
          type: "Complaints",
          link: `/complaints/${complaint._id}`,
        });
      }
    }

    const adminEmails = superAdmins.map((admin) => admin.email).filter(Boolean);
    if (adminEmails.length > 0) {
      const collegeName = (await findCollegeNameById(payload.collegeId)) || "N/A";
      sendComplaintNotificationEmail(adminEmails, {
        trainerName: displayName,
        type: payload.type,
        category: payload.category,
        collegeName,
        subject: payload.subject,
        priority: payload.priority,
        description: payload.description,
        date: now.toISOString().split("T")[0],
        course: "N/A",
      }).catch((error) => {
        logComplaintAsyncTelemetry("warn", {
          correlationId: createCorrelationId("complaint_create"),
          stage: "complaint_create_email_failed",
          trainerId: trainer?._id ? String(trainer._id) : null,
          complaintId: complaint?._id ? String(complaint._id) : null,
          complaintType: complaint?.type || payload?.type || null,
          priority: complaint?.priority || payload?.priority || null,
          status: "notification",
          outcome: "failed",
          cleanupMode: "none",
          reason: error?.message || "Unknown error",
        });
      });
    }
  }

  return {
    success: true,
    data: complaint,
  };
};

const updateComplaintRecord = async ({
  complaintId,
  payload,
  user,
  io,
  ipAddress = "",
}) => {
  assertRoleAccess(user, COMPLAINT_ALLOWED_UPDATE_ROLES);

  const complaint = await findComplaintById(complaintId);
  if (!complaint) {
    const notFound = new Error("Complaint not found");
    notFound.statusCode = 404;
    throw notFound;
  }

  const oldStatus = complaint.status;
  let statusChanged = false;
  const changeDetails = {};

  if (payload.status && payload.status !== complaint.status) {
    complaint.status = payload.status;
    statusChanged = true;
    changeDetails.status = { from: oldStatus, to: payload.status };
    if (payload.status === "Resolved" || payload.status === "Closed") {
      complaint.resolvedAt = new Date();
    }
  }

  if (
    payload.adminRemarks !== undefined
    && payload.adminRemarks !== complaint.adminRemarks
  ) {
    changeDetails.adminRemarks = {
      from: complaint.adminRemarks,
      to: payload.adminRemarks,
    };
    complaint.adminRemarks = payload.adminRemarks;
  }

  if (
    payload.internalNotes !== undefined
    && payload.internalNotes !== complaint.internalNotes
  ) {
    changeDetails.internalNotes = {
      from: complaint.internalNotes,
      to: payload.internalNotes,
    };
    complaint.internalNotes = payload.internalNotes;
  }

  if (payload.assignedTo !== undefined) {
    changeDetails.assignedTo = payload.assignedTo;
    complaint.assignedTo = payload.assignedTo;
  }

  await saveComplaint(complaint);

  if (Object.keys(changeDetails).length > 0) {
    await createComplaintActivityLog({
      userId: user._id,
      userName: user.name,
      role: user.role,
      action: "UPDATE_COMPLAINT",
      entityType: "Complaint",
      entityId: complaint._id,
      details: changeDetails,
      ipAddress,
    });
  }

  if (statusChanged || (payload.adminRemarks && payload.adminRemarks !== "")) {
    if (io) {
      await sendNotification(io, {
        userId: complaint.trainerId,
        role: "Trainer",
        title: `Complaint Updated: ${complaint.subject}`,
        message: `Your complaint status is now ${complaint.status}. ${payload.adminRemarks ? `Remarks: ${payload.adminRemarks}` : ""}`,
        type: "Complaints",
        link: "/trainer/complaints",
      });
    }

    const trainer = await findUserByIdForEmail(complaint.trainerId);
    if (trainer?.email) {
      sendComplaintStatusUpdateEmail(trainer.email, trainer.name, {
        subject: complaint.subject,
        status: complaint.status,
        adminRemarks: complaint.adminRemarks,
        ticketId: complaint._id,
      }).catch((error) => {
        logComplaintAsyncTelemetry("warn", {
          correlationId: createCorrelationId("complaint_update"),
          stage: "complaint_status_email_failed",
          trainerId: complaint?.trainerId ? String(complaint.trainerId) : null,
          complaintId: complaint?._id ? String(complaint._id) : null,
          complaintType: complaint?.type || null,
          priority: complaint?.priority || null,
          status: "notification",
          outcome: "failed",
          cleanupMode: "none",
          reason: error?.message || "Unknown error",
        });
      });
    }
  }

  return {
    success: true,
    data: complaint,
  };
};

module.exports = {
  listComplaintsFeed,
  getComplaintDetails,
  createComplaintTicket,
  updateComplaintRecord,
};
