const {
  Company,
  Course,
  College,
  Department,
  Schedule,
} = require("../models");
const {
  ensureCompanyHierarchy,
  ensureCourseHierarchy,
  ensureCollegeHierarchy,
  ensureDepartmentHierarchy,
  isTrainingDriveEnabled,
  toDepartmentDayFolders,
} = require("./googleDriveTrainingHierarchyService");

const DEFAULT_DAY_COUNT = Math.max(
  1,
  Number.parseInt(process.env.TRAINING_DEFAULT_DAY_COUNT || "12", 10) || 12,
);

const DEFAULT_DAY_START_TIME = String(
  process.env.TRAINING_DEFAULT_DAY_START_TIME || "09:00",
).trim();

const DEFAULT_DAY_END_TIME = String(
  process.env.TRAINING_DEFAULT_DAY_END_TIME || "17:00",
).trim();

const toId = (value) => String(value || "").trim();

const buildDriveFolderLink = (folderId) =>
  folderId ? `https://drive.google.com/drive/folders/${folderId}` : null;

const applyDriveFolderFields = (doc, folder) => {
  if (!doc || !folder?.id) return false;

  const nextValues = {
    driveFolderId: folder.id || null,
    driveFolderName: folder.name || null,
    driveFolderLink: folder.link || buildDriveFolderLink(folder.id),
  };

  const changed = Object.entries(nextValues).some(
    ([key, value]) => doc[key] !== value,
  );

  if (!changed) return false;
  Object.assign(doc, nextValues);
  return true;
};

const buildScheduleFolderUpdate = (dayFolder) => ({
  dayFolderId: dayFolder?.id || null,
  dayFolderName: dayFolder?.name || null,
  dayFolderLink: dayFolder?.link || buildDriveFolderLink(dayFolder?.id),
  attendanceFolderId: dayFolder?.attendanceFolder?.id || null,
  attendanceFolderName: dayFolder?.attendanceFolder?.name || null,
  attendanceFolderLink:
    dayFolder?.attendanceFolder?.link ||
    buildDriveFolderLink(dayFolder?.attendanceFolder?.id),
  geoTagFolderId: dayFolder?.geoTagFolder?.id || null,
  geoTagFolderName: dayFolder?.geoTagFolder?.name || null,
  geoTagFolderLink:
    dayFolder?.geoTagFolder?.link ||
    buildDriveFolderLink(dayFolder?.geoTagFolder?.id),
  driveFolderId: dayFolder?.id || null,
  driveFolderName: dayFolder?.name || null,
  driveFolderLink: dayFolder?.link || buildDriveFolderLink(dayFolder?.id),
});

const applyScheduleFolderUpdate = (schedule, dayFolder) => {
  const nextValues = buildScheduleFolderUpdate(dayFolder);
  const changed = Object.entries(nextValues).some(
    ([key, value]) => schedule[key] !== value,
  );

  if (!changed) return false;
  Object.assign(schedule, nextValues);
  return true;
};

const saveIfModified = async (doc) => {
  if (!doc || !doc.isModified || !doc.isModified()) return false;
  await doc.save();
  return true;
};

const buildLegacyBatchFolderName = ({ schedule, college, course }) => {
  const collegeName = String(college?.name || "").trim();
  const courseName = String(course?.title || "").trim();

  if (collegeName && courseName) return `${collegeName}-${courseName}`;
  if (collegeName) return `Batch_${collegeName}`;
  return `Batch_${schedule?._id || "LEGACY"}`;
};

const shouldUseLegacyScheduleFallback = (error) => {
  const message = String(error?.message || "").trim().toLowerCase();
  return [
    "schedule is missing departmentid",
    "department not found",
    "college not found for department",
    "company not found for department",
  ].includes(message);
};

