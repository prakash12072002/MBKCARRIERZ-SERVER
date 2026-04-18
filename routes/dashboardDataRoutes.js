const express = require("express");
const dayjs = require("dayjs");

const router = express.Router();

const { authenticate } = require("../middleware/auth");
const {
  Attendance,
  City,
  College,
  Company,
  Complaint,
  Course,
  Salary,
  Schedule,
  Trainer,
  User,
} = require("../models");
const {
  evaluateTrainerDocumentWorkflow,
} = require("../utils/trainerDocumentWorkflow");
const {
  listLiveDashboardFeed,
  listScheduleAssociationsFeed,
  listSchedulesFeed,
  listTrainerSchedulesFeed,
} = require("../modules/schedules/schedules.service");
const { parseSchedulesListQuery } = require("../modules/schedules/schedules.schema");

const DASHBOARD_BUNDLE_CACHE_TTL_MS = 2 * 60 * 1000;
const DASHBOARD_BUNDLE_CACHE_MAX_ENTRIES = 120;
const dashboardBundleCache = new Map();

const parseForceRefreshFlag = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const parseBundleScope = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "core" || normalized === "dashboard") {
    return "core";
  }
  return "full";
};

const getDashboardBundleCacheKey = (userId, role, scope = "full") => {
  const normalizedRole = normalizePortalRole(role);
  const normalizedScope = parseBundleScope(scope);
  const normalizedUserId = String(userId || "").trim() || "anonymous";
  return `${normalizedRole}:${normalizedUserId}:${normalizedScope}`;
};

const getDashboardBundleFromCache = (cacheKey) => {
  if (!cacheKey || !dashboardBundleCache.has(cacheKey)) {
    return null;
  }

  const cachedEntry = dashboardBundleCache.get(cacheKey);
  if (!cachedEntry?.expiresAt || cachedEntry.expiresAt <= Date.now()) {
    dashboardBundleCache.delete(cacheKey);
    return null;
  }

  return cachedEntry.value || null;
};

const setDashboardBundleCache = (cacheKey, value) => {
  if (!cacheKey || !value) {
    return;
  }

  dashboardBundleCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + DASHBOARD_BUNDLE_CACHE_TTL_MS,
  });

  if (dashboardBundleCache.size <= DASHBOARD_BUNDLE_CACHE_MAX_ENTRIES) {
    return;
  }

  const entriesByExpiry = Array.from(dashboardBundleCache.entries()).sort(
    (left, right) =>
      Number(left?.[1]?.expiresAt || 0) - Number(right?.[1]?.expiresAt || 0),
  );
  while (dashboardBundleCache.size > DASHBOARD_BUNDLE_CACHE_MAX_ENTRIES) {
    const entry = entriesByExpiry.shift();
    if (!entry) break;
    dashboardBundleCache.delete(entry[0]);
  }
};

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizePortalRole = (role = "") => {
  const normalized = String(role || "").trim().toLowerCase();

  if (
    normalized.includes("superadmin") ||
    normalized.includes("accountant") ||
    normalized === "admin"
  ) {
    return "SuperAdmin";
  }

  if (
    normalized.includes("spocadmin") ||
    normalized.includes("collegeadmin") ||
    normalized.includes("companyadmin")
  ) {
    return "SPOCAdmin";
  }

  return "Trainer";
};

const getTimeAgo = (date) => {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);

  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes > 1 ? "s" : ""} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
};

const buildCityMatchQuery = (city) => ({
  $or: [
    { cityId: city._id },
    { city: new RegExp(`^${escapeRegex(city.name)}$`, "i") },
  ],
});

const normalizeTrainerAgreementFields = (trainer) => {
  if (!trainer) return trainer;

  const plainTrainer =
    typeof trainer.toObject === "function" ? trainer.toObject() : { ...trainer };
  const documents = plainTrainer.documents || {};
  const agreementAccepted = Boolean(
    plainTrainer.agreementAccepted ?? plainTrainer.agreemeNDAccepted,
  );
  const ndaAgreementPdf =
    plainTrainer.ndaAgreementPdf ||
    plainTrainer.ntaAgreementPdf ||
    plainTrainer.NDAAgreementPdf ||
    null;
  const ndaAgreement =
    documents.ndaAgreement ||
    documents.ntaAgreement ||
    documents.NDAAgreement ||
    ndaAgreementPdf ||
    null;

  return {
    ...plainTrainer,
    agreementAccepted,
    agreemeNDAccepted: agreementAccepted,
    ndaAgreementPdf: ndaAgreementPdf || ndaAgreement || null,
    ntaAgreementPdf: ndaAgreementPdf || ndaAgreement || null,
    NDAAgreementPdf: ndaAgreementPdf || ndaAgreement || null,
    documents: {
      ...documents,
      ndaAgreement,
      ntaAgreement: ndaAgreement,
      NDAAgreement: ndaAgreement,
    },
  };
};

