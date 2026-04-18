const {
  parseCreateScheduleBody,
  parseBulkCreateScheduleBody,
  parseBulkUploadScheduleContext,
  parseAssignScheduleBody,
  parseAssignScheduleParams,
  parseDeleteScheduleParams,
  parseDeleteSchedulePayload,
  parseUpdateScheduleBody,
  parseUpdateScheduleParams,
  parseAssociationsQuery,
  parseDepartmentDaysQuery,
  parseLiveDashboardQuery,
  parseScheduleDetailParams,
  parseSchedulesListQuery,
  parseTrainerScheduleParams,
  parseTrainerScheduleQuery,
} = require("./schedules.schema");
const {
  assignScheduleFeed,
  bulkCreateSchedulesFeed,
  bulkUploadSchedulesFeed,
  createScheduleFeed,
  getScheduleDetailsFeed,
  listScheduleAssociationsFeed,
  listDepartmentDaysFeed,
  listLiveDashboardFeed,
  listSchedulesFeed,
  listTrainerSchedulesFeed,
  deleteScheduleFeed,
  updateScheduleFeed,
} = require("./schedules.service");
const {
  ASSIGN_SCHEDULE_ERROR_MESSAGE,
  ASSIGN_SCHEDULE_NOT_FOUND_MESSAGE,
  BULK_CREATE_SCHEDULE_ERROR_MESSAGE,
  BULK_UPLOAD_FILE_ERROR_MESSAGE,
  BULK_UPLOAD_SCHEDULE_ERROR_MESSAGE,
  CREATE_SCHEDULE_ERROR_MESSAGE,
  DELETE_SCHEDULE_ERROR_MESSAGE,
  DELETE_SCHEDULE_NOT_FOUND_MESSAGE,
  UPDATE_SCHEDULE_ERROR_MESSAGE,
  UPDATE_SCHEDULE_NOT_FOUND_MESSAGE,
} = require("./schedules.types");
const upload = require("../../middleware/upload");
const {
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");
const { logControllerError } = require("../../shared/utils/controllerTelemetry");

const schedulesControllerLogger = createStructuredLogger({
  service: "schedules",
  component: "controller",
});

const logScheduleControllerError = (req, stage, error, fields = {}) =>
  logControllerError(schedulesControllerLogger, {
    req,
    stage,
    error,
    fields,
    correlationPrefix: "sched_ctrl",
  });

const listSchedulesController = async (req, res) => {
  try {
    const query = parseSchedulesListQuery(req.query);
    const payload = await listSchedulesFeed({
      query,
      user: req.user,
    });

    return res.json(payload);
  } catch (error) {
    logScheduleControllerError(req, "list_schedules_failed", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch schedules",
      error: error?.message,
    });
  }
};

const createScheduleAssociationsController = ({
  getScheduleAssociationsFeed = listScheduleAssociationsFeed,
} = {}) => async (req, res) => {
  try {
    parseAssociationsQuery(req.query);
    const payload = await getScheduleAssociationsFeed();
    return res.json(payload);
  } catch (error) {
    logScheduleControllerError(req, "list_schedule_associations_failed", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch associations",
      error: error?.message,
    });
  }
};

const scheduleAssociationsController = createScheduleAssociationsController();

const liveDashboardController = async (req, res) => {
  try {
    parseLiveDashboardQuery(req.query);
    const payload = await listLiveDashboardFeed({
      user: req.user,
    });

    return res.json(payload);
  } catch (error) {
    logScheduleControllerError(req, "list_live_dashboard_failed", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch live dashboard data",
      error: error?.message,
    });
  }
};

const departmentDaysController = async (req, res) => {
  try {
    const query = parseDepartmentDaysQuery(req.query);
    const payload = await listDepartmentDaysFeed({
      departmentId: query.departmentId,
    });

    return res.json(payload);
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    logScheduleControllerError(req, "list_department_days_failed", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch department day slots",
      error: error?.message,
    });
  }
};