const ensureLegacyScheduleFolderState = async ({ schedule }) => {
  if (!schedule?.collegeId) {
    throw new Error("Legacy schedule is missing collegeId");
  }

  const college = await College.findById(schedule.collegeId).select(
    "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
  );
  if (!college) {
    throw new Error("College not found for legacy schedule");
  }

  const companyId = schedule.companyId || college.companyId || null;
  const courseId = schedule.courseId || college.courseId || null;

  if (!companyId) {
    throw new Error("Legacy schedule is missing companyId");
  }

  const companyDoc = await Company.findById(companyId).select(
    "_id name driveFolderId driveFolderName driveFolderLink",
  );
  const company =
    companyDoc ||
    {
      _id: companyId,
      name: `Company_${companyId}`,
      driveFolderId: null,
      driveFolderName: null,
      driveFolderLink: null,
    };

  const courseDoc = courseId
    ? await Course.findById(courseId).select(
        "_id title companyId driveFolderId driveFolderName driveFolderLink",
      )
    : null;
  const course =
    courseDoc ||
    (courseId
      ? {
          _id: courseId,
          title: `Course_${courseId}`,
          companyId,
          driveFolderId: null,
          driveFolderName: null,
          driveFolderLink: null,
        }
      : null);

  const hierarchy = await ensureDepartmentHierarchy({
    company,
    course,
    college,
    batch: buildLegacyBatchFolderName({ schedule, college, course }),
    totalDays: Math.max(DEFAULT_DAY_COUNT, Number(schedule.dayNumber) || 0),
  });

  const dayFolder = hierarchy?.dayFoldersByDayNumber?.[Number(schedule.dayNumber)];
  if (!dayFolder?.id) {
    throw new Error("Legacy schedule day folder could not be resolved");
  }

  applyDriveFolderFields(company, hierarchy?.companyFolder);
  if (course) applyDriveFolderFields(course, hierarchy?.courseFolder);
  applyDriveFolderFields(college, hierarchy?.collegeFolder);
  await saveIfModified(companyDoc);
  await saveIfModified(courseDoc);
  await saveIfModified(college);

  if (applyScheduleFolderUpdate(schedule, dayFolder)) {
    await schedule.save();
  }

  return {
    schedule,
    folderState: buildScheduleFolderUpdate(dayFolder),
    syncSummary: {
      scope: "legacy-schedule-fallback",
    },
  };
};

const loadHierarchyContextForDepartment = async (departmentId) => {
  const department = await Department.findById(departmentId).select(
    "_id name companyId courseId collegeId driveFolderId driveFolderName driveFolderLink dayFolders",
  );
  if (!department) {
    throw new Error("Department not found");
  }

  const college = await College.findById(department.collegeId).select(
    "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
  );
  if (!college) {
    throw new Error("College not found for department");
  }

  const companyId = department.companyId || college.companyId || null;
  const courseId = department.courseId || college.courseId || null;

  const company = companyId
    ? await Company.findById(companyId).select(
        "_id name driveFolderId driveFolderName driveFolderLink",
      )
    : null;

  if (!company) {
    throw new Error("Company not found for department");
  }

  const course = courseId
    ? await Course.findById(courseId).select(
        "_id title companyId driveFolderId driveFolderName driveFolderLink",
      )
    : null;

  return { company, course, college, department };
};

const syncCompanyTrainingFolder = async ({ companyId, company = null } = {}) => {
  if (!isTrainingDriveEnabled()) {
    return null;
  }

  const companyDoc =
    company || (companyId ? await Company.findById(companyId) : null);
  if (!companyDoc) {
    throw new Error("Company not found");
  }

  const hierarchy = await ensureCompanyHierarchy({ company: companyDoc });
  applyDriveFolderFields(companyDoc, hierarchy?.companyFolder);
  await saveIfModified(companyDoc);

  return {
    company: companyDoc,
    folders: hierarchy,
  };
};

const syncCourseTrainingFolder = async ({ courseId, course = null } = {}) => {
  if (!isTrainingDriveEnabled()) {
    return null;
  }

  const courseDoc =
    course ||
    (courseId
      ? await Course.findById(courseId).select(
          "_id title companyId driveFolderId driveFolderName driveFolderLink",
        )
      : null);
  if (!courseDoc) {
    throw new Error("Course not found");
  }

  const company = await Company.findById(courseDoc.companyId).select(
    "_id name driveFolderId driveFolderName driveFolderLink",
  );
  if (!company) {
    throw new Error("Company not found for course");
  }

  const hierarchy = await ensureCourseHierarchy({ company, course: courseDoc });
  applyDriveFolderFields(company, hierarchy?.companyFolder);
  applyDriveFolderFields(courseDoc, hierarchy?.courseFolder);
  await saveIfModified(company);
  await saveIfModified(courseDoc);

  return {
    company,
    course: courseDoc,
    folders: hierarchy,
  };
};

const syncCollegeTrainingFolder = async ({ collegeId, college = null } = {}) => {
  if (!isTrainingDriveEnabled()) {
    return null;
  }

  const collegeDoc =
    college ||
    (collegeId
      ? await College.findById(collegeId).select(
          "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
        )
      : null);
  if (!collegeDoc) {
    throw new Error("College not found");
  }

  const company = await Company.findById(collegeDoc.companyId).select(
    "_id name driveFolderId driveFolderName driveFolderLink",
  );
  if (!company) {
    throw new Error("Company not found for college");
  }

  const course = collegeDoc.courseId
    ? await Course.findById(collegeDoc.courseId).select(
        "_id title companyId driveFolderId driveFolderName driveFolderLink",
      )
    : null;

  const hierarchy = await ensureCollegeHierarchy({
    company,
    course,
    college: collegeDoc,
  });

  applyDriveFolderFields(company, hierarchy?.companyFolder);
  if (course) applyDriveFolderFields(course, hierarchy?.courseFolder);
  applyDriveFolderFields(collegeDoc, hierarchy?.collegeFolder);
  await saveIfModified(company);
  await saveIfModified(course);
  await saveIfModified(collegeDoc);

  return {
    company,
    course,
    college: collegeDoc,
    folders: hierarchy,
  };
};

