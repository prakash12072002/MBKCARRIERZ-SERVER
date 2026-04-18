const mongoose = require("mongoose");
const {
  Attendance,
  College,
  Company,
  Course,
  Department,
  ActivityLog,
  Notification,
  Schedule,
  Trainer,
  User,
} = require("../../models");

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findScopedCompanyIdsByUserId = async (userId) => {
  if (!userId) {
    return [];
  }

  const linkedCompanies = await Company.find({
    $or: [
      { adminId: userId },
      { userId },
    ],
  })
    .select("_id")
    .lean();

  const seen = new Set();
  const scopedCompanyIds = [];

  linkedCompanies.forEach((company) => {
    const token = String(company?._id || "").trim();
    if (!token || seen.has(token)) return;
    seen.add(token);
    scopedCompanyIds.push(company._id);
  });

  return scopedCompanyIds;
};

const buildSchedulesListQuery = (filter = {}) =>
  Schedule.find({ ...filter, isActive: { $ne: false } })
    .populate("collegeId", "name location")
    .populate("companyId", "name")
    .populate("courseId", "title")
    .populate({
      path: "trainerId",
      select: "trainerId specialization",
      populate: { path: "userId", select: "name email phone" },
    })
    .populate("createdBy", "name")
    .sort({ scheduledDate: 1, startTime: 1 });

const listSchedules = async ({
  filter = {},
  shouldPaginate = false,
  page = 1,
  limit = null,
}) => {
  const schedulesQuery = buildSchedulesListQuery(filter);

  if (shouldPaginate && Number.isFinite(limit) && limit > 0) {
    schedulesQuery.skip((page - 1) * limit).limit(limit);
  }

  const schedules = await schedulesQuery.lean();
  const total = shouldPaginate
    ? await Schedule.countDocuments(filter)
    : schedules.length;

  return {
    schedules,
    total,
  };
};

const listLiveDashboardSchedules = async ({ filter = {} } = {}) =>
  Schedule.find(filter)
    .populate("collegeId", "name location")
    .populate("companyId", "name")
    .populate("courseId", "title")
    .populate({
      path: "trainerId",
      select: "trainerId specialization",
      populate: { path: "userId", select: "name email phone" },
    })
    .sort({ startTime: 1 })
    .lean();

const listLatestAttendanceByScheduleIds = async ({ scheduleIds = [] } = {}) => {
  if (!Array.isArray(scheduleIds) || !scheduleIds.length) {
    return [];
  }

  return Attendance.find({ scheduleId: { $in: scheduleIds } })
    .select(
      "scheduleId status checkInTime checkOutTime location geoVerificationStatus verificationStatus updatedAt createdAt",
    )
    .sort({ scheduleId: 1, createdAt: -1 })
    .lean();
};

const listDepartmentSchedules = async ({ departmentId }) =>
  Schedule.find({ departmentId, isActive: true })
    .sort({ dayNumber: 1, scheduledDate: 1, createdAt: 1 })
    .populate({
      path: "trainerId",
      select: "trainerId phone profilePicture",
      populate: { path: "userId", select: "name email profilePicture" },
    });

const listDepartmentAttendanceDocs = async ({ scheduleIds = [] } = {}) => {
  if (!Array.isArray(scheduleIds) || !scheduleIds.length) {
    return [];
  }

  return Attendance.find({ scheduleId: { $in: scheduleIds } })
    .sort({ createdAt: -1 })
    .select(
      "scheduleId status verificationStatus geoVerificationStatus approvedBy latitude longitude studentsPresent studentsAbsent checkInTime checkOutTime attendancePdfUrl attendanceExcelUrl studentsPhotoUrl signatureUrl checkOutGeoImageUrl checkOutGeoImageUrls activityPhotos activityVideos",
    );
};

const listTrainerSchedules = async ({ filter = {} } = {}) =>
  Schedule.find({ ...filter, isActive: { $ne: false } })
    .populate("collegeId", "name principalName phone")
    .populate("companyId", "name")
    .populate("courseId", "title")
    .populate("trainerId", "id")
    .sort({ scheduledDate: 1, startTime: 1 })
    .lean();