const enrichTrainerWithDocumentWorkflow = (trainer, trainerDocuments = []) => {
  const source = normalizeTrainerAgreementFields(trainer);
  const workflow = evaluateTrainerDocumentWorkflow(source, trainerDocuments);

  return {
    ...source,
    documentStatus: workflow.documentStatus,
    documentSummary: {
      uploadedCount: workflow.uploadedCount,
      approvedCount: workflow.approvedCount,
      pendingReviewCount: workflow.pendingReviewCount,
      requiredCount: workflow.requiredCount,
    },
    documentProgress: workflow.documentProgress,
    documentChecklist: workflow.checklist,
    missingDocuments: workflow.missingDocuments,
    rejectedDocuments: workflow.rejectedDocuments,
    hasAllRequiredDocuments: workflow.hasAllRequiredDocuments,
    allRequiredDocumentsApproved: workflow.allRequiredDocumentsApproved,
    canProceedToAgreement: workflow.canProceedToAgreement,
  };
};

const countDistinctColleges = async (match = {}) => {
  const pipeline = [];

  if (match && Object.keys(match).length > 0) {
    pipeline.push({ $match: match });
  }

  pipeline.push(
    {
      $project: {
        companyId: 1,
        normalizedName: {
          $toLower: {
            $trim: { input: { $ifNull: ["$name", ""] } },
          },
        },
      },
    },
    {
      $match: {
        normalizedName: { $ne: "" },
        companyId: { $ne: null },
      },
    },
    {
      $lookup: {
        from: "companies",
        localField: "companyId",
        foreignField: "_id",
        as: "companyRef",
      },
    },
    { $match: { "companyRef.0": { $exists: true } } },
    {
      $group: {
        _id: {
          companyId: "$companyId",
          name: "$normalizedName",
        },
      },
    },
    { $count: "count" },
  );

  const result = await College.aggregate(pipeline);
  return result[0]?.count || 0;
};

const hasAttendanceDocs = (attendance) =>
  Boolean(attendance?.attendancePdfUrl || attendance?.attendanceExcelUrl);

const hasGeoTagDocs = (attendance) =>
  Boolean(
    attendance?.signatureUrl ||
      attendance?.studentsPhotoUrl ||
      attendance?.checkOutGeoImageUrl ||
      (Array.isArray(attendance?.checkOutGeoImageUrls) &&
        attendance.checkOutGeoImageUrls.length) ||
      (Array.isArray(attendance?.activityPhotos) &&
        attendance.activityPhotos.length) ||
      (Array.isArray(attendance?.activityVideos) &&
        attendance.activityVideos.length),
  );

const normalizeDayStatus = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "pending") return "pending";
  if (normalized === "not_assigned") return "not_assigned";
  return null;
};

const buildDayUploadStatus = (schedule, attendance) => {
  const attendanceUploaded =
    typeof schedule?.attendanceUploaded === "boolean"
      ? schedule.attendanceUploaded
      : hasAttendanceDocs(attendance);
  const geoTagUploaded =
    typeof schedule?.geoTagUploaded === "boolean"
      ? schedule.geoTagUploaded
      : hasGeoTagDocs(attendance);
  const persistedDayStatus = normalizeDayStatus(schedule?.dayStatus);

  if (persistedDayStatus) {
    return {
      attendanceUploaded,
      geoTagUploaded,
      statusCode: persistedDayStatus,
      statusLabel:
        persistedDayStatus === "completed"
          ? "Completed"
          : persistedDayStatus === "pending"
            ? "Pending"
            : "Not Assigned",
    };
  }

  const normalizedScheduleStatus = String(schedule?.status || "")
    .trim()
    .toLowerCase();
  const hasTrainerAssigned = Boolean(schedule?.trainerId);
  const docsRejected =
    String(attendance?.verificationStatus || "").trim().toLowerCase() ===
      "rejected" ||
    String(attendance?.geoVerificationStatus || "").trim().toLowerCase() ===
      "rejected";

  if (!hasTrainerAssigned || normalizedScheduleStatus === "cancelled") {
    return {
      attendanceUploaded,
      geoTagUploaded,
      statusCode: "not_assigned",
      statusLabel: "Not Assigned",
    };
  }

  if (attendanceUploaded && geoTagUploaded && !docsRejected) {
    return {
      attendanceUploaded,
      geoTagUploaded,
      statusCode: "completed",
      statusLabel: "Completed",
    };
  }

  return {
    attendanceUploaded,
    geoTagUploaded,
    statusCode: "pending",
    statusLabel: "Pending",
  };
};