const syncDepartmentTrainingFolder = async ({
  departmentId,
  totalDays = DEFAULT_DAY_COUNT,
  createMissingSchedules = false,
  defaultStartTime = DEFAULT_DAY_START_TIME,
  defaultEndTime = DEFAULT_DAY_END_TIME,
  createdBy = null,
} = {}) => {
  if (!isTrainingDriveEnabled()) {
    return null;
  }

  const { company, course, college, department } =
    await loadHierarchyContextForDepartment(departmentId);

  const hierarchy = await ensureDepartmentHierarchy({
    company,
    course,
    college,
    department,
    totalDays,
  });

  applyDriveFolderFields(company, hierarchy?.companyFolder);
  if (course) applyDriveFolderFields(course, hierarchy?.courseFolder);
  applyDriveFolderFields(college, hierarchy?.collegeFolder);
  applyDriveFolderFields(department, hierarchy?.departmentFolder);

  const dayFolders = toDepartmentDayFolders(hierarchy?.dayFoldersByDayNumber || {});
  if (dayFolders.length) {
    department.dayFolders = dayFolders;
  }

  await saveIfModified(company);
  await saveIfModified(course);
  await saveIfModified(college);
  await saveIfModified(department);

  const existingSchedules = await Schedule.find({
    departmentId: department._id,
  }).sort({ dayNumber: 1 });
  const scheduleByDay = new Map(
    existingSchedules.map((item) => [Number(item.dayNumber), item]),
  );

  const changedSchedules = [];
  const createdSchedules = [];
  const safeDays = Math.max(1, Number(totalDays) || DEFAULT_DAY_COUNT);

  for (let dayNumber = 1; dayNumber <= safeDays; dayNumber += 1) {
    const dayFolder = hierarchy?.dayFoldersByDayNumber?.[dayNumber];
    if (!dayFolder?.id) continue;

    const schedule = scheduleByDay.get(dayNumber);
    if (schedule) {
      if (applyScheduleFolderUpdate(schedule, dayFolder)) {
        await schedule.save();
        changedSchedules.push(schedule._id);
      }
      continue;
    }

    if (!createMissingSchedules) continue;

    const newSchedule = await Schedule.create({
      trainerId: null,
      companyId: company._id,
      courseId: course?._id || null,
      collegeId: college._id,
      departmentId: department._id,
      dayNumber,
      startTime: defaultStartTime,
      endTime: defaultEndTime,
      status: "scheduled",
      createdBy,
      attendanceUploaded: false,
      geoTagUploaded: false,
      dayStatus: "not_assigned",
      ...buildScheduleFolderUpdate(dayFolder),
    });

    createdSchedules.push(newSchedule._id);
    scheduleByDay.set(dayNumber, newSchedule);
  }

  return {
    company,
    course,
    college,
    department,
    folders: hierarchy,
    summary: {
      totalDays: safeDays,
      schedulesUpdated: changedSchedules.length,
      schedulesCreated: createdSchedules.length,
      changedScheduleIds: changedSchedules,
      createdScheduleIds: createdSchedules,
    },
  };
};