const listTrainerAttendanceDocs = async ({ scheduleIds = [] } = {}) => {
  if (!Array.isArray(scheduleIds) || !scheduleIds.length) {
    return [];
  }

  return Attendance.find({ scheduleId: { $in: scheduleIds } })
    .select(
      "scheduleId assignedDate images finalStatus verificationStatus geoVerificationStatus verificationComment geoValidationComment checkOut status createdAt attendancePdfUrl attendanceExcelUrl studentsPhotoUrl signatureUrl checkOutGeoImageUrl checkOutGeoImageUrls activityPhotos activityVideos",
    )
    .sort({ scheduleId: 1, createdAt: -1 })
    .lean();
};

const getScheduleByIdForAssignment = async ({ scheduleId } = {}) =>
  Schedule.findById(scheduleId);

const getScheduleByIdForUpdate = async ({ scheduleId } = {}) =>
  Schedule.findById(scheduleId);

const getScheduleByIdForDelete = async ({ scheduleId } = {}) =>
  Schedule.findById(scheduleId);

const createScheduleDocument = async ({ schedulePayload } = {}) =>
  Schedule.create(schedulePayload);

const saveScheduleDocument = async ({ schedule }) => schedule.save();

const deleteScheduleDocument = async ({ schedule }) => schedule.deleteOne();

const getTrainerByIdWithUser = async ({ trainerId } = {}) =>
  Trainer.findById(trainerId).populate("userId");

const getCollegeById = async ({ collegeId } = {}) =>
  College.findById(collegeId);

const getCourseById = async ({ courseId } = {}) =>
  Course.findById(courseId);

const getUserById = async ({ userId } = {}) =>
  User.findById(userId);

const getScheduleById = async ({ scheduleId } = {}) =>
  Schedule.findById(scheduleId)
    .populate("collegeId")
    .populate("companyId")
    .populate("courseId")
    .populate("trainerId")
    .populate("createdBy", "id name email");

const listAssociationsCompanies = async () =>
  Company.find({ isActive: true })
    .select("_id name")
    .sort({ name: 1 });

const listAssociationsCourses = async () =>
  Course.find({})
    .select("_id title companyId")
    .sort({ title: 1 });

const listAssociationsColleges = async () =>
  College.find({})
    .select("_id name companyId courseId department")
    .sort({ name: 1 });

const listAssociationsDepartments = async () =>
  Department.find({ isActive: { $ne: false } })
    .select("_id name companyId courseId collegeId")
    .sort({ name: 1 });

const listCollegesByIds = async ({ collegeIds = [] } = {}) =>
  College.find({ _id: { $in: collegeIds } });

const listExistingDaySlotSchedules = async ({
  collegeIds = [],
  departmentIds = [],
  dayNumbers = [],
} = {}) =>
  Schedule.find({
    collegeId: { $in: collegeIds },
    departmentId: { $in: departmentIds },
    dayNumber: { $in: dayNumbers },
    isActive: { $ne: false },
  }).select(
    "_id trainerId collegeId departmentId dayNumber scheduledDate dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink",
  );

const insertManySchedules = async ({ schedules = [] } = {}) =>
  Schedule.insertMany(schedules);

const bulkWriteSchedules = async ({ operations = [] } = {}) =>
  Schedule.bulkWrite(operations, { ordered: false });

const listSchedulesByIds = async ({ scheduleIds = [] } = {}) =>
  Schedule.find({ _id: { $in: scheduleIds } });

const insertAssociationsDepartments = async ({ departments = [] } = {}) =>
  Department.insertMany(departments, { ordered: false });

const findCompanyByNameCaseInsensitive = async ({ companyName } = {}) =>
  Company.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(companyName)}$`, "i") },
  });

const createCompanyDocument = async ({ payload = {} } = {}) =>
  Company.create(payload);

const saveCompanyDocument = async ({ company }) =>
  company.save();

const findCourseByTitleAndCompany = async ({ courseTitle, companyId } = {}) =>
  Course.findOne({
    title: { $regex: new RegExp(`^${escapeRegex(courseTitle)}$`, "i") },
    companyId,
  });

const createCourseDocument = async ({ payload = {} } = {}) =>
  Course.create(payload);

const findCollegeByNameAndCourse = async ({ collegeName, courseId } = {}) =>
  College.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(collegeName)}$`, "i") },
    courseId,
  });