const normalizeScheduleLifecycleStatus = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "COMPLETED") return "COMPLETED";
  if (normalized === "IN_PROGRESS" || normalized === "INPROGRESS") {
    return "inprogress";
  }
  if (normalized === "ASSIGNED" || normalized === "SCHEDULED") {
    return "scheduled";
  }
  if (normalized === "CANCELLED") return "cancelled";
  return String(value || "").trim() || "scheduled";
};

const deriveTrainerScheduleStatus = (schedule, attendance) => {
  const rawStatus = normalizeScheduleLifecycleStatus(schedule?.status);
  const attendanceVerification = String(attendance?.verificationStatus || "")
    .trim()
    .toLowerCase();
  const geoVerification = String(attendance?.geoVerificationStatus || "")
    .trim()
    .toLowerCase();

  if (attendanceVerification !== "approved" && attendance) {
    return "scheduled";
  }

  if (attendanceVerification === "approved" && geoVerification === "approved") {
    return "COMPLETED";
  }

  if (attendanceVerification === "approved") {
    return "inprogress";
  }

  return rawStatus;
};

const buildCurrentUserSnapshot = async (userId, fallbackUser = {}) => {
  const user = await User.findById(userId)
    .select(
      "name firstName lastName email role city phoneNumber profilePicture isActive accountStatus createdAt",
    )
    .lean();

  return {
    id: user?._id || fallbackUser.id || fallbackUser._id || null,
    name: user?.name || fallbackUser.name || "",
    firstName: user?.firstName || fallbackUser.firstName || "",
    lastName: user?.lastName || fallbackUser.lastName || "",
    email: user?.email || fallbackUser.email || "",
    role: normalizePortalRole(user?.role || fallbackUser.role || ""),
    rawRole: user?.role || fallbackUser.role || "",
    city: user?.city || fallbackUser.city || "",
    phoneNumber: user?.phoneNumber || fallbackUser.phoneNumber || "",
    profilePicture: user?.profilePicture || fallbackUser.profilePicture || null,
    isActive:
      typeof user?.isActive === "boolean"
        ? user.isActive
        : fallbackUser.isActive ?? true,
    accountStatus: user?.accountStatus || fallbackUser.accountStatus || "",
    createdAt: user?.createdAt || fallbackUser.createdAt || null,
  };
};

