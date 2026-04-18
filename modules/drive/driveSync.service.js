const { Company, Course, College, Department, Schedule } = require("../../models");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");
const {
  createDriveSyncReconciliationSummary,
  createDriveSyncDryRunSummary,
  buildDepartmentDayFolderNormalizationPreview,
  applyDepartmentDayFolderDuplicateCleanup,
  appendNormalizationPreview,
  reconcileDepartmentSchedulesDriveEvidence,
} = require("./driveSyncReconciliation");
const {
  ensureCompanyHierarchy,
  ensureCourseHierarchy,
  ensureCollegeHierarchy,
  ensureDepartmentHierarchy,
  isTrainingDriveEnabled,
  toDepartmentDayFolders,
  listDriveFolderChildren,
  mergeDuplicateDriveFolders,
} = require("./driveGateway");

const driveSyncLogger = createStructuredLogger({
  service: "m-server",
  component: "drive-sync-service",
});

const buildSyncDbDependencies = (overrides = {}) => ({
  Company,
  Course,
  College,
  Department,
  Schedule,
  createDriveSyncReconciliationSummary,
  createDriveSyncDryRunSummary,
  buildDepartmentDayFolderNormalizationPreview,
  applyDepartmentDayFolderDuplicateCleanup,
  appendNormalizationPreview,
  reconcileDepartmentSchedulesDriveEvidence,
  ensureCompanyHierarchy,
  ensureCourseHierarchy,
  ensureCollegeHierarchy,
  ensureDepartmentHierarchy,
  isTrainingDriveEnabled,
  toDepartmentDayFolders,
  listDriveFolderChildren,
  mergeDuplicateDriveFolders,
  logDryRunAuditEvent: (payload) =>
    driveSyncLogger.info({
      event: "drive_sync_dry_run_executed",
      ...payload,
    }),
  ...overrides,
});

const applyDriveFolderFields = (doc, folder) => {
  if (!doc || !folder?.id) return false;

  const nextId = folder.id || null;
  const nextName = folder.name || null;
  const nextLink = folder.link || null;

  if (
    doc.driveFolderId === nextId &&
    doc.driveFolderName === nextName &&
    doc.driveFolderLink === nextLink
  ) {
    return false;
  }

  doc.driveFolderId = nextId;
  doc.driveFolderName = nextName;
  doc.driveFolderLink = nextLink;
  return true;
};

const buildScheduleFolderUpdate = (dayFolder) => ({
  dayFolderId: dayFolder?.id || null,
  dayFolderName: dayFolder?.name || null,
  dayFolderLink: dayFolder?.link || null,
  attendanceFolderId: dayFolder?.attendanceFolder?.id || null,
  attendanceFolderName: dayFolder?.attendanceFolder?.name || null,
  attendanceFolderLink: dayFolder?.attendanceFolder?.link || null,
  geoTagFolderId: dayFolder?.geoTagFolder?.id || null,
  geoTagFolderName: dayFolder?.geoTagFolder?.name || null,
  geoTagFolderLink: dayFolder?.geoTagFolder?.link || null,
  driveFolderId: dayFolder?.id || null,
  driveFolderName: dayFolder?.name || null,
  driveFolderLink: dayFolder?.link || null,
});