const trainerSchedulesController = async (req, res) => {
  try {
    const params = parseTrainerScheduleParams(req.params);
    const query = parseTrainerScheduleQuery(req.query);

    const payload = await listTrainerSchedulesFeed({
      trainerId: params.trainerId,
      month: query.month,
      year: query.year,
      status: query.status,
    });

    return res.json(payload);
  } catch (error) {
    logScheduleControllerError(req, "list_trainer_schedules_failed", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch schedules",
      error: error?.message,
    });
  }
};

const createScheduleDetailsController = ({
  getScheduleDetailFeed = getScheduleDetailsFeed,
} = {}) => async (req, res) => {
  try {
    const params = parseScheduleDetailParams(req.params);
    const schedule = await getScheduleDetailFeed({
      scheduleId: params.scheduleId,
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    return res.json({
      success: true,
      data: schedule,
    });
  } catch (error) {
    logScheduleControllerError(req, "get_schedule_details_failed", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch schedule",
      error: error?.message,
    });
  }
};

const scheduleDetailsController = createScheduleDetailsController();

const createCreateScheduleController = ({
  getCreateScheduleFeed = createScheduleFeed,
  resolveScheduleFolderFields,
  sendInAppNotificationLoader,
} = {}) => async (req, res) => {
  try {
    const payload = parseCreateScheduleBody(req.body);
    const { responsePayload, sideEffectTask } = await getCreateScheduleFeed({
      payload,
      actorUserId: req?.user?.id || req?.user?._id || null,
      io: req?.app?.get?.("io") || req?.io || null,
      resolveScheduleFolderFields,
      sendInAppNotificationLoader,
    });

    res.status(201).json(responsePayload);
    Promise.resolve(sideEffectTask).catch(() => {});
    return undefined;
  } catch (error) {
    logScheduleControllerError(req, "create_schedule_failed", error);
    return res.status(500).json({
      success: false,
      message: CREATE_SCHEDULE_ERROR_MESSAGE,
      error: error?.message,
    });
  }
};

const createScheduleController = createCreateScheduleController();

const createBulkCreateScheduleController = ({
  getBulkCreateSchedulesFeed = bulkCreateSchedulesFeed,
  resolveScheduleFolderFields,
  sendInAppNotificationLoader,
} = {}) => async (req, res) => {
  try {
    const payload = parseBulkCreateScheduleBody(req.body);
    const { statusCode, responsePayload, sideEffectTask } = await getBulkCreateSchedulesFeed({
      payload,
      actorUserId: req?.user?.id || req?.user?._id || null,
      io: req?.app?.get?.("io") || req?.io || null,
      resolveScheduleFolderFields,
      sendInAppNotificationLoader,
    });

    res.status(statusCode || 200).json(responsePayload);
    Promise.resolve(sideEffectTask).catch(() => {});
    return undefined;
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    logScheduleControllerError(req, "bulk_create_schedules_failed", error);
    return res.status(500).json({
      success: false,
      message: BULK_CREATE_SCHEDULE_ERROR_MESSAGE,
      error: error?.message,
    });
  }
};

const bulkCreateScheduleController = createBulkCreateScheduleController();

const createBulkUploadScheduleController = ({
  getBulkUploadSchedulesFeed = bulkUploadSchedulesFeed,
  parseBulkUploadContext = parseBulkUploadScheduleContext,
  uploadSingleLoader = upload.single("file"),
  resolveScheduleFolderFields,
} = {}) => async (req, res) => {
  const runUpload = () =>
    new Promise((resolve, reject) => {
      uploadSingleLoader(req, res, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

  try {
    await runUpload();
  } catch (uploadError) {
    return res.status(400).json({
      success: false,
      message: BULK_UPLOAD_FILE_ERROR_MESSAGE,
      error: uploadError?.message,
    });
  }

  try {
    const payload = parseBulkUploadContext({
      file: req?.file || null,
      user: req?.user || null,
    });
    const { statusCode, responsePayload } = await getBulkUploadSchedulesFeed({
      payload,
      actorUserId: req?.user?.id || req?.user?._id || null,
      actorUserName: req?.user?.name || null,
      resolveScheduleFolderFields,
    });

    return res.status(statusCode || 200).json(responsePayload);
  } catch (error) {
    if (error?.statusCode === 400) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    logScheduleControllerError(req, "bulk_upload_schedules_failed", error);
    return res.status(500).json({
      success: false,
      message: BULK_UPLOAD_SCHEDULE_ERROR_MESSAGE,
      error: error?.message,
    });
  }
};

const bulkUploadScheduleController = createBulkUploadScheduleController();

const createAssignScheduleController = ({
  getAssignScheduleFeed = assignScheduleFeed,
  resolveScheduleFolderFields,
  sendInAppNotificationLoader,
} = {}) => async (req, res) => {
  try {
    const params = parseAssignScheduleParams(req.params);
    const payload = parseAssignScheduleBody(req.body);

    const responsePayload = await getAssignScheduleFeed({
      scheduleId: params.scheduleId,
      payload,
      actorUserId: req?.user?.id || req?.user?._id || null,
      io: req?.app?.get?.("io") || req?.io || null,
      resolveScheduleFolderFields,
      sendInAppNotificationLoader,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: ASSIGN_SCHEDULE_NOT_FOUND_MESSAGE,
      });
    }

    logScheduleControllerError(req, "assign_schedule_failed", error);
    return res.status(500).json({
      success: false,
      message: ASSIGN_SCHEDULE_ERROR_MESSAGE,
      error: error?.message,
    });
  }
};

const assignScheduleController = createAssignScheduleController();

const createUpdateScheduleController = ({
  getUpdateScheduleFeed = updateScheduleFeed,
  resolveScheduleFolderFields,
  sendInAppNotificationLoader,
} = {}) => async (req, res) => {
  try {
    const params = parseUpdateScheduleParams(req.params);
    const payload = parseUpdateScheduleBody(req.body);

    const responsePayload = await getUpdateScheduleFeed({
      scheduleId: params.scheduleId,
      payload,
      io: req?.app?.get?.("io") || req?.io || null,
      resolveScheduleFolderFields,
      sendInAppNotificationLoader,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: UPDATE_SCHEDULE_NOT_FOUND_MESSAGE,
      });
    }

    logScheduleControllerError(req, "update_schedule_failed", error);
    return res.status(500).json({
      success: false,
      message: UPDATE_SCHEDULE_ERROR_MESSAGE,
      error: error?.message,
    });
  }
};

const updateScheduleController = createUpdateScheduleController();

const createDeleteScheduleController = ({
  getDeleteScheduleFeed = deleteScheduleFeed,
  sendInAppNotificationLoader,
} = {}) => async (req, res) => {
  try {
    const params = parseDeleteScheduleParams(req.params);
    const payload = parseDeleteSchedulePayload({
      body: req.body,
      query: req.query,
    });

    const responsePayload = await getDeleteScheduleFeed({
      scheduleId: params.scheduleId,
      payload,
      io: req?.app?.get?.("io") || req?.io || null,
      sendInAppNotificationLoader,
    });

    return res.json(responsePayload);
  } catch (error) {
    if (error?.statusCode === 404) {
      return res.status(404).json({
        success: false,
        message: DELETE_SCHEDULE_NOT_FOUND_MESSAGE,
      });
    }

    logScheduleControllerError(req, "delete_schedule_failed", error);
    return res.status(500).json({
      success: false,
      message: DELETE_SCHEDULE_ERROR_MESSAGE,
      error: error?.message,
    });
  }
};

const deleteScheduleController = createDeleteScheduleController();

module.exports = {
  assignScheduleController,
  bulkCreateScheduleController,
  bulkUploadScheduleController,
  createAssignScheduleController,
  createBulkCreateScheduleController,
  createBulkUploadScheduleController,
  createCreateScheduleController,
  createDeleteScheduleController,
  createUpdateScheduleController,
  createScheduleAssociationsController,
  createScheduleDetailsController,
  createScheduleController,
  deleteScheduleController,
  departmentDaysController,
  liveDashboardController,
  listSchedulesController,
  scheduleAssociationsController,
  scheduleDetailsController,
  trainerSchedulesController,
  updateScheduleController,
};