const createCollegeDocument = async ({ payload = {} } = {}) =>
  College.create(payload);

const findTrainerByCustomIdWithUser = async ({ trainerCustomId } = {}) =>
  Trainer.findOne({
    trainerId: { $regex: new RegExp(`^${escapeRegex(trainerCustomId)}$`, "i") },
  }).populate("userId");

const createUserDocument = async ({ payload = {} } = {}) =>
  User.create(payload);

const createTrainerDocument = async ({ payload = {} } = {}) =>
  Trainer.create(payload);

const findApprovedAttendanceByCollegeAndDateRange = async ({
  collegeId,
  startDate,
  endDate,
} = {}) =>
  Attendance.findOne({
    collegeId,
    date: {
      $gte: startDate,
      $lte: endDate,
    },
    verificationStatus: "approved",
  });

const findScheduleByCollegeCourseAndDateRange = async ({
  collegeId,
  courseId,
  startDate,
  endDate,
} = {}) =>
  Schedule.findOne({
    collegeId,
    courseId,
    scheduledDate: {
      $gte: startDate,
      $lte: endDate,
    },
  });

const findLastScheduleByCollege = async ({ collegeId } = {}) =>
  Schedule.findOne({ collegeId }).sort({ dayNumber: -1 });

const createScheduleInstance = async ({ payload = {} } = {}) =>
  new Schedule(payload);

const createNotificationDocument = async ({ payload = {} } = {}) =>
  Notification.create(payload);

const createActivityLogDocument = async ({ payload = {} } = {}) =>
  ActivityLog.create(payload);

const updateAttendanceStatusByScheduleId = async ({ scheduleId, status } = {}) =>
  Attendance.updateMany({ scheduleId }, { $set: { status } });

const resolveTrainerScheduleFilterContext = async ({ trainerIdentifier } = {}) => {
  const normalizedIdentifier = String(trainerIdentifier || "").trim();
  if (!normalizedIdentifier) {
    return {
      cacheTrainerId: "",
      filterTrainerIds: [],
    };
  }

  const trainerLookupFilters = [];
  if (mongoose.Types.ObjectId.isValid(normalizedIdentifier)) {
    trainerLookupFilters.push(
      { _id: normalizedIdentifier },
      { userId: normalizedIdentifier },
    );
  }
  trainerLookupFilters.push({
    trainerId: { $regex: new RegExp(`^${escapeRegex(normalizedIdentifier)}$`, "i") },
  });

  const trainerDocs = trainerLookupFilters.length
    ? await Trainer.find({ $or: trainerLookupFilters }).select("_id").lean()
    : [];

  const resolvedTrainerDocIds = trainerDocs
    .map((trainerDoc) => String(trainerDoc?._id || "").trim())
    .filter(Boolean);

  const uniqueFilterTrainerIds = Array.from(
    new Set([
      ...resolvedTrainerDocIds,
      normalizedIdentifier,
    ].filter(Boolean)),
  );

  return {
    cacheTrainerId: resolvedTrainerDocIds[0] || normalizedIdentifier,
    filterTrainerIds: uniqueFilterTrainerIds,
  };
};

module.exports = {
  findScopedCompanyIdsByUserId,
  listSchedules,
  listLiveDashboardSchedules,
  listLatestAttendanceByScheduleIds,
  listDepartmentSchedules,
  listDepartmentAttendanceDocs,
  listTrainerSchedules,
  listTrainerAttendanceDocs,
  getScheduleByIdForAssignment,
  getScheduleByIdForUpdate,
  getScheduleByIdForDelete,
  createScheduleDocument,
  saveScheduleDocument,
  deleteScheduleDocument,
  getTrainerByIdWithUser,
  getCollegeById,
  getCourseById,
  getUserById,
  getScheduleById,
  listAssociationsCompanies,
  listAssociationsCourses,
  listAssociationsColleges,
  listAssociationsDepartments,
  listCollegesByIds,
  listExistingDaySlotSchedules,
  insertManySchedules,
  bulkWriteSchedules,
  listSchedulesByIds,
  insertAssociationsDepartments,
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
  updateAttendanceStatusByScheduleId,
  resolveTrainerScheduleFilterContext,
};
