const Complaint = require("../../models/Complaint");
const User = require("../../models/User");
const College = require("../../models/College");
const ActivityLog = require("../../models/ActivityLog");

const COMPLAINT_LIST_FIELDS = [
  "trainerId",
  "trainerName",
  "variableTrainerName",
  "type",
  "category",
  "collegeId",
  "subject",
  "description",
  "priority",
  "status",
  "isAnonymous",
  "slaDeadline",
  "assignedTo",
  "createdAt",
];

const buildComplaintListQuery = (filters = {}) =>
  Complaint.find(filters)
    .select(COMPLAINT_LIST_FIELDS.join(" "))
    .populate("trainerId", "name email")
    .populate("collegeId", "name")
    .sort({ createdAt: -1 })
    .lean();

const listComplaints = async ({
  filters = {},
  shouldPaginate = true,
  page = 1,
  limit = 10,
}) => {
  const query = buildComplaintListQuery(filters);
  let totalPromise = Promise.resolve(null);

  if (shouldPaginate) {
    query.skip((page - 1) * limit).limit(limit);
    totalPromise = Complaint.countDocuments(filters);
  }

  const [data, total] = await Promise.all([query, totalPromise]);

  return {
    data,
    total: shouldPaginate ? Number(total || 0) : data.length,
  };
};

const createComplaint = async (payload = {}) =>
  Complaint.create(payload);

const findComplaintById = async (complaintId) =>
  Complaint.findById(complaintId);

const saveComplaint = async (complaint) => complaint.save();

const findComplaintByIdDetailed = async (complaintId) =>
  Complaint.findById(complaintId)
    .populate("trainerId", "name email phone")
    .populate("companyId", "name")
    .populate("collegeId", "name")
    .populate("scheduleId", "date");

const findSuperAdmins = async () =>
  User.find({ role: "SuperAdmin" })
    .select("_id role email")
    .lean();

const findCollegeNameById = async (collegeId) => {
  if (!collegeId) return "";
  const college = await College.findById(collegeId).select("name").lean();
  return String(college?.name || "").trim();
};

const findUserByIdForEmail = async (userId) =>
  User.findById(userId)
    .select("email name")
    .lean();

const createComplaintActivityLog = async (payload = {}) =>
  ActivityLog.create(payload);

module.exports = {
  listComplaints,
  createComplaint,
  findComplaintById,
  saveComplaint,
  findComplaintByIdDetailed,
  findSuperAdmins,
  findCollegeNameById,
  findUserByIdForEmail,
  createComplaintActivityLog,
};