const buildCanonicalDepartmentDayFolders = ({ existingDayFolders = [], canonicalByDay = {} }) => {
  const byDay = new Map(
    (Array.isArray(existingDayFolders) ? existingDayFolders : []).map((entry) => [
      Number(entry?.day),
      entry || {},
    ]),
  );

  const canonicalDays = Object.entries(canonicalByDay || {}).filter(([day]) =>
    Number.isFinite(Number(day)),
  );
  if (!canonicalDays.length) {
    return {
      nextDayFolders: Array.isArray(existingDayFolders) ? existingDayFolders : [],
      changedCount: 0,
    };
  }

  let changedCount = 0;

  canonicalDays.forEach(([dayKey, canonical]) => {
    const dayNumber = Number(dayKey);
    const current = byDay.get(dayNumber) || {};
    const nextEntry = {
      ...current,
      day: dayNumber,
      folderId: canonical?.dayFolderId || current.folderId || null,
      folderName: canonical?.dayFolderName || current.folderName || null,
      folderLink: canonical?.dayFolderLink || current.folderLink || null,
      attendanceFolderId:
        canonical?.attendanceFolderId || current.attendanceFolderId || null,
      attendanceFolderName:
        canonical?.attendanceFolderName || current.attendanceFolderName || null,
      attendanceFolderLink:
        canonical?.attendanceFolderLink || current.attendanceFolderLink || null,
      geoTagFolderId: canonical?.geoTagFolderId || current.geoTagFolderId || null,
      geoTagFolderName: canonical?.geoTagFolderName || current.geoTagFolderName || null,
      geoTagFolderLink: canonical?.geoTagFolderLink || current.geoTagFolderLink || null,
    };

    const changed = [
      "folderId",
      "folderName",
      "folderLink",
      "attendanceFolderId",
      "attendanceFolderName",
      "attendanceFolderLink",
      "geoTagFolderId",
      "geoTagFolderName",
      "geoTagFolderLink",
    ].some((field) => (current?.[field] || null) !== (nextEntry?.[field] || null));

    if (changed) {
      changedCount += 1;
      byDay.set(dayNumber, nextEntry);
    }
  });

  return {
    nextDayFolders: Array.from(byDay.values()).sort(
      (left, right) => Number(left?.day || 0) - Number(right?.day || 0),
    ),
    changedCount,
    consideredCount: canonicalDays.length,
  };
};

const buildCanonicalScheduleFolderUpdates = ({ schedules = [], canonicalByDay = {} }) => {
  const updates = [];
  let changedCount = 0;
  let consideredCount = 0;

  schedules.forEach((schedule) => {
    const canonical = canonicalByDay?.[Number(schedule?.dayNumber)] || null;
    if (!canonical?.dayFolderId) return;
    consideredCount += 1;

    const nextFields = {
      dayFolderId: canonical.dayFolderId || null,
      dayFolderName: canonical.dayFolderName || schedule?.dayFolderName || null,
      dayFolderLink: canonical.dayFolderLink || schedule?.dayFolderLink || null,
      attendanceFolderId:
        canonical.attendanceFolderId || schedule?.attendanceFolderId || null,
      attendanceFolderName:
        canonical.attendanceFolderName || schedule?.attendanceFolderName || null,
      attendanceFolderLink:
        canonical.attendanceFolderLink || schedule?.attendanceFolderLink || null,
      geoTagFolderId: canonical.geoTagFolderId || schedule?.geoTagFolderId || null,
      geoTagFolderName: canonical.geoTagFolderName || schedule?.geoTagFolderName || null,
      geoTagFolderLink: canonical.geoTagFolderLink || schedule?.geoTagFolderLink || null,
      driveFolderId: canonical.dayFolderId || null,
      driveFolderName: canonical.dayFolderName || schedule?.driveFolderName || null,
      driveFolderLink: canonical.dayFolderLink || schedule?.driveFolderLink || null,
    };

    const changed = Object.entries(nextFields).some(
      ([key, value]) => (schedule?.[key] || null) !== (value || null),
    );
    if (!changed) return;

    changedCount += 1;
    updates.push({
      updateOne: {
        filter: { _id: schedule._id },
        update: { $set: nextFields },
      },
    });
  });

  return {
    updates,
    changedCount,
    consideredCount,
  };
};

const resolveDriveSyncErrorPayload = (error, fallbackMessage) => {
  const rawErrorMessage = String(error?.message || "").trim();
  const normalizedErrorMessage = rawErrorMessage.toLowerCase();

  if (normalizedErrorMessage.includes("invalid_grant")) {
    return {
      statusCode: 401,
      message:
        "Google Drive authorization expired. Reconnect Drive credentials and retry sync.",
      error: rawErrorMessage || fallbackMessage,
      errorCode: "DRIVE_INVALID_GRANT",
    };
  }

  if (error?.code === 403 || /permission/i.test(normalizedErrorMessage)) {
    return {
      statusCode: 403,
      message: rawErrorMessage || "Google Drive permission denied.",
      error: rawErrorMessage || fallbackMessage,
      errorCode: "DRIVE_PERMISSION_DENIED",
    };
  }

  return {
    statusCode: 500,
    message: fallbackMessage,
    error: rawErrorMessage || fallbackMessage,
    errorCode: "DRIVE_SYNC_FAILED",
  };
};