const buildSuperAdminDashboardResponse = async () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const [
    totalCompanies,
    totalColleges,
    totalTrainers,
    activeTrainersToday,
    presentCount,
    absentCount,
    pendingApprovals,
    recentAttendance,
  ] = await Promise.all([
    Company.countDocuments(),
    countDistinctColleges(),
    Trainer.countDocuments(),
    Trainer.countDocuments({ lastActiveDate: { $gte: today } }),
    Attendance.countDocuments({
      date: { $gte: today },
      status: "Present",
    }),
    Attendance.countDocuments({
      date: { $gte: today },
      status: "Absent",
    }),
    Trainer.countDocuments({ verificationStatus: "pending" }),
    Attendance.find({ createdAt: { $gte: yesterday } })
      .populate("trainerId", "userId")
      .populate({
        path: "trainerId",
        populate: { path: "userId", select: "name" },
      })
      .populate("collegeId", "name")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  const salaryDue = 0;
  const receNDActivity = recentAttendance.map((attendance) => {
    const trainerName = attendance.trainerId?.userId?.name || "Unknown Trainer";
    const collegeName = attendance.collegeId?.name || "Unknown College";
    const action = attendance.checkOutTime
      ? `Checked out from ${collegeName}`
      : `Checked in at ${collegeName}`;

    return {
      id: attendance._id,
      user: trainerName,
      action,
      time: getTimeAgo(attendance.createdAt),
    };
  });

  if (receNDActivity.length === 0) {
    receNDActivity.push({
      id: "activity-empty",
      user: "System",
      action: "No recent trainer activity",
      time: "Just now",
    });
  }

  return {
    success: true,
    data: {
      stats: [
        {
          title: "Total Companies",
          value: totalCompanies,
          change: "+0",
          changeType: "neutral",
        },
        {
          title: "Total Colleges",
          value: totalColleges,
          change: "+0",
          changeType: "neutral",
        },
        {
          title: "Total Trainers",
          value: totalTrainers,
          change: "+0",
          changeType: "neutral",
        },
        {
          title: "Active Trainers Today",
          value: activeTrainersToday,
          change: "+0",
          changeType: "positive",
        },
        {
          title: "Present / Absent Count",
          value: `${presentCount} / ${absentCount}`,
          change: "0%",
          changeType: "neutral",
        },
        {
          title: "Pending Approvals",
          value: pendingApprovals,
          change: "0",
          changeType: "neutral",
        },
        {
          title: "Salary Due Summary",
          value: `Rs ${salaryDue}`,
          change: "+0%",
          changeType: "neutral",
        },
      ],
      receNDActivity,
    },
  };
};

const buildSpocDashboardResponse = async (userId) => {
  const company = await Company.findOne({
    $or: [{ userId }, { "admin.userId": userId }],
  }).lean();

  if (!company) {
    return {
      success: true,
      data: {
        stats: [
          { name: "Today Trainers", stat: "0", iconType: "trainers" },
          { name: "Companies", stat: "0", iconType: "companies" },
          { name: "Colleges", stat: "0", iconType: "colleges" },
          { name: "Pending Verifications", stat: "0", iconType: "pending" },
          { name: "Attendance Summary", stat: "0/0", iconType: "attendance" },
        ],
        receNDActivity: [],
      },
    };
  }

  const [colleges, distinctCollegeCount] = await Promise.all([
    College.find({ companyId: company._id }).select("_id").lean(),
    countDistinctColleges({ companyId: company._id }),
  ]);
  const collegeIds = colleges.map((college) => college._id);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [
    todayTrainersCount,
    pendingVerifications,
    presentToday,
    absentToday,
  ] = await Promise.all([
    Schedule.countDocuments({
      collegeId: { $in: collegeIds },
      scheduledDate: { $gte: today, $lt: tomorrow },
      status: { $ne: "cancelled" },
    }),
    Attendance.countDocuments({
      collegeId: { $in: collegeIds },
      verificationStatus: "pending",
    }),
    Attendance.countDocuments({
      collegeId: { $in: collegeIds },
      date: { $gte: today, $lt: tomorrow },
      status: "Present",
    }),
    Attendance.countDocuments({
      collegeId: { $in: collegeIds },
      date: { $gte: today, $lt: tomorrow },
      status: "Absent",
    }),
  ]);

  return {
    success: true,
    data: {
      stats: [
        {
          name: "Today Trainers",
          stat: todayTrainersCount.toString(),
          iconType: "trainers",
        },
        { name: "Companies", stat: "1", iconType: "companies" },
        {
          name: "Colleges",
          stat: distinctCollegeCount.toString(),
          iconType: "colleges",
        },
        {
          name: "Pending Verifications",
          stat: pendingVerifications.toString(),
          iconType: "pending",
        },
        {
          name: "Attendance Summary",
          stat: `${presentToday}/${absentToday}`,
          iconType: "attendance",
        },
      ],
      receNDActivity: [
        {
          id: 1,
          type: "status",
          content: `Dashboard loaded for ${company.name}`,
          date: "Just now",
        },
      ],
    },
  };
};

const buildCompaniesResponse = async () =>
  Company.find({}).sort({ createdAt: -1 }).lean();

const buildPendingUsersResponse = async () => {
  const users = await User.find({
    role: "Trainer",
    accountStatus: "pending",
  })
    .select("name email role createdAt accountStatus")
    .lean();

  return { success: true, users };
};

const buildUsersResponse = async () => {
  const users = await User.find({})
    .select("id name email role isActive emailVerified plainPassword createdAt updatedAt")
    .lean();

  return { success: true, users };
};

const buildTrainersResponse = async () => {
  const trainerUsers = await User.find({ role: "Trainer" }).select(
    "name firstName lastName email phoneNumber city specialization experience isActive role createdAt",
  );
  const userIds = trainerUsers.map((user) => user._id);

  if (userIds.length === 0) {
    return { success: true, data: [] };
  }

  const trainers = await Trainer.find({ userId: { $in: userIds } })
    .populate(
      "userId",
      "name firstName lastName email phoneNumber city specialization experience isActive role createdAt",
    )
    .sort({ createdAt: -1 });

  const trainerIds = trainers.map((trainer) => trainer._id);
  let completedDaysMap = new Map();
  let pendingDaysMap = new Map();

  if (trainerIds.length > 0) {
    const attendanceSummary = await Attendance.aggregate([
      {
        $match: {
          trainerId: { $in: trainerIds },
        },
      },
      {
        $group: {
          _id: "$trainerId",
          completedDaysCount: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $ne: ["$completedAt", null] },
                    {
                      $and: [
                        { $eq: ["$verificationStatus", "approved"] },
                        {
                          $or: [
                            { $eq: ["$attendanceStatus", "PRESENT"] },
                            { $eq: ["$status", "Present"] },
                          ],
                        },
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
          pendingDaysCount: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$verificationStatus", "pending"] },
                    { $eq: ["$status", "Pending"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    completedDaysMap = new Map(
      attendanceSummary.map((entry) => [
        String(entry._id),
        Number(entry.completedDaysCount || 0),
      ]),
    );
    pendingDaysMap = new Map(
      attendanceSummary.map((entry) => [
        String(entry._id),
        Number(entry.pendingDaysCount || 0),
      ]),
    );
  }

  return {
    success: true,
    data: trainers.map((trainer) => {
      const enriched = enrichTrainerWithDocumentWorkflow(trainer);
      return {
        ...enriched,
        completedDaysCount: completedDaysMap.get(String(trainer._id)) || 0,
        pendingDaysCount: pendingDaysMap.get(String(trainer._id)) || 0,
      };
    }),
  };
};

const buildAttendanceResponse = async () => {
  const attendance = await Attendance.find({})
    .populate({
      path: "trainerId",
      populate: { path: "userId", select: "name email" },
    })
    .populate({
      path: "collegeId",
      select: "name latitude longitude companyId",
      populate: { path: "companyId", select: "name" },
    })
    .populate({
      path: "scheduleId",
      populate: { path: "courseId", select: "name" },
    })
    .sort({ createdAt: -1 });

  return { success: true, data: attendance };
};

const buildSalariesResponse = async () =>
  Salary.find({})
    .populate({
      path: "trainerId",
      populate: { path: "userId" },
    })
    .sort({ year: -1, month: -1 })
    .lean();

const buildNdaRecordsResponse = async () => {
  const trainers = await Trainer.find({
    email: { $exists: true, $ne: null },
  })
    .populate(
      "userId",
      "name firstName lastName email phoneNumber city specialization experience isActive role createdAt accountStatus",
    )
    .sort({ updatedAt: -1, createdAt: -1 });

  const data = trainers.map((trainer) => {
    const enriched = enrichTrainerWithDocumentWorkflow(trainer);
    const normalizedAgreement = normalizeTrainerAgreementFields(enriched);

    return {
      ...enriched,
      ...normalizedAgreement,
      agreementAccepted: normalizedAgreement.agreementAccepted,
      agreemeNDAccepted: normalizedAgreement.agreementAccepted,
      agreementDate: trainer.agreementDate,
      ndaAgreementPdf: normalizedAgreement.ndaAgreementPdf,
      ntaAgreementPdf: normalizedAgreement.ndaAgreementPdf,
      NDAAgreementPdf: normalizedAgreement.ndaAgreementPdf,
    };
  });

  return { success: true, data };
};

const buildCitiesResponse = async () => {
  const cities = await City.find({}).sort({ name: 1 });
  const citiesWithCounts = await Promise.all(
    cities.map(async (city) => {
      const trainerCount = await Trainer.countDocuments(buildCityMatchQuery(city));
      return {
        ...city.toObject(),
        trainerCount,
      };
    }),
  );

  return { success: true, cities: citiesWithCounts };
};

const buildComplaintsResponse = async (user) => {
  const query = {};
  const normalizedRole = normalizePortalRole(user?.role);

  if (normalizedRole === "Trainer") {
    query.trainerId = user.id;
  } else if (normalizedRole === "SPOCAdmin") {
    query.assignedTo = user.id;
  }

  const complaints = await Complaint.find(query)
    .populate("trainerId", "name email")
    .populate("collegeId", "name")
    .sort({ createdAt: -1 })
    .lean();

  return {
    success: true,
    count: complaints.length,
    data: complaints,
  };
};

const buildAllSchedulesResponse = async () => {
  return listSchedulesFeed({
    query: parseSchedulesListQuery({}),
    user: null,
  });
};

const buildLiveDashboardResponse = async () => {
  return listLiveDashboardFeed({
    user: null,
  });
};

const buildAssociationsResponse = async () => {
  return listScheduleAssociationsFeed();
};

const ensureTrainerProfile = async (userId) => {
  let trainer = await Trainer.findOne({ userId }).populate(
    "userId",
    "name email role city phoneNumber profileCompletedOnce isActive createdAt profilePicture",
  );

  if (!trainer) {
    const createdTrainer = await Trainer.create({
      userId,
      verificationStatus: "NOT_SUBMITTED",
    });

    trainer = await Trainer.findById(createdTrainer._id).populate(
      "userId",
      "name email role city phoneNumber profileCompletedOnce isActive createdAt profilePicture",
    );
  }

  return trainer;
};

const buildTrainerProfileResponse = async (userId) => {
  const trainer = await ensureTrainerProfile(userId);
  const colleges = await College.find({ trainers: trainer._id })
    .select("id name")
    .lean();

  const normalizedTrainer = normalizeTrainerAgreementFields(trainer);
  const workflow = evaluateTrainerDocumentWorkflow(trainer);
  const canGenerateIdCard =
    String(trainer.status || "").trim().toUpperCase() === "APPROVED" ||
    ["VERIFIED", "APPROVED"].includes(
      String(trainer.verificationStatus || "").trim().toUpperCase(),
    ) ||
    String(trainer.registrationStatus || "").trim().toLowerCase() ===
      "approved";

  return {
    data: {
      id: trainer._id,
      userId: trainer.userId?._id || userId,
      trainerId: trainer.trainerId,
      trainerCode: trainer.trainerId,
      name: trainer.userId?.name || "",
      email: trainer.userId?.email || "",
      phone: trainer.phone,
      address: trainer.address,
      city: trainer.city || trainer.userId?.city,
      specialization: trainer.specialization,
      status: trainer.status,
      verificationStatus: trainer.verificationStatus,
      registrationStatus: trainer.registrationStatus,
      approvedAt: trainer.approvedAt,
      createdAt: trainer.createdAt,
      joiningDate:
        trainer.approvedAt || trainer.createdAt || trainer.userId?.createdAt || null,
      profilePicture: trainer.profilePicture,
      photo:
        workflow.documentProgress?.selfiePhoto ||
        normalizedTrainer.documents?.selfiePhoto ||
        trainer.profilePicture ||
        workflow.documentProgress?.passportPhoto ||
        normalizedTrainer.documents?.passportPhoto ||
        trainer.userId?.profilePicture ||
        null,
      documents: normalizedTrainer.documents,
      documentProgress: workflow.documentProgress,
      documentChecklist: workflow.checklist,
      agreementAccepted: normalizedTrainer.agreementAccepted,
      agreemeNDAccepted: normalizedTrainer.agreementAccepted,
      ndaAgreementPdf: normalizedTrainer.ndaAgreementPdf,
      ntaAgreementPdf: normalizedTrainer.ndaAgreementPdf,
      NDAAgreementPdf: normalizedTrainer.ndaAgreementPdf,
      colleges,
      profileCompletedOnce: trainer.userId?.profileCompletedOnce,
      isActive: trainer.userId?.isActive,
      canGenerateIdCard,
      documentStatus: workflow.documentStatus,
      documentSummary: {
        uploadedCount: workflow.uploadedCount,
        approvedCount: workflow.approvedCount,
        requiredCount: workflow.requiredCount,
      },
      missingDocuments: workflow.missingDocuments,
      rejectedDocuments: workflow.rejectedDocuments,
      hasAllRequiredDocuments: workflow.hasAllRequiredDocuments,
    },
  };
};

const buildTrainerScheduleResponse = async (trainerId, filters = {}) => {
  const { month, year, status } = filters;
  return listTrainerSchedulesFeed({
    trainerId,
    month,
    year,
    status,
  });
};

const buildTrainerCoreBundle = async (currentUser) => {
  const profileResponse = await buildTrainerProfileResponse(currentUser.id);
  const trainerId = profileResponse?.data?.id;
  const currentDate = new Date();
  const previousDate = new Date();
  previousDate.setMonth(previousDate.getMonth() - 1);

  const currentMonthKey = `/schedules/trainer/${trainerId}?month=${
    currentDate.getMonth() + 1
  }&year=${currentDate.getFullYear()}`;
  const previousMonthKey = `/schedules/trainer/${trainerId}?month=${
    previousDate.getMonth() + 1
  }&year=${previousDate.getFullYear()}`;

  const [currentMonthResponse, previousMonthResponse] = trainerId
    ? await Promise.all([
        buildTrainerScheduleResponse(trainerId, {
          month: currentDate.getMonth() + 1,
          year: currentDate.getFullYear(),
        }),
        buildTrainerScheduleResponse(trainerId, {
          month: previousDate.getMonth() + 1,
          year: previousDate.getFullYear(),
        }),
      ])
    : [
        { success: true, count: 0, data: [] },
        { success: true, count: 0, data: [] },
      ];

  return {
    dashboard: {
      profile: profileResponse?.data || null,
      currentMonthSchedule: currentMonthResponse?.data || [],
      previousMonthSchedule: previousMonthResponse?.data || [],
      allSchedules: [],
    },
    resources: {
      "/trainers/profile/me": profileResponse,
      [currentMonthKey]: currentMonthResponse,
      [previousMonthKey]: previousMonthResponse,
    },
  };
};

const buildSpocCoreBundle = async (currentUser) => {
  const dashboardResponse = await buildSpocDashboardResponse(currentUser.id);

  return {
    dashboard: dashboardResponse?.data || {},
    resources: {
      "/dashboard/spoc": dashboardResponse,
    },
  };
};

const buildSuperAdminCoreBundle = async () => {
  const dashboardResponse = await buildSuperAdminDashboardResponse();

  return {
    dashboard: dashboardResponse?.data || {},
    resources: {
      "/dashboard/super-admin": dashboardResponse,
    },
  };
};

const buildTrainerBundle = async (currentUser) => {
  const profileResponse = await buildTrainerProfileResponse(currentUser.id);
  const trainerId = profileResponse?.data?.id;
  const currentDate = new Date();
  const previousDate = new Date();
  previousDate.setMonth(previousDate.getMonth() - 1);

  const currentMonthKey = `/schedules/trainer/${trainerId}?month=${
    currentDate.getMonth() + 1
  }&year=${currentDate.getFullYear()}`;
  const previousMonthKey = `/schedules/trainer/${trainerId}?month=${
    previousDate.getMonth() + 1
  }&year=${previousDate.getFullYear()}`;
  const allSchedulesKey = `/schedules/trainer/${trainerId}`;

  const [currentMonthResponse, previousMonthResponse, allSchedulesResponse] =
    trainerId
      ? await Promise.all([
          buildTrainerScheduleResponse(trainerId, {
            month: currentDate.getMonth() + 1,
            year: currentDate.getFullYear(),
          }),
          buildTrainerScheduleResponse(trainerId, {
            month: previousDate.getMonth() + 1,
            year: previousDate.getFullYear(),
          }),
          buildTrainerScheduleResponse(trainerId),
        ])
      : [
          { success: true, count: 0, data: [] },
          { success: true, count: 0, data: [] },
          { success: true, count: 0, data: [] },
        ];

  const resources = {
    "/trainers/profile/me": profileResponse,
    [currentMonthKey]: currentMonthResponse,
    [previousMonthKey]: previousMonthResponse,
    [allSchedulesKey]: allSchedulesResponse,
  };

  return {
    dashboard: {
      profile: profileResponse?.data || null,
      currentMonthSchedule: currentMonthResponse?.data || [],
      previousMonthSchedule: previousMonthResponse?.data || [],
      allSchedules: allSchedulesResponse?.data || [],
    },
    resources,
  };
};

const buildSpocBundle = async (currentUser) => {
  const [
    dashboardResponse,
    liveDashboardResponse,
    allSchedulesResponse,
    associationsResponse,
    trainersResponse,
    complaintsResponse,
  ] = await Promise.all([
    buildSpocDashboardResponse(currentUser.id),
    buildLiveDashboardResponse(),
    buildAllSchedulesResponse(),
    buildAssociationsResponse(),
    buildTrainersResponse(),
    buildComplaintsResponse(currentUser),
  ]);

  return {
    dashboard: dashboardResponse?.data || {},
    resources: {
      "/dashboard/spoc": dashboardResponse,
      "/schedules/live-dashboard": liveDashboardResponse,
      "/schedules/all": allSchedulesResponse,
      "/schedules/associations/all": associationsResponse,
      "/trainers": trainersResponse,
      "/complaints": complaintsResponse,
    },
  };
};

const buildSuperAdminBundle = async (currentUser) => {
  const [
    dashboardResponse,
    companiesResponse,
    pendingUsersResponse,
    trainersResponse,
    salariesResponse,
    ndaRecordsResponse,
    usersResponse,
    citiesResponse,
    complaintsResponse,
  ] = await Promise.all([
    buildSuperAdminDashboardResponse(),
    buildCompaniesResponse(),
    buildPendingUsersResponse(),
    buildTrainersResponse(),
    buildSalariesResponse(),
    buildNdaRecordsResponse(),
    buildUsersResponse(),
    buildCitiesResponse(),
    buildComplaintsResponse(currentUser),
  ]);

  return {
    dashboard: dashboardResponse?.data || {},
    resources: {
      "/dashboard/super-admin": dashboardResponse,
      "/companies": companiesResponse,
      "/users/pending": pendingUsersResponse,
      "/trainers": trainersResponse,
      "/salaries": salariesResponse,
      "/trainers/nda-records": ndaRecordsResponse,
      "/users": usersResponse,
      "/cities": citiesResponse,
      "/complaints": complaintsResponse,
    },
  };
};

router.get("/", authenticate, async (req, res) => {
  try {
    const normalizedRole = normalizePortalRole(req.user?.role);
    const bundleScope = parseBundleScope(req.query?.scope);
    const forceRefresh = parseForceRefreshFlag(req.query?.force);
    const cacheKey = getDashboardBundleCacheKey(
      req.user?.id,
      normalizedRole,
      bundleScope,
    );

    if (!forceRefresh) {
      const cachedPayload = getDashboardBundleFromCache(cacheKey);
      if (cachedPayload) {
        return res.json({
          success: true,
          data: cachedPayload,
          meta: {
            cache: "HIT",
            ttlMs: DASHBOARD_BUNDLE_CACHE_TTL_MS,
            scope: bundleScope,
          },
        });
      }
    }

    const currentUser = await buildCurrentUserSnapshot(req.user.id, req.user);

    let bundle;
    if (bundleScope === "core") {
      if (normalizedRole === "SuperAdmin") {
        bundle = await buildSuperAdminCoreBundle();
      } else if (normalizedRole === "SPOCAdmin") {
        bundle = await buildSpocCoreBundle(currentUser);
      } else {
        bundle = await buildTrainerCoreBundle(currentUser);
      }
    } else if (normalizedRole === "SuperAdmin") {
      bundle = await buildSuperAdminBundle(currentUser);
    } else if (normalizedRole === "SPOCAdmin") {
      bundle = await buildSpocBundle(currentUser);
    } else {
      bundle = await buildTrainerBundle(currentUser);
    }

    const responsePayload = {
      role: normalizedRole,
      user: currentUser,
      dashboard: bundle.dashboard,
      resources: bundle.resources,
      fetchedAt: new Date().toISOString(),
    };
    setDashboardBundleCache(cacheKey, responsePayload);

    return res.json({
      success: true,
      data: responsePayload,
      meta: {
        cache: forceRefresh ? "MISS_FORCED" : "MISS",
        ttlMs: DASHBOARD_BUNDLE_CACHE_TTL_MS,
        scope: bundleScope,
      },
    });
  } catch (error) {
    console.error("Error building dashboard-data bundle:", error);
    res.status(500).json({
      success: false,
      message: "Failed to build dashboard data bundle",
      error: error.message,
    });
  }
});

module.exports = router;
