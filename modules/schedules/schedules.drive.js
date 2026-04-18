const { College, Company, Course, Department } = require("../../models");
const {
  ensureCollegeHierarchy,
  ensureDepartmentHierarchy,
  isTrainingDriveEnabled,
  toDepartmentDayFolders,
} = require("../drive/driveGateway");
const {
  buildScheduleFolderFields,
} = require("../drive/driveFolderResolver");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");

const schedulesDriveLogger = createStructuredLogger({
  service: "schedules",
  component: "drive-metadata",
});

const logDriveTelemetry = (level, fields = {}) => {
  const method = typeof schedulesDriveLogger[level] === "function" ? level : "info";
  schedulesDriveLogger[method]({
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
    companyId: fields.companyId || null,
    courseId: fields.courseId || null,
    collegeId: fields.collegeId || null,
    departmentId: fields.departmentId || null,
    dayNumber: Number.isFinite(fields.dayNumber) ? fields.dayNumber : null,
  });
};

const toDayNumber = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const findDayFolderEntry = (dayFolders, dayNumber) => {
  if (!Array.isArray(dayFolders) || !Number.isFinite(dayNumber)) return null;
  return dayFolders.find((item) => Number(item?.day) === Number(dayNumber)) || null;
};

const syncDriveHierarchyMetadata = async ({
  company,
  course,
  college,
  department,
  correlationId = null,
  collegeHierarchy,
  departmentHierarchy,
  toDepartmentDayFoldersLoader = toDepartmentDayFolders,
}) => {
  const syncCorrelationId = correlationId || createCorrelationId("sched_drive_sync");
  const syncStats = {
    companyUpdated: false,
    courseUpdated: false,
    collegeUpdated: false,
    departmentUpdated: false,
    dayFoldersUpdated: false,
  };

  if (
    company
    && departmentHierarchy?.companyFolder?.id
    && company.driveFolderId !== departmentHierarchy.companyFolder.id
  ) {
    company.driveFolderId = departmentHierarchy.companyFolder.id;
    company.driveFolderName = departmentHierarchy.companyFolder.name;
    company.driveFolderLink = departmentHierarchy.companyFolder.link;
    await company.save();
    syncStats.companyUpdated = true;
  } else if (
    company
    && collegeHierarchy?.companyFolder?.id
    && company.driveFolderId !== collegeHierarchy.companyFolder.id
  ) {
    company.driveFolderId = collegeHierarchy.companyFolder.id;
    company.driveFolderName = collegeHierarchy.companyFolder.name;
    company.driveFolderLink = collegeHierarchy.companyFolder.link;
    await company.save();
    syncStats.companyUpdated = true;
  }

  if (
    course
    && departmentHierarchy?.courseFolder?.id
    && course.driveFolderId !== departmentHierarchy.courseFolder.id
  ) {
    course.driveFolderId = departmentHierarchy.courseFolder.id;
    course.driveFolderName = departmentHierarchy.courseFolder.name;
    course.driveFolderLink = departmentHierarchy.courseFolder.link;
    await course.save();
    syncStats.courseUpdated = true;
  } else if (
    course
    && collegeHierarchy?.courseFolder?.id
    && course.driveFolderId !== collegeHierarchy.courseFolder.id
  ) {
    course.driveFolderId = collegeHierarchy.courseFolder.id;
    course.driveFolderName = collegeHierarchy.courseFolder.name;
    course.driveFolderLink = collegeHierarchy.courseFolder.link;
    await course.save();
    syncStats.courseUpdated = true;
  }

  if (
    college
    && departmentHierarchy?.collegeFolder?.id
    && college.driveFolderId !== departmentHierarchy.collegeFolder.id
  ) {
    college.driveFolderId = departmentHierarchy.collegeFolder.id;
    college.driveFolderName = departmentHierarchy.collegeFolder.name;
    college.driveFolderLink = departmentHierarchy.collegeFolder.link;
    await college.save();
    syncStats.collegeUpdated = true;
  } else if (
    college
    && collegeHierarchy?.collegeFolder?.id
    && college.driveFolderId !== collegeHierarchy.collegeFolder.id
  ) {
    college.driveFolderId = collegeHierarchy.collegeFolder.id;
    college.driveFolderName = collegeHierarchy.collegeFolder.name;
    college.driveFolderLink = collegeHierarchy.collegeFolder.link;
    await college.save();
    syncStats.collegeUpdated = true;
  }

  if (department && departmentHierarchy?.departmentFolder?.id) {
    let shouldSaveDepartment = false;
    if (department.driveFolderId !== departmentHierarchy.departmentFolder.id) {
      department.driveFolderId = departmentHierarchy.departmentFolder.id;
      department.driveFolderName = departmentHierarchy.departmentFolder.name;
      department.driveFolderLink = departmentHierarchy.departmentFolder.link;
      shouldSaveDepartment = true;
      syncStats.departmentUpdated = true;
    }

    const dayFolders = toDepartmentDayFoldersLoader(departmentHierarchy?.dayFoldersByDayNumber || {});
    if (dayFolders.length) {
      department.dayFolders = dayFolders;
      shouldSaveDepartment = true;
      syncStats.dayFoldersUpdated = true;
    }

    if (shouldSaveDepartment) {
      await department.save();
    }
  }

  if (syncStats.companyUpdated || syncStats.courseUpdated || syncStats.collegeUpdated || syncStats.departmentUpdated || syncStats.dayFoldersUpdated) {
    logDriveTelemetry("info", {
      correlationId: syncCorrelationId,
      stage: "drive_hierarchy_metadata_synced",
      status: "metadata_sync",
      outcome: "succeeded",
      companyId: company?._id ? String(company._id) : null,
      courseId: course?._id ? String(course._id) : null,
      collegeId: college?._id ? String(college._id) : null,
      departmentId: department?._id ? String(department._id) : null,
    });
  }
};