const ensureScheduleFolderState = async ({ scheduleId } = {}) => {
  if (!scheduleId) {
    throw new Error("scheduleId is required");
  }

  const schedule = await Schedule.findById(scheduleId).select(
    "_id companyId courseId collegeId departmentId dayNumber driveFolderId driveFolderName driveFolderLink dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink startTime endTime",
  );

  if (!schedule) {
    throw new Error("Schedule not found");
  }

  if (
    schedule.dayFolderId &&
    schedule.attendanceFolderId &&
    schedule.geoTagFolderId
  ) {
    return {
      schedule,
      folderState: buildScheduleFolderUpdate({
        id: schedule.dayFolderId || schedule.driveFolderId,
        name: schedule.dayFolderName || schedule.driveFolderName,
        link: schedule.dayFolderLink || schedule.driveFolderLink,
        attendanceFolder: {
          id: schedule.attendanceFolderId,
          name: schedule.attendanceFolderName,
          link: schedule.attendanceFolderLink,
        },
        geoTagFolder: {
          id: schedule.geoTagFolderId,
          name: schedule.geoTagFolderName,
          link: schedule.geoTagFolderLink,
        },
      }),
    };
  }

  let result = null;
  if (!schedule.departmentId) {
    return ensureLegacyScheduleFolderState({ schedule });
  }

  try {
    result = await syncDepartmentTrainingFolder({
      departmentId: schedule.departmentId,
      totalDays: Math.max(DEFAULT_DAY_COUNT, Number(schedule.dayNumber) || 0),
      createMissingSchedules: false,
    });
  } catch (error) {
    if (!shouldUseLegacyScheduleFallback(error)) {
      throw error;
    }
    return ensureLegacyScheduleFolderState({ schedule });
  }

  const refreshedSchedule = await Schedule.findById(scheduleId).select(
    "_id companyId courseId collegeId departmentId dayNumber driveFolderId driveFolderName driveFolderLink dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink startTime endTime",
  );

  return {
    schedule: refreshedSchedule,
    folderState: {
      dayFolderId: refreshedSchedule?.dayFolderId || null,
      dayFolderName: refreshedSchedule?.dayFolderName || null,
      dayFolderLink:
        refreshedSchedule?.dayFolderLink ||
        buildDriveFolderLink(refreshedSchedule?.dayFolderId),
      attendanceFolderId: refreshedSchedule?.attendanceFolderId || null,
      attendanceFolderName: refreshedSchedule?.attendanceFolderName || null,
      attendanceFolderLink:
        refreshedSchedule?.attendanceFolderLink ||
        buildDriveFolderLink(refreshedSchedule?.attendanceFolderId),
      geoTagFolderId: refreshedSchedule?.geoTagFolderId || null,
      geoTagFolderName: refreshedSchedule?.geoTagFolderName || null,
      geoTagFolderLink:
        refreshedSchedule?.geoTagFolderLink ||
        buildDriveFolderLink(refreshedSchedule?.geoTagFolderId),
      driveFolderId: refreshedSchedule?.driveFolderId || null,
      driveFolderName: refreshedSchedule?.driveFolderName || null,
      driveFolderLink:
        refreshedSchedule?.driveFolderLink ||
        buildDriveFolderLink(refreshedSchedule?.driveFolderId),
    },
    syncSummary: result?.summary || null,
  };
};

const syncTrainingHierarchyByIds = async ({
  companyId = null,
  courseId = null,
  collegeId = null,
  departmentId = null,
  totalDays = DEFAULT_DAY_COUNT,
  createMissingSchedules = false,
  createdBy = null,
} = {}) => {
  if (!isTrainingDriveEnabled()) {
    throw new Error("Google Drive training root folder is not configured");
  }

  if (departmentId) {
    const departmentResult = await syncDepartmentTrainingFolder({
      departmentId,
      totalDays,
      createMissingSchedules,
      createdBy,
    });

    return {
      scope: "department",
      result: departmentResult,
    };
  }

  if (collegeId) {
    const departments = await Department.find({ collegeId }).select("_id");
    const results = [];
    for (const department of departments) {
      results.push(
        await syncDepartmentTrainingFolder({
          departmentId: department._id,
          totalDays,
          createMissingSchedules,
          createdBy,
        }),
      );
    }

    return {
      scope: "college",
      count: results.length,
      results,
    };
  }

  if (courseId) {
    const colleges = await College.find({ courseId }).select("_id");
    const results = [];
    for (const college of colleges) {
      const collegeResult = await syncTrainingHierarchyByIds({
        collegeId: college._id,
        totalDays,
        createMissingSchedules,
        createdBy,
      });
      results.push(collegeResult);
    }

    return {
      scope: "course",
      count: results.length,
      results,
    };
  }

  if (companyId) {
    const courses = await Course.find({ companyId }).select("_id");
    const results = [];
    for (const course of courses) {
      const courseResult = await syncTrainingHierarchyByIds({
        courseId: course._id,
        totalDays,
        createMissingSchedules,
        createdBy,
      });
      results.push(courseResult);
    }

    return {
      scope: "company",
      count: results.length,
      results,
    };
  }

  throw new Error(
    "Provide one of companyId, courseId, collegeId, or departmentId",
  );
};

module.exports = {
  DEFAULT_DAY_COUNT,
  DEFAULT_DAY_START_TIME,
  DEFAULT_DAY_END_TIME,
  buildDriveFolderLink,
  buildScheduleFolderUpdate,
  syncCompanyTrainingFolder,
  syncCourseTrainingFolder,
  syncCollegeTrainingFolder,
  syncDepartmentTrainingFolder,
  ensureScheduleFolderState,
  syncTrainingHierarchyByIds,
};
