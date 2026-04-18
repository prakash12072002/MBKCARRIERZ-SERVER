const {
  parseAttendanceListQuery,
  parseAttendanceDetailsParams,
  parseAttendanceScheduleParams,
  parseAttendanceTrainerParams,
  parseAttendanceTrainerQuery,
  parseAttendanceCollegeParams,
  parseAttendanceDocumentsQuery,
  parseAttendanceVerifyParams,
  parseAttendanceVerifyPayload,
  parseAttendanceDocumentVerifyPayload,
  parseAttendanceDocumentRejectPayload,
  parseAttendanceManualPayload,
  parseAttendanceVerifyGeoPayload,
  parseAttendanceRejectGeoPayload,
} = require("./attendance.schema");
const {
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
} = require("./attendance.service");
const {
  buildControllerErrorTelemetry,
} = require("../../shared/utils/controllerTelemetry");
const {
  syncScheduleDayState,
  emitAttendanceRealtimeUpdate,
  syncScheduleLifecycleStatusFromAttendance,
} = require("./attendance.sideeffects");
const {
  ATTENDANCE_FETCH_FAILED_MESSAGE,
  ATTENDANCE_FETCH_DOCUMENTS_FAILED_MESSAGE,
  ATTENDANCE_MANUAL_CREATE_FAILED_MESSAGE,
} = require("./attendance.types");

const handleControllerError = (res, error, fallbackMessage) => {
  const statusCode = Number(error?.statusCode || 500);
  return res.status(statusCode).json({
    success: false,
    message: error?.message || fallbackMessage,
  });
};

const listAttendanceSubmissionsController = async (req, res) => {
  try {
    const query = parseAttendanceListQuery(req.query);
    const payload = await listAttendanceSubmissions({
      query,
      user: req.user,
    });

    return res.json(payload);
  } catch (error) {
    return handleControllerError(res, error, "Failed to fetch attendance.");
  }
};

const getAttendanceSubmissionDetailsController = async (req, res) => {
  try {
    const params = parseAttendanceDetailsParams(req.params);
    const payload = await getAttendanceSubmissionDetails({
      attendanceId: params.attendanceId,
      user: req.user,
    });

    return res.json(payload);
  } catch (error) {
    return handleControllerError(res, error, "Failed to fetch attendance details.");
  }
};

const verifyAttendanceSubmissionController = async (req, res) => {
  try {
    const params = parseAttendanceVerifyParams(req.params);
    const payload = parseAttendanceVerifyPayload(req.body);

    const result = await verifyAttendanceSubmission({
      params,
      payload,
      user: req.user,
    });

    return res.json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to verify attendance.");
  }
};

