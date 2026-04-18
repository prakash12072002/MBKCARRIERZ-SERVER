const { City } = require("../../models");
const {
  evaluateTrainerDocumentWorkflow,
} = require("../../utils/trainerDocumentWorkflow");
const {
  TRAINER_DIRECTORY_ALLOWED_ROLES,
} = require("./trainers.types");
const {
  findTrainerDirectoryPage,
  getTrainerAttendanceSummary,
} = require("./trainers.repository");
const { escapeRegex } = require("./trainers.schema");

const toPortalRole = (value) => String(value || "").trim().toLowerCase();

const assertTrainerDirectoryAccess = (user = {}) => {
  const userRole = toPortalRole(user?.role);
  if (!TRAINER_DIRECTORY_ALLOWED_ROLES.includes(userRole)) {
    const accessError = new Error("Access denied.");
    accessError.statusCode = 403;
    throw accessError;
  }
};

const resolveCityIdByName = async (city) => {
  const normalizedCity = String(city || "").trim();
  if (!normalizedCity) return null;

  const cityDocument = await City.findOne({
    name: new RegExp(`^${escapeRegex(normalizedCity)}$`, "i"),
  })
    .select("_id")
    .lean();

  return cityDocument?._id ? String(cityDocument._id) : null;
};

const listTrainerDirectory = async ({ query, user }) => {
  assertTrainerDirectoryAccess(user);

  const cityId = query.hasCity ? await resolveCityIdByName(query.city) : null;
  const { data: rawRows, total } = await findTrainerDirectoryPage({
    searchRegex: query.searchRegex,
    cityRegex: query.cityRegex,
    cityId,
    sortStage: query.sortStage,
    skip: query.skip,
    limit: query.limit,
  });

  const trainerIds = rawRows
    .map((row) => String(row?._id || "").trim())
    .filter(Boolean);
  const {
    completedDaysByTrainerId,
    pendingDaysByTrainerId,
  } = await getTrainerAttendanceSummary(trainerIds);

  const rows = rawRows.map((row) => {
    const rowId = String(row?._id || "").trim();
    const workflow = evaluateTrainerDocumentWorkflow(row);

    return {
      ...row,
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
      completedDaysCount: completedDaysByTrainerId.get(rowId) || 0,
      pendingDaysCount: pendingDaysByTrainerId.get(rowId) || 0,
    };
  });

  const totalPages = total > 0 ? Math.ceil(total / query.limit) : 0;

  return {
    success: true,
    data: rows,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPrevPage: query.page > 1,
    },
    count: rows.length,
  };
};

module.exports = {
  listTrainerDirectory,
};