const executeSyncDb = async ({
  body = {},
  query = {},
  actor = {},
  correlationId = "",
  overrides = {},
} = {}) => {
  const deps = buildSyncDbDependencies(overrides);
  const { companyId, courseId, collegeId, departmentId, totalDays } = body || {};
  const dryRun = String(query?.dryRun || "")
    .trim()
    .toLowerCase() === "true";
  const normalizeDuplicates = String(query?.normalizeDuplicates || "")
    .trim()
    .toLowerCase() === "true";
  const canonicalMappingsOnly = String(query?.canonicalMappingsOnly || "")
    .trim()
    .toLowerCase() === "true";
  const resolvedCorrelationId = correlationId || createCorrelationId("drive_sync");

  if (!deps.isTrainingDriveEnabled()) {
    const error = new Error(
      "Google Drive training root folder is not configured. Set GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_ID or GOOGLE_DRIVE_TRAINING_PARENT_FOLDER_ID first.",
    );
    error.statusCode = 400;
    throw error;
  }

  const counts = {
    companiesSynced: 0,
    coursesSynced: 0,
    collegesSynced: 0,
    departmentsSynced: 0,
    schedulesUpdated: 0,
  };
  const dryRunScope = {
    companies: 0,
    courses: 0,
    colleges: 0,
    departments: 0,
    schedules: 0,
  };
  const reconciliation = dryRun
    ? deps.createDriveSyncDryRunSummary()
    : deps.createDriveSyncReconciliationSummary();
  const canonicalMappingSummary = {
    canonicalMappingsWouldChange: 0,
    canonicalMappingsUpdated: 0,
    ambiguousDaysSkipped: 0,
    unchanged: 0,
    warnings: [],
    errors: [],
  };

  const requestedDepartment = departmentId
    ? await deps.Department.findById(departmentId).select(
        "_id name companyId courseId collegeId driveFolderId driveFolderName driveFolderLink dayFolders",
      )
    : null;
  if (departmentId && !requestedDepartment) {
    const error = new Error("Department not found");
    error.statusCode = 404;
    throw error;
  }

  const requestedCollege = collegeId
    ? await deps.College.findById(collegeId).select(
        "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
      )
    : requestedDepartment?.collegeId
      ? await deps.College.findById(requestedDepartment.collegeId).select(
          "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
        )
      : null;
  if ((collegeId || requestedDepartment?.collegeId) && !requestedCollege) {
    const error = new Error("College not found");
    error.statusCode = 404;
    throw error;
  }

  const requestedCourse = courseId
    ? await deps.Course.findById(courseId).select(
        "_id title companyId driveFolderId driveFolderName driveFolderLink",
      )
    : requestedCollege?.courseId
      ? await deps.Course.findById(requestedCollege.courseId).select(
          "_id title companyId driveFolderId driveFolderName driveFolderLink",
        )
      : requestedDepartment?.courseId
        ? await deps.Course.findById(requestedDepartment.courseId).select(
            "_id title companyId driveFolderId driveFolderName driveFolderLink",
          )
        : null;
  if (courseId && !requestedCourse) {
    const error = new Error("Course not found");
    error.statusCode = 404;
    throw error;
  }

  const resolvedCompanyId =
    companyId ||
    requestedCourse?.companyId ||
    requestedCollege?.companyId ||
    requestedDepartment?.companyId ||
    null;

  const companies = resolvedCompanyId
    ? await deps.Company.find({ _id: resolvedCompanyId }).select(
        "_id name driveFolderId driveFolderName driveFolderLink",
      )
    : await deps.Company.find({}).select("_id name driveFolderId driveFolderName driveFolderLink");

  if (!companies.length) {
    const error = new Error("No companies found to sync");
    error.statusCode = 404;
    throw error;
  }

  for (const company of companies) {
    if (!dryRun && !canonicalMappingsOnly) {
      const companyHierarchy = await deps.ensureCompanyHierarchy({ company });
      if (applyDriveFolderFields(company, companyHierarchy?.companyFolder)) {
        await company.save();
      }
      counts.companiesSynced += 1;
    } else {
      dryRunScope.companies += 1;
    }

    const courseFilter = { companyId: company._id };
    if (requestedCourse?._id) {
      courseFilter._id = requestedCourse._id;
    }

    const courses = await deps.Course.find(courseFilter).select(
      "_id title companyId driveFolderId driveFolderName driveFolderLink",
    );
    const courseMap = new Map();

    for (const course of courses) {
      if (!dryRun && !canonicalMappingsOnly) {
        const courseHierarchy = await deps.ensureCourseHierarchy({ company, course });
        if (applyDriveFolderFields(company, courseHierarchy?.companyFolder)) {
          await company.save();
        }
        if (applyDriveFolderFields(course, courseHierarchy?.courseFolder)) {
          await course.save();
        }
        counts.coursesSynced += 1;
      } else {
        dryRunScope.courses += 1;
      }
      courseMap.set(String(course._id), course);
    }

    const collegeFilter = { companyId: company._id };
    if (requestedCollege?._id) {
      collegeFilter._id = requestedCollege._id;
    } else if (requestedCourse?._id) {
      collegeFilter.courseId = requestedCourse._id;
    }

    const colleges = await deps.College.find(collegeFilter).select(
      "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
    );

    for (const college of colleges) {
      const courseForCollege = college.courseId
        ? courseMap.get(String(college.courseId)) ||
          (await deps.Course.findById(college.courseId).select(
            "_id title companyId driveFolderId driveFolderName driveFolderLink",
          ))
        : null;

      if (courseForCollege && !courseMap.has(String(courseForCollege._id))) {
        courseMap.set(String(courseForCollege._id), courseForCollege);
      }

      if (!dryRun && !canonicalMappingsOnly) {
        const collegeHierarchy = await deps.ensureCollegeHierarchy({
          company,
          course: courseForCollege || null,
          college,
        });

        if (applyDriveFolderFields(company, collegeHierarchy?.companyFolder)) {
          await company.save();
        }

        if (
          courseForCollege &&
          applyDriveFolderFields(courseForCollege, collegeHierarchy?.courseFolder)
        ) {
          await courseForCollege.save();
        }

        if (applyDriveFolderFields(college, collegeHierarchy?.collegeFolder)) {
          await college.save();
        }
        counts.collegesSynced += 1;
      } else {
        dryRunScope.colleges += 1;
      }

      const departmentFilter = { collegeId: college._id };
      if (requestedDepartment?._id) {
        departmentFilter._id = requestedDepartment._id;
      }

      const departments = await deps.Department.find(departmentFilter).select(
        "_id name companyId courseId collegeId driveFolderId driveFolderName driveFolderLink dayFolders",
      );

      for (const department of departments) {
        if (dryRun) {
          dryRunScope.departments += 1;
        }
        const schedules = await deps.Schedule.find({ departmentId: department._id }).select(
          "_id trainerId dayNumber attendanceUploaded geoTagUploaded dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink",
        );
        if (dryRun) {
          dryRunScope.schedules += schedules.length;
        }

        let canonicalByDayForDepartment = {};
        let normalizationPreviewResult = null;
        if (dryRun || normalizeDuplicates || canonicalMappingsOnly) {
          normalizationPreviewResult =
            await deps.buildDepartmentDayFolderNormalizationPreview({
              department,
              schedules,
              listDriveFolderChildrenLoader: deps.listDriveFolderChildren,
            });
          canonicalByDayForDepartment =
            normalizationPreviewResult?.canonicalByDay || {};
          canonicalMappingSummary.ambiguousDaysSkipped += Number(
            normalizationPreviewResult?.preview?.ambiguousDayFolders || 0,
          );
          const previewWarnings = Array.isArray(normalizationPreviewResult?.preview?.warnings)
            ? normalizationPreviewResult.preview.warnings
            : [];
          if (previewWarnings.length) {
            canonicalMappingSummary.warnings.push(...previewWarnings);
          }
          deps.appendNormalizationPreview(
            reconciliation,
            normalizationPreviewResult?.preview,
          );
        }

        if (normalizeDuplicates || canonicalMappingsOnly) {
          const canonicalDepartmentDayFolders = buildCanonicalDepartmentDayFolders({
            existingDayFolders: department.dayFolders || [],
            canonicalByDay: canonicalByDayForDepartment,
          });
          const canonicalScheduleUpdates = buildCanonicalScheduleFolderUpdates({
            schedules,
            canonicalByDay: canonicalByDayForDepartment,
          });
          const canonicalChanges =
            Number(canonicalDepartmentDayFolders.changedCount || 0) +
            Number(canonicalScheduleUpdates.changedCount || 0);
          const consideredMappings =
            Number(canonicalDepartmentDayFolders.consideredCount || 0) +
            Number(canonicalScheduleUpdates.consideredCount || 0);
          const unchangedMappings = Math.max(0, consideredMappings - canonicalChanges);
          canonicalMappingSummary.unchanged += unchangedMappings;

          if (dryRun) {
            reconciliation.canonicalMappingsWouldChange =
              Number(reconciliation.canonicalMappingsWouldChange || 0) + canonicalChanges;
            canonicalMappingSummary.canonicalMappingsWouldChange += canonicalChanges;
          } else if (canonicalChanges > 0) {
            if (canonicalDepartmentDayFolders.changedCount > 0) {
              department.dayFolders = canonicalDepartmentDayFolders.nextDayFolders;
              await department.save();
            }
            if (canonicalScheduleUpdates.updates.length) {
              await deps.Schedule.bulkWrite(canonicalScheduleUpdates.updates, {
                ordered: false,
              });
              counts.schedulesUpdated += canonicalScheduleUpdates.updates.length;
            }
            reconciliation.canonicalMappingsUpdated =
              Number(reconciliation.canonicalMappingsUpdated || 0) + canonicalChanges;
            canonicalMappingSummary.canonicalMappingsUpdated += canonicalChanges;
          }
        }

        if (normalizeDuplicates && !canonicalMappingsOnly) {
          await deps.applyDepartmentDayFolderDuplicateCleanup?.({
            department,
            schedules,
            summary: reconciliation,
            dryRun,
            preview: normalizationPreviewResult?.preview || null,
            canonicalByDay: normalizationPreviewResult?.canonicalByDay || null,
            listDriveFolderChildrenLoader: deps.listDriveFolderChildren,
            mergeDuplicateDriveFoldersLoader: deps.mergeDuplicateDriveFolders,
          });
        }

        let schedulesForReconciliation = schedules;

        if (!dryRun && !canonicalMappingsOnly) {
          const maxScheduleDay = schedules.reduce(
            (maxDay, schedule) => Math.max(maxDay, Number(schedule.dayNumber) || 0),
            0,
          );
          const normalizedTotalDays = Math.max(
            Number(totalDays) || 0,
            maxScheduleDay,
            12,
          );

          const departmentHierarchy = await deps.ensureDepartmentHierarchy({
            company,
            course: courseForCollege || null,
            college,
            department,
            totalDays: normalizedTotalDays,
          });

          if (applyDriveFolderFields(company, departmentHierarchy?.companyFolder)) {
            await company.save();
          }

          if (
            courseForCollege &&
            applyDriveFolderFields(courseForCollege, departmentHierarchy?.courseFolder)
          ) {
            await courseForCollege.save();
          }

          if (applyDriveFolderFields(college, departmentHierarchy?.collegeFolder)) {
            await college.save();
          }

          let shouldSaveDepartment = false;
          if (applyDriveFolderFields(department, departmentHierarchy?.departmentFolder)) {
            shouldSaveDepartment = true;
          }

          const dayFolders = deps.toDepartmentDayFolders(
            departmentHierarchy?.dayFoldersByDayNumber || {},
          );
          if (JSON.stringify(department.dayFolders || []) !== JSON.stringify(dayFolders)) {
            department.dayFolders = dayFolders;
            shouldSaveDepartment = true;
          }

          if (shouldSaveDepartment) {
            await department.save();
          }
          counts.departmentsSynced += 1;

          const scheduleUpdates = schedules
            .map((schedule) => {
              const dayFolder =
                departmentHierarchy?.dayFoldersByDayNumber?.[schedule.dayNumber] || null;
              if (!dayFolder?.id) return null;

              const nextFields = buildScheduleFolderUpdate(dayFolder);
              const changed = Object.entries(nextFields).some(
                ([key, value]) => schedule[key] !== value,
              );
              if (!changed) return null;

              return {
                updateOne: {
                  filter: { _id: schedule._id },
                  update: { $set: nextFields },
                },
              };
            })
            .filter(Boolean);

          if (scheduleUpdates.length) {
            await deps.Schedule.bulkWrite(scheduleUpdates, { ordered: false });
            counts.schedulesUpdated += scheduleUpdates.length;
          }

          schedulesForReconciliation = await deps.Schedule.find({
            departmentId: department._id,
          }).select(
            "_id trainerId dayNumber attendanceUploaded geoTagUploaded dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink",
          );

          canonicalByDayForDepartment = Object.entries(
            departmentHierarchy?.dayFoldersByDayNumber || {},
          ).reduce((acc, [day, folderMeta]) => {
            const dayNumber = Number(day);
            if (!Number.isFinite(dayNumber) || dayNumber <= 0) return acc;
            acc[dayNumber] = {
              dayFolderId: folderMeta?.id || null,
              dayFolderName: folderMeta?.name || null,
              attendanceFolderId: folderMeta?.attendanceFolder?.id || null,
              attendanceFolderName: folderMeta?.attendanceFolder?.name || null,
              geoTagFolderId: folderMeta?.geoTagFolder?.id || null,
              geoTagFolderName: folderMeta?.geoTagFolder?.name || null,
            };
            return acc;
          }, {});
        }

        if (!canonicalMappingsOnly) {
          const schedulesWithCanonicalHints = schedulesForReconciliation.map((schedule) => {
            const canonical = canonicalByDayForDepartment?.[Number(schedule?.dayNumber)] || null;
            if (!canonical) return schedule;
            const scheduleObject =
              schedule && typeof schedule.toObject === "function"
                ? schedule.toObject()
                : schedule;
            return {
              ...scheduleObject,
              canonicalDayFolderId: canonical.dayFolderId || null,
              canonicalAttendanceFolderId: canonical.attendanceFolderId || null,
              canonicalGeoTagFolderId: canonical.geoTagFolderId || null,
            };
          });

          await deps.reconcileDepartmentSchedulesDriveEvidence({
            schedules: schedulesWithCanonicalHints,
            summary: reconciliation,
            dryRun,
          });
        }
      }
    }
  }

  if (dryRun) {
    try {
      deps.logDryRunAuditEvent?.({
        correlationId: resolvedCorrelationId,
        dryRun: true,
        actor: {
          userId: actor?.id || actor?._id || null,
          role: actor?.role || actor?.userType || null,
        },
        scope: {
          requested: {
            companyId: companyId || null,
            courseId: courseId || null,
            collegeId: collegeId || null,
            departmentId: departmentId || null,
            normalizeDuplicates,
          },
          analyzed: dryRunScope,
        },
        summary: {
          totalScanned: Number(reconciliation?.totalScanned || 0),
          candidateMatches: Number(reconciliation?.candidateMatches || 0),
          attendanceWouldBackfill: Number(
            reconciliation?.attendanceWouldBackfill || 0,
          ),
          geoWouldBackfill: Number(reconciliation?.geoWouldBackfill || 0),
          refreshedLinksWouldChange: Number(
            reconciliation?.refreshedLinksWouldChange || 0,
          ),
          skippedAmbiguous: Number(reconciliation?.skippedAmbiguous || 0),
          unchanged: Number(reconciliation?.unchanged || 0),
          normalization: reconciliation?.normalization || null,
          warnings: Array.isArray(reconciliation?.warnings)
            ? reconciliation.warnings
            : [],
          errors: Array.isArray(reconciliation?.errors)
            ? reconciliation.errors
            : [],
        },
      });
    } catch (auditError) {
      driveSyncLogger.warn({
        event: "drive_sync_dry_run_audit_log_failed",
        correlationId: resolvedCorrelationId,
        reason: auditError?.message || "unknown_audit_log_failure",
      });
    }
  }

  return {
    dryRun,
    normalizeDuplicates,
    canonicalMappingsOnly,
    counts,
    dryRunScope,
    reconciliation,
    canonicalMapping: canonicalMappingSummary,
  };
};

module.exports = {
  executeSyncDb,
  buildSyncDbDependencies,
  resolveDriveSyncErrorPayload,
  buildScheduleFolderUpdate,
};