const createAttendanceScheduleController = ({
  getAttendanceSchedulePayload = listAttendanceBySchedule,
} = {}) => async (req, res) => {
  try {
    const params = parseAttendanceScheduleParams(req.params);
    const payload = await getAttendanceSchedulePayload({
      scheduleId: params.scheduleId,
    });

    return res.json(payload);
  } catch (error) {
    console.error("Error fetching attendance:", error);
    return res.status(500).json({
      success: false,
      message: ATTENDANCE_FETCH_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const getAttendanceScheduleController = createAttendanceScheduleController();

const createAttendanceLegacyDetailsController = ({
  getAttendanceLegacyDetailsPayload = getAttendanceLegacyDetails,
} = {}) => async (req, res) => {
  try {
    const params = parseAttendanceDetailsParams(req.params);
    const payload = await getAttendanceLegacyDetailsPayload({
      attendanceId: params.attendanceId,
    });

    return res.json(payload);
  } catch (error) {
    if (Number(error?.statusCode) === 404) {
      return res.status(404).json({
        success: false,
        message: error?.message || "Attendance not found",
      });
    }

    console.error("Error fetching attendance details:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch attendance details",
      error: error?.message,
    });
  }
};

const getAttendanceLegacyDetailsController = createAttendanceLegacyDetailsController();

const createAttendanceTrainerController = ({
  getAttendanceTrainerPayload = listAttendanceByTrainer,
} = {}) => async (req, res) => {
  try {
    const params = parseAttendanceTrainerParams(req.params);
    const query = parseAttendanceTrainerQuery(req.query);
    const payload = await getAttendanceTrainerPayload({
      trainerId: params.trainerId,
      month: query.month,
      year: query.year,
    });

    return res.json(payload);
  } catch (error) {
    console.error("Error fetching trainer attendance:", error);
    return res.status(500).json({
      success: false,
      message: ATTENDANCE_FETCH_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const getAttendanceTrainerController = createAttendanceTrainerController();

const createAttendanceCollegeController = ({
  getAttendanceCollegePayload = listAttendanceByCollege,
} = {}) => async (req, res) => {
  try {
    const params = parseAttendanceCollegeParams(req.params);
    const payload = await getAttendanceCollegePayload({
      collegeId: params.collegeId,
    });

    return res.json(payload);
  } catch (error) {
    console.error("Error fetching college attendance:", error);
    return res.status(500).json({
      success: false,
      message: ATTENDANCE_FETCH_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const getAttendanceCollegeController = createAttendanceCollegeController();

const createAttendanceDocumentsController = ({
  getAttendanceDocumentsPayload = listAttendanceDocuments,
} = {}) => async (req, res) => {
  try {
    const query = parseAttendanceDocumentsQuery(req.query);
    const payload = await getAttendanceDocumentsPayload({
      filters: query.filters,
    });
    return res.json(payload);
  } catch (error) {
    if (Number(error?.statusCode) === 400) {
      return res.status(400).json({
        success: false,
        message: error?.message,
      });
    }

    console.error("Error fetching attendance documents:", error);
    return res.status(500).json({
      success: false,
      message: ATTENDANCE_FETCH_DOCUMENTS_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const getAttendanceDocumentsController = createAttendanceDocumentsController();

const createVerifyAttendanceDocumentController = ({
  verifyDocumentPayload = verifyAttendanceDocument,
  syncScheduleDayStateHelper = null,
  emitRealtimeUpdateHelper = null,
} = {}) => async (req, res) => {
  try {
    const payload = parseAttendanceDocumentVerifyPayload(req.body);
    const result = await verifyDocumentPayload({
      documentId: payload.documentId,
      spocId: payload.spocId,
      user: req.user,
    });

    const meta = result.meta || {};
    if (meta.scheduleId && typeof syncScheduleDayStateHelper === "function") {
      const dayState = await syncScheduleDayStateHelper({
        scheduleId: meta.scheduleId,
        attendance: meta.attendance,
      });

      if (typeof emitRealtimeUpdateHelper === "function") {
        emitRealtimeUpdateHelper(req, {
          type: "DOCUMENT_VERIFICATION_UPDATE",
          scheduleId: meta.scheduleId,
          attendanceId: meta.attendanceId || null,
          dayStatus: dayState?.dayStatus || null,
          attendanceUploaded: dayState?.attendanceUploaded ?? null,
          geoTagUploaded: dayState?.geoTagUploaded ?? null,
          message: "Document verified successfully",
        });
      }
    }

    delete result.meta;
    return res.json(result);
  } catch (error) {
    if (Number(error?.statusCode) === 400) {
      return res.status(400).json({
        success: false,
        message: error?.message || "Invalid request payload",
      });
    }
    if (Number(error?.statusCode) === 404) {
      return res.status(404).json({
        success: false,
        message: error?.message || "Document not found",
      });
    }

    console.error("Error verifying attendance document:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify document",
      error: error?.message,
    });
  }
};

const createRejectAttendanceDocumentController = ({
  rejectDocumentPayload = rejectAttendanceDocument,
  syncScheduleDayStateHelper = null,
  emitRealtimeUpdateHelper = null,
} = {}) => {
  return async (req, res) => {
    try {
      const payload = parseAttendanceDocumentRejectPayload(req.body);
      const result = await rejectDocumentPayload({
        ...payload,
        user: req.user,
      });

      if (result.meta?.scheduleId && typeof syncScheduleDayStateHelper === "function") {
          const dayState = await syncScheduleDayStateHelper({
            scheduleId: result.meta.scheduleId,
            attendance: result.meta.attendance,
            dayStatusOverride: "pending"
          });

          if (typeof emitRealtimeUpdateHelper === "function") {
            emitRealtimeUpdateHelper(req, {
              type: "DOCUMENT_VERIFICATION_UPDATE",
              scheduleId: result.meta.scheduleId,
              attendanceId: result.meta.attendanceId || null,
              dayStatus: dayState?.dayStatus || null,
              attendanceUploaded: dayState?.attendanceUploaded ?? null,
              geoTagUploaded: dayState?.geoTagUploaded ?? null,
              message: "Document rejected successfully"
            });
          }
      }

      res.json({
        success: true,
        message: result.message,
        data: result.data
      });
    } catch (error) {
      if (Number(error?.statusCode) === 400) {
        return res.status(400).json({
          success: false,
          message: error?.message || "Invalid request payload",
        });
      }
      if (Number(error?.statusCode) === 404) {
        return res.status(404).json({
          success: false,
          message: error?.message || "Document not found",
        });
      }

      const telemetry = buildControllerErrorTelemetry(req, {
        stage: "reject_attendance_document_failed",
        error,
      });
      console.error("Error rejecting attendance document:", telemetry.reason, telemetry);

      res.status(error.statusCode || 500).json({
        success: false,
        message: "Failed to reject document",
        error: error.message
      });
    }
  };
};

const rejectAttendanceDocumentController = createRejectAttendanceDocumentController({
  syncScheduleDayStateHelper: syncScheduleDayState,
  emitRealtimeUpdateHelper: emitAttendanceRealtimeUpdate,
});
const verifyAttendanceDocumentController = createVerifyAttendanceDocumentController({
  syncScheduleDayStateHelper: syncScheduleDayState,
  emitRealtimeUpdateHelper: emitAttendanceRealtimeUpdate,
});

const createMarkManualAttendanceController = ({
  markManualAttendancePayload = markManualAttendance,
  syncScheduleDayStateHelper = null,
  emitRealtimeUpdateHelper = null,
} = {}) => async (req, res) => {
  try {
    const payload = parseAttendanceManualPayload(req.body);
    const result = await markManualAttendancePayload({
      payload,
      user: req.user,
    });

    const meta = result.meta || {};
    if (meta.scheduleId && typeof syncScheduleDayStateHelper === "function") {
      const dayState = await syncScheduleDayStateHelper({
        scheduleId: meta.scheduleId,
        attendance: meta.attendance,
      });

      if (typeof emitRealtimeUpdateHelper === "function") {
        emitRealtimeUpdateHelper(req, {
          type: "DAY_STATUS_UPDATE",
          scheduleId: meta.scheduleId,
          attendanceId: meta.attendanceId || null,
          dayStatus: dayState?.dayStatus || null,
          attendanceUploaded: dayState?.attendanceUploaded ?? null,
          geoTagUploaded: dayState?.geoTagUploaded ?? null,
          message: `Day status updated to ${dayState?.dayStatus || "pending"}`,
        });
      }
    }

    delete result.meta;
    return res.status(201).json(result);
  } catch (error) {
    if (Number(error?.statusCode) === 400) {
      return res.status(400).json({
        success: false,
        message: error?.message || "Invalid request payload",
      });
    }

    const telemetry = buildControllerErrorTelemetry(req, {
      stage: "mark_manual_attendance_failed",
      error,
    });
    console.error("Error creating manual attendance:", telemetry.reason, telemetry);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: ATTENDANCE_MANUAL_CREATE_FAILED_MESSAGE,
      error: error?.message,
    });
  }
};

const createVerifyGeoTagController = ({
  verifyGeoPayload = verifyGeoVerification,
  syncScheduleDayStateHelper = null,
  syncScheduleLifecycleStatusHelper = null,
  emitRealtimeUpdateHelper = null,
} = {}) => async (req, res) => {
  try {
    const payload = parseAttendanceVerifyGeoPayload(req.body);
    const result = await verifyGeoPayload({
      attendanceId: payload.attendanceId,
      spocId: payload.spocId,
      user: req.user,
    });

    const meta = result.meta || {};
    if (meta.scheduleId && typeof syncScheduleDayStateHelper === "function") {
      if (typeof syncScheduleLifecycleStatusHelper === "function") {
        await syncScheduleLifecycleStatusHelper({
          scheduleId: meta.scheduleId,
          attendance: meta.attendance,
        });
      }

      const dayState = await syncScheduleDayStateHelper({
        scheduleId: meta.scheduleId,
        attendance: meta.attendance,
      });

      if (typeof emitRealtimeUpdateHelper === "function") {
        emitRealtimeUpdateHelper(req, {
          type: "GEO_VERIFICATION_UPDATE",
          scheduleId: meta.scheduleId,
          attendanceId: meta.attendanceId || null,
          dayStatus: dayState?.dayStatus || null,
          attendanceUploaded: dayState?.attendanceUploaded ?? null,
          geoTagUploaded: dayState?.geoTagUploaded ?? null,
          message: "Geo-tag verification approved manually",
        });
      }
    }

    delete result.meta;
    return res.json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to verify geo-tag manually.");
  }
};

const createRejectGeoTagController = ({
  rejectGeoPayload = rejectGeoVerification,
  syncScheduleDayStateHelper = null,
  syncScheduleLifecycleStatusHelper = null,
  emitRealtimeUpdateHelper = null,
} = {}) => async (req, res) => {
  try {
    const payload = parseAttendanceRejectGeoPayload(req.body);
    const result = await rejectGeoPayload({
      attendanceId: payload.attendanceId,
      spocId: payload.spocId,
      reason: payload.reason,
      user: req.user,
    });

    const meta = result.meta || {};
    if (meta.scheduleId && typeof syncScheduleDayStateHelper === "function") {
      if (typeof syncScheduleLifecycleStatusHelper === "function") {
        await syncScheduleLifecycleStatusHelper({
          scheduleId: meta.scheduleId,
          attendance: meta.attendance,
        });
      }

      const dayState = await syncScheduleDayStateHelper({
        scheduleId: meta.scheduleId,
        attendance: meta.attendance,
      });

      if (typeof emitRealtimeUpdateHelper === "function") {
        emitRealtimeUpdateHelper(req, {
          type: "GEO_VERIFICATION_UPDATE",
          scheduleId: meta.scheduleId,
          attendanceId: meta.attendanceId || null,
          dayStatus: dayState?.dayStatus || null,
          attendanceUploaded: dayState?.attendanceUploaded ?? null,
          geoTagUploaded: dayState?.geoTagUploaded ?? null,
          message: "Geo-tag verification rejected manually",
        });
      }
    }

    delete result.meta;
    return res.json(result);
  } catch (error) {
    return handleControllerError(res, error, "Failed to reject geo-tag manually.");
  }
};

const verifyGeoTagController = createVerifyGeoTagController({
  syncScheduleDayStateHelper: syncScheduleDayState,
  syncScheduleLifecycleStatusHelper: syncScheduleLifecycleStatusFromAttendance,
  emitRealtimeUpdateHelper: emitAttendanceRealtimeUpdate,
});

const rejectGeoTagController = createRejectGeoTagController({
  syncScheduleDayStateHelper: syncScheduleDayState,
  syncScheduleLifecycleStatusHelper: syncScheduleLifecycleStatusFromAttendance,
  emitRealtimeUpdateHelper: emitAttendanceRealtimeUpdate,
});

module.exports = {
  createAttendanceCollegeController,
  createAttendanceDocumentsController,
  createAttendanceLegacyDetailsController,
  createAttendanceScheduleController,
  createAttendanceTrainerController,
  createRejectAttendanceDocumentController,
  createVerifyAttendanceDocumentController,
  getAttendanceCollegeController,
  getAttendanceDocumentsController,
  getAttendanceLegacyDetailsController,
  getAttendanceScheduleController,
  getAttendanceTrainerController,
  listAttendanceSubmissionsController,
  getAttendanceSubmissionDetailsController,
  verifyAttendanceSubmissionController,
  rejectAttendanceDocumentController,
  verifyAttendanceDocumentController,
  createVerifyAttendanceDocumentController,
  createMarkManualAttendanceController,
  createVerifyGeoTagController,
  createRejectGeoTagController,
  verifyGeoTagController,
  rejectGeoTagController,
};