const createResolveScheduleFolderFields = ({
  loadCompanyById = ({ companyId }) =>
    (companyId
      ? Company.findById(companyId).select("name driveFolderId driveFolderName driveFolderLink")
      : null),
  loadCourseById = ({ courseId }) =>
    (courseId
      ? Course.findById(courseId).select("title driveFolderId driveFolderName driveFolderLink")
      : null),
  loadCollegeById = ({ collegeId }) =>
    College.findById(collegeId).select("name companyId courseId driveFolderId driveFolderName driveFolderLink"),
  loadDepartmentById = ({ departmentId, select }) =>
    (departmentId ? Department.findById(departmentId).select(select) : null),
  ensureCollegeHierarchyLoader = ensureCollegeHierarchy,
  ensureDepartmentHierarchyLoader = ensureDepartmentHierarchy,
  isTrainingDriveEnabledLoader = isTrainingDriveEnabled,
  syncDriveHierarchyMetadataLoader = syncDriveHierarchyMetadata,
} = {}) =>
  async ({
    companyId,
    courseId,
    collegeId,
    departmentId,
    dayNumber,
    correlationId = null,
    fallbackFields = {},
  }) => {
    const resolveCorrelationId = correlationId || createCorrelationId("sched_drive_resolve");
    const normalizedDayNumber = toDayNumber(dayNumber);
    const isDriveEnabled = isTrainingDriveEnabledLoader();

    let dayEntry = null;
    if (departmentId && Number.isFinite(normalizedDayNumber)) {
      const department = await loadDepartmentById({
        departmentId,
        select: "dayFolders",
      });
      dayEntry = findDayFolderEntry(department?.dayFolders || [], normalizedDayNumber);
    }

    const defaultFields = buildScheduleFolderFields({
      dayEntry,
      fallbackDayFolderId: fallbackFields.dayFolderId || fallbackFields.driveFolderId,
      fallbackDayFolderName: fallbackFields.dayFolderName || fallbackFields.driveFolderName,
      fallbackDayFolderLink: fallbackFields.dayFolderLink || fallbackFields.driveFolderLink,
      fallbackAttendanceFolderId: fallbackFields.attendanceFolderId,
      fallbackAttendanceFolderName: fallbackFields.attendanceFolderName,
      fallbackAttendanceFolderLink: fallbackFields.attendanceFolderLink,
      fallbackGeoTagFolderId: fallbackFields.geoTagFolderId,
      fallbackGeoTagFolderName: fallbackFields.geoTagFolderName,
      fallbackGeoTagFolderLink: fallbackFields.geoTagFolderLink,
    });

    if (!isDriveEnabled || !collegeId || !Number.isFinite(normalizedDayNumber)) {
      logDriveTelemetry("debug", {
        correlationId: resolveCorrelationId,
        stage: "drive_folder_resolution_fallback",
        status: "resolve",
        outcome: "skipped",
        reason: !isDriveEnabled
          ? "drive_disabled"
          : !collegeId
            ? "missing_college_id"
            : "invalid_day_number",
        companyId: companyId ? String(companyId) : null,
        courseId: courseId ? String(courseId) : null,
        collegeId: collegeId ? String(collegeId) : null,
        departmentId: departmentId ? String(departmentId) : null,
        dayNumber: normalizedDayNumber,
      });
      return defaultFields;
    }

    const [company, course, college, department] = await Promise.all([
      loadCompanyById({ companyId }),
      loadCourseById({ courseId }),
      loadCollegeById({ collegeId }),
      loadDepartmentById({
        departmentId,
        select: "_id name companyId courseId collegeId driveFolderId driveFolderName driveFolderLink dayFolders",
      }),
    ]);

    if (!college) {
      return defaultFields;
    }

    let ensuredDayEntry = null;
    if (department?._id) {
      const companyRef = company || (
        department.companyId || college.companyId
          ? {
            _id: department.companyId || college.companyId,
            name: `Company_${department.companyId || college.companyId}`,
          }
          : null
      );
      const courseRef = course || null;

      if (!companyRef?._id) {
        return defaultFields;
      }

      const departmentHierarchy = await ensureDepartmentHierarchyLoader({
        company: companyRef,
        course: courseRef,
        college,
        department,
        totalDays: Math.max(12, normalizedDayNumber),
      });

      await syncDriveHierarchyMetadataLoader({
        company,
        course,
        college,
        department,
        correlationId: resolveCorrelationId,
        departmentHierarchy,
      });

      const ensuredDay = departmentHierarchy?.dayFoldersByDayNumber?.[normalizedDayNumber];
      if (ensuredDay?.id) {
        ensuredDayEntry = {
          folderId: ensuredDay.id,
          folderName: ensuredDay.name || null,
          folderLink: ensuredDay.link || null,
          attendanceFolderId: ensuredDay.attendanceFolder?.id || null,
          attendanceFolderName: ensuredDay.attendanceFolder?.name || null,
          attendanceFolderLink: ensuredDay.attendanceFolder?.link || null,
          geoTagFolderId: ensuredDay.geoTagFolder?.id || null,
          geoTagFolderName: ensuredDay.geoTagFolder?.name || null,
          geoTagFolderLink: ensuredDay.geoTagFolder?.link || null,
        };
      }
    } else if ((company || college.companyId) && normalizedDayNumber) {
      const companyRef = company || { _id: college.companyId, name: `Company_${college.companyId}` };
      const collegeHierarchy = await ensureCollegeHierarchyLoader({
        company: companyRef,
        course: course || null,
        college,
      });

      await syncDriveHierarchyMetadataLoader({
        company,
        course,
        college,
        correlationId: resolveCorrelationId,
        collegeHierarchy,
      });
    }

    return buildScheduleFolderFields({
      dayEntry: ensuredDayEntry || dayEntry,
      fallbackDayFolderId: defaultFields.dayFolderId,
      fallbackDayFolderName: defaultFields.dayFolderName,
      fallbackDayFolderLink: defaultFields.dayFolderLink,
      fallbackAttendanceFolderId: defaultFields.attendanceFolderId,
      fallbackAttendanceFolderName: defaultFields.attendanceFolderName,
      fallbackAttendanceFolderLink: defaultFields.attendanceFolderLink,
      fallbackGeoTagFolderId: defaultFields.geoTagFolderId,
      fallbackGeoTagFolderName: defaultFields.geoTagFolderName,
      fallbackGeoTagFolderLink: defaultFields.geoTagFolderLink,
    });
  };

const resolveScheduleFolderFields = createResolveScheduleFolderFields();

module.exports = {
  createResolveScheduleFolderFields,
  resolveScheduleFolderFields,
  syncDriveHierarchyMetadata,
};
