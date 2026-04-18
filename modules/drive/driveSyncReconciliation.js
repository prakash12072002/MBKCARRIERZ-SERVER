const mongoose = require("mongoose");
const { Attendance, Schedule, ScheduleDocument } = require("../../models");
const { listDriveFolderChildren } = require("./driveGateway");
const {
  normalizeDocumentType,
  inferDocumentTypeFromMixedFile,
  pickAttendanceBackfillField,
} = require("./driveFileClassifier");
const {
  toEpochMillis,
  parseDayNumberFromFolderName,
  isAttendanceFolderName,
  isGeoTagFolderName,
  isLegacyCheckoutFolderName,
} = require("./driveNormalization");

const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DRIVE_SYNC_MAX_ERROR_DETAILS = 25;
const DRIVE_SYNC_MAX_NORMALIZATION_DEPARTMENTS = 15;

const toObjectIdOrNull = (value) => {
  if (!value) return null;
  return mongoose.Types.ObjectId.isValid(value) ? value : null;
};

const toDriveViewUrl = (fileId) =>
  fileId ? `https://drive.google.com/uc?export=view&id=${fileId}` : null;

const pushSummaryError = (summary, message) => {
  if (!summary || !message) return;
  if (!Array.isArray(summary.errors)) {
    summary.errors = [];
  }
  if (summary.errors.length >= DRIVE_SYNC_MAX_ERROR_DETAILS) return;
  summary.errors.push(String(message));
};

const pushSummaryWarning = (summary, message) => {
  if (!summary || !message) return;
  if (!Array.isArray(summary.warnings)) return;
  if (summary.warnings.length >= DRIVE_SYNC_MAX_ERROR_DETAILS) return;
  summary.warnings.push(String(message));
};

const createDriveSyncNormalizationSummary = () => ({
  departmentsAnalyzed: 0,
  dayFoldersDetected: 0,
  duplicateDayFolders: 0,
  canonicalDayFolders: 0,
  ambiguousDayFolders: 0,
  filesMatchedSafely: 0,
  proposedActions: {
    keep: 0,
    link: 0,
    move: 0,
    skip: 0,
  },
  departments: [],
});

const createDriveSyncReconciliationSummary = () => ({
  totalScanned: 0,
  attendanceBackfilled: 0,
  geoTagBackfilled: 0,
  refreshedLinks: 0,
  duplicateDayFoldersCleared: 0,
  canonicalMappingsUpdated: 0,
  skippedAmbiguous: 0,
  unchanged: 0,
  schedulesReconciled: 0,
  errors: [],
});

const createDriveSyncDryRunSummary = () => ({
  totalScanned: 0,
  candidateMatches: 0,
  attendanceWouldBackfill: 0,
  geoWouldBackfill: 0,
  refreshedLinksWouldChange: 0,
  duplicateDayFoldersWouldClear: 0,
  canonicalMappingsWouldChange: 0,
  skippedAmbiguous: 0,
  unchanged: 0,
  schedulesReconciled: 0,
  normalization: createDriveSyncNormalizationSummary(),
  warnings: [],
  errors: [],
});

const incrementRefreshedLinks = ({ summary, dryRun, count = 1 }) => {
  if (!summary || !Number.isFinite(count) || count <= 0) return;
  if (dryRun) {
    summary.refreshedLinksWouldChange = Number(summary.refreshedLinksWouldChange || 0) + count;
    return;
  }
  summary.refreshedLinks = Number(summary.refreshedLinks || 0) + count;
};

const incrementAttendanceBackfill = ({ summary, dryRun, count = 1 }) => {
  if (!summary || !Number.isFinite(count) || count <= 0) return;
  if (dryRun) {
    summary.attendanceWouldBackfill = Number(summary.attendanceWouldBackfill || 0) + count;
    return;
  }
  summary.attendanceBackfilled = Number(summary.attendanceBackfilled || 0) + count;
};

const incrementGeoTagBackfill = ({ summary, dryRun, count = 1 }) => {
  if (!summary || !Number.isFinite(count) || count <= 0) return;
  if (dryRun) {
    summary.geoWouldBackfill = Number(summary.geoWouldBackfill || 0) + count;
    return;
  }
  summary.geoTagBackfilled = Number(summary.geoTagBackfilled || 0) + count;
};

const mergeDriveAssetEntries = (existingEntries = [], discoveredEntries = []) => {
  const byKey = new Map();
  const appendEntry = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const fileId = String(entry.fileId || "").trim();
    const fileType = String(entry.fileType || "").trim().toLowerCase() || "other";
    const fileName = String(entry.fileName || "").trim();
    const fileUrl = String(entry.fileUrl || "").trim();
    const key = fileId || [fileType, fileName, fileUrl].join("|");
    if (!key) return;

    if (!byKey.has(key)) {
      byKey.set(key, {
        fileId: fileId || null,
        fileName: fileName || null,
        fileUrl: fileUrl || null,
        webViewLink: String(entry.webViewLink || "").trim() || null,
        downloadLink: String(entry.downloadLink || "").trim() || null,
        fileType,
      });
      return;
    }

    const current = byKey.get(key);
    if (!current.fileUrl && fileUrl) current.fileUrl = fileUrl;
    if (!current.webViewLink && entry.webViewLink) current.webViewLink = entry.webViewLink;
    if (!current.downloadLink && entry.downloadLink) current.downloadLink = entry.downloadLink;
    if (!current.fileName && fileName) current.fileName = fileName;
    if (!current.fileId && fileId) current.fileId = fileId;
  };

  existingEntries.forEach(appendEntry);
  discoveredEntries.forEach(appendEntry);

  return Array.from(byKey.values());
};

const toDiscoveredDocument = ({ file, fileType }) => {
  const fileId = String(file?.id || "").trim();
  if (!fileId) return null;

  const webViewLink = String(file?.webViewLink || "").trim() || null;
  const fileUrl = webViewLink || toDriveViewUrl(fileId);

  return {
    driveFileId: fileId,
    fileName: String(file?.name || "").trim() || null,
    fileUrl,
    webViewLink,
    downloadLink: fileId ? `https://drive.google.com/uc?id=${fileId}&export=download` : null,
    fileType: normalizeDocumentType(fileType),
  };
};

const listDriveFiles = async ({ folderId }) => {
  if (!folderId) return [];
  const children = await listDriveFolderChildren({ folderId });
  return children.filter(
    (item) =>
      item &&
      item.id &&
      String(item.mimeType || "").trim().toLowerCase() !== DRIVE_FOLDER_MIME_TYPE,
  );
};

const buildScanFolderCandidates = ({ schedule, attendance }) => {
  const byFolderId = new Map();
  const typeRank = {
    mixed: 1,
    attendance: 2,
    geotag: 2,
    canonical_day: 3,
    canonical_attendance: 4,
    canonical_geotag: 4,
  };
  const appendCandidate = (folderId, sourceType) => {
    const normalizedId = String(folderId || "").trim();
    if (!normalizedId) return;
    const existing = byFolderId.get(normalizedId);
    if (!existing) {
      byFolderId.set(normalizedId, { folderId: normalizedId, sourceType });
      return;
    }

    if ((typeRank[sourceType] || 0) > (typeRank[existing.sourceType] || 0)) {
      byFolderId.set(normalizedId, { folderId: normalizedId, sourceType });
    }
  };

  appendCandidate(schedule?.canonicalAttendanceFolderId, "canonical_attendance");
  appendCandidate(schedule?.canonicalGeoTagFolderId, "canonical_geotag");
  appendCandidate(schedule?.canonicalDayFolderId, "canonical_day");

  appendCandidate(schedule?.attendanceFolderId, "attendance");
  appendCandidate(schedule?.geoTagFolderId, "geotag");
  appendCandidate(schedule?.dayFolderId || schedule?.driveFolderId, "mixed");
  appendCandidate(attendance?.driveFolderId, "mixed");
  appendCandidate(attendance?.driveAssets?.folderIds?.attendance, "attendance");
  appendCandidate(attendance?.driveAssets?.folderIds?.geoTag, "geotag");
  appendCandidate(attendance?.driveAssets?.folderIds?.day, "mixed");

  return Array.from(byFolderId.values());
};

const inferFileTypeForSource = ({ file, sourceType }) => {
  if (sourceType === "attendance") return "attendance";
  if (sourceType === "geotag") return "geotag";
  if (sourceType === "canonical_attendance") return "attendance";
  if (sourceType === "canonical_geotag") return "geotag";
  return inferDocumentTypeFromMixedFile(file);
};

const selectCanonicalFolderCandidate = ({ candidates = [], referencedFolderIds = new Set() }) => {
  if (!Array.isArray(candidates) || !candidates.length) return null;

  const ranked = candidates
    .map((candidate) => {
      const folderId = String(candidate?.id || "").trim();
      const referenceScore = referencedFolderIds.has(folderId) ? 1 : 0;
      return {
        ...candidate,
        __referenceScore: referenceScore,
        __createdAtEpoch: toEpochMillis(candidate?.createdTime),
      };
    })
    .sort((left, right) => {
      if (left.__referenceScore !== right.__referenceScore) {
        return right.__referenceScore - left.__referenceScore;
      }
      if (left.__createdAtEpoch !== right.__createdAtEpoch) {
        return left.__createdAtEpoch - right.__createdAtEpoch;
      }
      return String(left.id || "").localeCompare(String(right.id || ""));
    });

  return ranked[0] || null;
};

const appendNormalizationPreview = (summary, preview) => {
  if (!summary || !preview) return;
  const bucket =
    summary.normalization && typeof summary.normalization === "object"
      ? summary.normalization
      : createDriveSyncNormalizationSummary();

  bucket.departmentsAnalyzed += 1;
  bucket.dayFoldersDetected += Number(preview.dayFoldersDetected || 0);
  bucket.duplicateDayFolders += Number(preview.duplicateDayFolders || 0);
  bucket.canonicalDayFolders += Number(preview.canonicalDayFolders || 0);
  bucket.ambiguousDayFolders += Number(preview.ambiguousDayFolders || 0);
  bucket.filesMatchedSafely += Number(preview.filesMatchedSafely || 0);

  const actionTotals = preview.proposedActions || {};
  bucket.proposedActions.keep += Number(actionTotals.keep || 0);
  bucket.proposedActions.link += Number(actionTotals.link || 0);
  bucket.proposedActions.move += Number(actionTotals.move || 0);
  bucket.proposedActions.skip += Number(actionTotals.skip || 0);

  if (Array.isArray(bucket.departments)) {
    if (bucket.departments.length < DRIVE_SYNC_MAX_NORMALIZATION_DEPARTMENTS) {
      bucket.departments.push(preview);
    }
  } else {
    bucket.departments = [preview];
  }

  summary.normalization = bucket;
};

const buildDepartmentDayFolderNormalizationPreview = async ({
  department,
  schedules = [],
  listDriveFolderChildrenLoader = listDriveFolderChildren,
}) => {
  const departmentFolderId = String(department?.driveFolderId || "").trim();
  const basePreview = {
    departmentId: String(department?._id || "").trim() || null,
    departmentName: String(department?.name || "").trim() || null,
    departmentFolderId: departmentFolderId || null,
    dayFoldersDetected: 0,
    duplicateDayFolders: 0,
    canonicalDayFolders: 0,
    ambiguousDayFolders: 0,
    filesMatchedSafely: 0,
    proposedActions: {
      keep: 0,
      link: 0,
      move: 0,
      skip: 0,
    },
    days: [],
    warnings: [],
  };

  if (!departmentFolderId) {
    basePreview.warnings.push("Department folder is not linked in Drive; normalization scan skipped.");
    return { preview: basePreview, canonicalByDay: {} };
  }

  const departmentChildren = await listDriveFolderChildrenLoader({ folderId: departmentFolderId });
  const dayFolders = departmentChildren.filter(
    (item) =>
      item &&
      item.id &&
      String(item.mimeType || "").toLowerCase() === DRIVE_FOLDER_MIME_TYPE &&
      Number.isFinite(parseDayNumberFromFolderName(item.name)),
  );

  basePreview.dayFoldersDetected = dayFolders.length;

  const groupedByDay = new Map();
  for (const dayFolder of dayFolders) {
    const dayNumber = parseDayNumberFromFolderName(dayFolder?.name);
    if (!Number.isFinite(dayNumber)) continue;
    if (!groupedByDay.has(dayNumber)) groupedByDay.set(dayNumber, []);
    groupedByDay.get(dayNumber).push(dayFolder);
  }

  const canonicalByDay = {};
  const departmentDayFolderMap = new Map(
    (Array.isArray(department?.dayFolders) ? department.dayFolders : []).map((entry) => [
      Number(entry?.day),
      entry || {},
    ]),
  );

  for (const [dayNumber, candidates] of groupedByDay.entries()) {
    const referencedFolderIds = new Set();
    const mappedEntry = departmentDayFolderMap.get(dayNumber);
    const mappedFolderId = String(mappedEntry?.folderId || "").trim();
    if (mappedFolderId) referencedFolderIds.add(mappedFolderId);

    schedules
      .filter((schedule) => Number(schedule?.dayNumber) === Number(dayNumber))
      .forEach((schedule) => {
        const dayFolderId = String(schedule?.dayFolderId || schedule?.driveFolderId || "").trim();
        if (dayFolderId) referencedFolderIds.add(dayFolderId);
      });

    const explicitCanonicalDayFolder =
      mappedFolderId && candidates.find((candidate) => String(candidate?.id || "").trim() === mappedFolderId);

    const canonicalDayFolder =
      explicitCanonicalDayFolder ||
      selectCanonicalFolderCandidate({
        candidates,
        referencedFolderIds,
      });

    if (!canonicalDayFolder?.id) continue;

    const canonicalFolderId = String(canonicalDayFolder.id).trim();
    const dayChildren = await listDriveFolderChildrenLoader({ folderId: canonicalFolderId });
    const subFolders = dayChildren.filter(
      (item) =>
        item &&
        item.id &&
        String(item.mimeType || "").toLowerCase() === DRIVE_FOLDER_MIME_TYPE,
    );

    const attendanceCandidates = subFolders.filter((folder) =>
      isAttendanceFolderName(folder?.name),
    );
    const geoTagCandidates = subFolders.filter((folder) => isGeoTagFolderName(folder?.name));
    const legacyCheckoutCandidates = subFolders.filter((folder) =>
      isLegacyCheckoutFolderName(folder?.name),
    );

    const mappedAttendanceFolderId = String(mappedEntry?.attendanceFolderId || "").trim();
    const mappedGeoTagFolderId = String(mappedEntry?.geoTagFolderId || "").trim();
    const referencedAttendanceFolderIds = new Set();
    const referencedGeoTagFolderIds = new Set();
    if (mappedAttendanceFolderId) referencedAttendanceFolderIds.add(mappedAttendanceFolderId);
    if (mappedGeoTagFolderId) referencedGeoTagFolderIds.add(mappedGeoTagFolderId);

    schedules
      .filter((schedule) => Number(schedule?.dayNumber) === Number(dayNumber))
      .forEach((schedule) => {
        const attendanceFolderId = String(
          schedule?.canonicalAttendanceFolderId || schedule?.attendanceFolderId || "",
        ).trim();
        const geoTagFolderId = String(
          schedule?.canonicalGeoTagFolderId || schedule?.geoTagFolderId || "",
        ).trim();
        if (attendanceFolderId) referencedAttendanceFolderIds.add(attendanceFolderId);
        if (geoTagFolderId) referencedGeoTagFolderIds.add(geoTagFolderId);
      });

    const explicitCanonicalAttendance =
      mappedAttendanceFolderId &&
      attendanceCandidates.find(
        (candidate) => String(candidate?.id || "").trim() === mappedAttendanceFolderId,
      );
    const explicitCanonicalGeoTag =
      mappedGeoTagFolderId &&
      geoTagCandidates.find((candidate) => String(candidate?.id || "").trim() === mappedGeoTagFolderId);

    const canonicalAttendance =
      explicitCanonicalAttendance ||
      selectCanonicalFolderCandidate({
        candidates: attendanceCandidates,
        referencedFolderIds: referencedAttendanceFolderIds,
      });
    const canonicalGeoTag =
      explicitCanonicalGeoTag ||
      selectCanonicalFolderCandidate({
        candidates: geoTagCandidates,
        referencedFolderIds: referencedGeoTagFolderIds,
      });

    const matchedSafeFiles = dayChildren.filter(
      (item) => item && item.id && String(item.mimeType || "").toLowerCase() !== DRIVE_FOLDER_MIME_TYPE,
    ).length;
    basePreview.filesMatchedSafely += matchedSafeFiles;

    const hasDuplicateDayFolders = candidates.length > 1;
    if (hasDuplicateDayFolders) {
      basePreview.duplicateDayFolders += candidates.length - 1;
      basePreview.proposedActions.move += candidates.length - 1;
    }

    const missingGeoTagSubFolder = !canonicalGeoTag?.id;
    const missingAttendanceSubFolder = !canonicalAttendance?.id;
    if (missingGeoTagSubFolder || missingAttendanceSubFolder) {
      basePreview.proposedActions.link += 1;
    }

    if (legacyCheckoutCandidates.length && !canonicalGeoTag?.id) {
      basePreview.ambiguousDayFolders += 1;
      basePreview.proposedActions.skip += 1;
      basePreview.warnings.push(
        `Day ${dayNumber} has a legacy "Checkout" folder but no canonical "GeoTag" folder.`,
      );
    }

    basePreview.canonicalDayFolders += 1;
    basePreview.proposedActions.keep += 1;

    canonicalByDay[dayNumber] = {
      dayFolderId: canonicalFolderId,
      dayFolderName: canonicalDayFolder?.name || null,
      dayFolderLink: canonicalDayFolder?.webViewLink || null,
      attendanceFolderId: canonicalAttendance?.id || null,
      attendanceFolderName: canonicalAttendance?.name || null,
      attendanceFolderLink: canonicalAttendance?.webViewLink || null,
      geoTagFolderId: canonicalGeoTag?.id || null,
      geoTagFolderName: canonicalGeoTag?.name || null,
      geoTagFolderLink: canonicalGeoTag?.webViewLink || null,
    };

    basePreview.days.push({
      dayNumber,
      canonical: canonicalByDay[dayNumber],
      duplicates: candidates
        .filter((candidate) => String(candidate?.id || "").trim() !== canonicalFolderId)
        .map((candidate) => ({
          folderId: candidate?.id || null,
          folderName: candidate?.name || null,
        })),
      attendanceCandidates: attendanceCandidates.map((folder) => ({
        folderId: folder?.id || null,
        folderName: folder?.name || null,
      })),
      geoTagCandidates: geoTagCandidates.map((folder) => ({
        folderId: folder?.id || null,
        folderName: folder?.name || null,
      })),
      legacyCheckoutCandidates: legacyCheckoutCandidates.map((folder) => ({
        folderId: folder?.id || null,
        folderName: folder?.name || null,
      })),
      proposedActions: {
        keepCanonical: true,
        linkCanonicalInDb: Boolean(
          canonicalByDay[dayNumber].dayFolderId &&
            String(mappedEntry?.folderId || "").trim() !== canonicalByDay[dayNumber].dayFolderId,
        ),
        createMissingAttendanceSubfolder: missingAttendanceSubFolder,
        createMissingGeoTagSubfolder: missingGeoTagSubFolder,
        moveDuplicateFilesReviewRequired: hasDuplicateDayFolders,
        skipAmbiguous: Boolean(legacyCheckoutCandidates.length && !canonicalGeoTag?.id),
      },
    });
  }

  return { preview: basePreview, canonicalByDay };
};

const applyDepartmentDayFolderDuplicateCleanup = async ({
  department,
  schedules = [],
  summary = null,
  dryRun = false,
  preview = null,
  canonicalByDay = null,
  listDriveFolderChildrenLoader = listDriveFolderChildren,
  mergeDuplicateDriveFoldersLoader,
}) => {
  let normalizationPreview = preview;
  let canonicalByDayMap = canonicalByDay;

  if (!normalizationPreview || !canonicalByDayMap) {
    const normalizationResult = await buildDepartmentDayFolderNormalizationPreview({
      department,
      schedules,
      listDriveFolderChildrenLoader,
    });
    normalizationPreview = normalizationResult?.preview || null;
    canonicalByDayMap = normalizationResult?.canonicalByDay || {};
  }

  const duplicateDayFolders = Number(normalizationPreview?.duplicateDayFolders || 0);

  if (dryRun) {
    if (summary) {
      summary.duplicateDayFoldersWouldClear =
        Number(summary.duplicateDayFoldersWouldClear || 0) + duplicateDayFolders;
    }
    return {
      duplicateDayFoldersDetected: duplicateDayFolders,
      duplicateDayFoldersCleared: 0,
      warnings: [],
    };
  }

  if (duplicateDayFolders <= 0) {
    return {
      duplicateDayFoldersDetected: duplicateDayFolders,
      duplicateDayFoldersCleared: 0,
      warnings: [],
    };
  }

  const departmentFolderId = String(department?.driveFolderId || "").trim();
  if (!departmentFolderId) {
    const warning = `Department ${String(department?._id || "unknown")} has no driveFolderId; duplicate cleanup skipped.`;
    if (summary) pushSummaryWarning(summary, warning);
    return {
      duplicateDayFoldersDetected: duplicateDayFolders,
      duplicateDayFoldersCleared: 0,
      warnings: [warning],
    };
  }

  const warnings = [
    "Duplicate folder normalization ran in non-destructive mode. No Drive folders were moved or deleted.",
  ];
  const duplicateDayFoldersCleared = 0;

  if (summary) {
    summary.duplicateDayFoldersCleared =
      Number(summary.duplicateDayFoldersCleared || 0) + duplicateDayFoldersCleared;
    warnings.forEach((warning) => pushSummaryWarning(summary, warning));
  }

  return {
    duplicateDayFoldersDetected: duplicateDayFolders,
    duplicateDayFoldersCleared,
    warnings,
  };
};

const collectDiscoveredScheduleFiles = async ({ schedule, attendance, summary }) => {
  const candidates = buildScanFolderCandidates({ schedule, attendance });
  if (!candidates.length) return { files: [], skippedAmbiguous: 0 };

  const byFileId = new Map();
  let skippedAmbiguous = 0;

  for (const candidate of candidates) {
    const files = await listDriveFiles({ folderId: candidate.folderId });
    summary.totalScanned += files.length;

    for (const file of files) {
      const normalizedFileId = String(file?.id || "").trim();
      if (!normalizedFileId) continue;

      const inferredType = inferFileTypeForSource({
        file,
        sourceType: candidate.sourceType,
      });

      if (inferredType === "other") {
        skippedAmbiguous += 1;
        continue;
      }

      const existing = byFileId.get(normalizedFileId);
      if (!existing) {
        byFileId.set(normalizedFileId, toDiscoveredDocument({ file, fileType: inferredType }));
        continue;
      }

      // Prefer explicit folder classification over mixed-folder inference.
      if (candidate.sourceType !== "mixed") {
        byFileId.set(normalizedFileId, toDiscoveredDocument({ file, fileType: inferredType }));
      }
    }
  }

  return {
    files: Array.from(byFileId.values()).filter(Boolean),
    skippedAmbiguous,
  };
};

const reconcileScheduleDocumentsForFiles = async ({
  schedule,
  attendance,
  trainerObjectId,
  discoveredFiles,
  summary,
  dryRun = false,
}) => {
  if (!Array.isArray(discoveredFiles) || !discoveredFiles.length) {
    return {
      insertedAttendance: 0,
      insertedGeoTag: 0,
      refreshedLinks: 0,
      unchanged: 0,
      byType: { attendance: [], geotag: [] },
    };
  }

  const scheduleObjectId = toObjectIdOrNull(schedule?._id);
  const attendanceObjectId = toObjectIdOrNull(attendance?._id);
  if (!scheduleObjectId || !trainerObjectId) {
    summary.skippedAmbiguous += discoveredFiles.length;
    return {
      insertedAttendance: 0,
      insertedGeoTag: 0,
      refreshedLinks: 0,
      unchanged: discoveredFiles.length,
      byType: { attendance: [], geotag: [] },
    };
  }

  const fileIds = discoveredFiles
    .map((entry) => String(entry.driveFileId || "").trim())
    .filter(Boolean);
  const existingDocs = fileIds.length
    ? await ScheduleDocument.find({ driveFileId: { $in: fileIds } }).select(
        "_id driveFileId scheduleId attendanceId trainerId fileType fileField fileName fileUrl",
      )
    : [];
  const existingByFileId = new Map(
    existingDocs.map((doc) => [String(doc.driveFileId || "").trim(), doc]),
  );

  let insertedAttendance = 0;
  let insertedGeoTag = 0;
  let refreshedLinks = 0;
  let unchanged = 0;
  const byType = { attendance: [], geotag: [] };

  for (const file of discoveredFiles) {
    const currentFileId = String(file.driveFileId || "").trim();
    if (!currentFileId) continue;

    const normalizedType = normalizeDocumentType(file.fileType);
    if (normalizedType === "attendance") {
      byType.attendance.push(file);
    } else if (normalizedType === "geotag") {
      byType.geotag.push(file);
    }

    const fileField =
      normalizedType === "attendance"
        ? "attendance"
        : normalizedType === "geotag"
          ? "checkOutGeoImage"
          : "other";

    const payload = {
      scheduleId: scheduleObjectId,
      attendanceId: attendanceObjectId,
      trainerId: trainerObjectId,
      fileType: normalizedType,
      fileField,
      fileName: file.fileName || null,
      fileUrl: file.fileUrl || null,
    };

    const existingDoc = existingByFileId.get(currentFileId) || null;
    if (!existingDoc) {
      if (!dryRun) {
        await ScheduleDocument.findOneAndUpdate(
          { driveFileId: currentFileId },
          {
            $set: payload,
            $setOnInsert: {
              driveFileId: currentFileId,
              status: "pending",
              verifiedBy: null,
              verifiedAt: null,
              rejectReason: null,
            },
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
          },
        );
      }

      if (normalizedType === "attendance") insertedAttendance += 1;
      if (normalizedType === "geotag") insertedGeoTag += 1;
      continue;
    }

    const hasChanges =
      String(existingDoc.scheduleId || "") !== String(scheduleObjectId) ||
      String(existingDoc.attendanceId || "") !== String(attendanceObjectId || "") ||
      String(existingDoc.trainerId || "") !== String(trainerObjectId) ||
      String(existingDoc.fileType || "") !== String(payload.fileType || "") ||
      String(existingDoc.fileField || "") !== String(payload.fileField || "") ||
      String(existingDoc.fileName || "") !== String(payload.fileName || "") ||
      String(existingDoc.fileUrl || "") !== String(payload.fileUrl || "");

    if (!hasChanges) {
      unchanged += 1;
      continue;
    }

    if (!dryRun) {
      await ScheduleDocument.updateOne({ _id: existingDoc._id }, { $set: payload });
    }
    refreshedLinks += 1;
  }

  return {
    insertedAttendance,
    insertedGeoTag,
    refreshedLinks,
    unchanged,
    byType,
  };
};

const reconcileAttendanceDriveAssets = async ({
  schedule,
  attendance,
  discoveredByType,
  summary,
  dryRun = false,
}) => {
  if (!attendance) return false;

  const mergedFiles = mergeDriveAssetEntries(
    Array.isArray(attendance?.driveAssets?.files) ? attendance.driveAssets.files : [],
    [...(discoveredByType.attendance || []), ...(discoveredByType.geotag || [])].map((item) => ({
      fileId: item.driveFileId,
      fileName: item.fileName,
      fileUrl: item.fileUrl,
      webViewLink: item.webViewLink,
      downloadLink: item.downloadLink,
      fileType: item.fileType,
    })),
  );

  const nextGeoUrls = Array.from(
    new Set(
      [...(Array.isArray(attendance.checkOutGeoImageUrls) ? attendance.checkOutGeoImageUrls : [])].concat(
        (discoveredByType.geotag || [])
          .map((item) => String(item.fileUrl || "").trim())
          .filter(Boolean),
      ),
    ),
  );

  const attendanceBackfillCandidate = (discoveredByType.attendance || [])
    .map((item) => ({
      field: pickAttendanceBackfillField(item.fileName),
      fileUrl: item.fileUrl,
    }))
    .find((entry) => entry.field && entry.fileUrl);

  const nextDriveAssets = {
    ...(attendance.driveAssets && typeof attendance.driveAssets === "object"
      ? attendance.driveAssets
      : {}),
    lastSyncedAt: new Date().toISOString(),
    files: mergedFiles,
    folderIds: {
      day: schedule.dayFolderId || schedule.driveFolderId || null,
      attendance: schedule.attendanceFolderId || null,
      geoTag: schedule.geoTagFolderId || null,
    },
  };

  const hasGeoBackfill = nextGeoUrls.length > 0;
  let changed = false;

  if (JSON.stringify(attendance.driveAssets || null) !== JSON.stringify(nextDriveAssets)) {
    attendance.driveAssets = nextDriveAssets;
    changed = true;
  }

  if (hasGeoBackfill) {
    if (!attendance.checkOutGeoImageUrl && nextGeoUrls[0]) {
      attendance.checkOutGeoImageUrl = nextGeoUrls[0];
      changed = true;
    }
    if (JSON.stringify(attendance.checkOutGeoImageUrls || []) !== JSON.stringify(nextGeoUrls)) {
      attendance.checkOutGeoImageUrls = nextGeoUrls;
      changed = true;
    }
  }

  if (attendanceBackfillCandidate?.field && !attendance[attendanceBackfillCandidate.field]) {
    attendance[attendanceBackfillCandidate.field] = attendanceBackfillCandidate.fileUrl;
    changed = true;
  }

  if (hasGeoBackfill || (discoveredByType.attendance || []).length) {
    if (attendance.driveSyncStatus !== "SYNCED") {
      attendance.driveSyncStatus = "SYNCED";
      changed = true;
    }
  }

  if (!changed) return false;
  if (!dryRun) {
    await attendance.save();
  }
  incrementRefreshedLinks({ summary, dryRun, count: 1 });
  return true;
};

const reconcileScheduleFlags = async ({ schedule, discoveredByType, summary, dryRun = false }) => {
  let changed = false;
  if ((discoveredByType.attendance || []).length && schedule.attendanceUploaded !== true) {
    schedule.attendanceUploaded = true;
    changed = true;
  }
  if ((discoveredByType.geotag || []).length && schedule.geoTagUploaded !== true) {
    schedule.geoTagUploaded = true;
    changed = true;
  }
  if (!changed) return false;
  if (!dryRun) {
    await schedule.save();
  }
  incrementRefreshedLinks({ summary, dryRun, count: 1 });
  return true;
};

const reconcileScheduleDriveEvidence = async ({ schedule, summary, dryRun = false }) => {
  if (!schedule?._id) return;

  const attendance = await Attendance.findOne({ scheduleId: schedule._id }).sort({
    createdAt: -1,
  });
  const scanResult = await collectDiscoveredScheduleFiles({
    schedule,
    attendance,
    summary,
  });
  if (scanResult.skippedAmbiguous > 0) {
    summary.skippedAmbiguous += scanResult.skippedAmbiguous;
  }
  if (dryRun) {
    summary.candidateMatches = Number(summary.candidateMatches || 0) + scanResult.files.length;
  }

  if (!scanResult.files.length) {
    summary.unchanged += 1;
    summary.schedulesReconciled += 1;
    return;
  }

  const discoveredByType = {
    attendance: scanResult.files.filter((item) => item?.fileType === "attendance"),
    geotag: scanResult.files.filter((item) => item?.fileType === "geotag"),
  };

  const trainerObjectId =
    toObjectIdOrNull(schedule.trainerId) || toObjectIdOrNull(attendance?.trainerId);
  if (!trainerObjectId) {
    await reconcileScheduleFlags({
      schedule,
      discoveredByType,
      summary,
      dryRun,
    });
    const skippedCount = scanResult.files.length;
    summary.skippedAmbiguous += skippedCount;
    pushSummaryWarning(
      summary,
      `Schedule ${schedule._id} has discoverable files but missing trainer linkage. Backfill skipped.`,
    );
    pushSummaryError(
      summary,
      `Skipped ${skippedCount} file(s) for schedule ${schedule._id} because trainer linkage is missing.`,
    );
    summary.schedulesReconciled += 1;
    return;
  }

  const docResult = await reconcileScheduleDocumentsForFiles({
    schedule,
    attendance,
    trainerObjectId,
    discoveredFiles: scanResult.files,
    summary,
    dryRun,
  });
  incrementAttendanceBackfill({
    summary,
    dryRun,
    count: docResult.insertedAttendance,
  });
  incrementGeoTagBackfill({
    summary,
    dryRun,
    count: docResult.insertedGeoTag,
  });
  incrementRefreshedLinks({
    summary,
    dryRun,
    count: docResult.refreshedLinks,
  });
  summary.unchanged += docResult.unchanged;

  await reconcileAttendanceDriveAssets({
    schedule,
    attendance,
    discoveredByType: docResult.byType,
    summary,
    dryRun,
  });

  await reconcileScheduleFlags({
    schedule,
    discoveredByType: docResult.byType,
    summary,
    dryRun,
  });

  summary.schedulesReconciled += 1;
};

const reconcileDepartmentSchedulesDriveEvidence = async ({
  schedules = [],
  summary,
  dryRun = false,
}) => {
  for (const schedule of schedules) {
    try {
      await reconcileScheduleDriveEvidence({ schedule, summary, dryRun });
    } catch (error) {
      pushSummaryError(
        summary,
        `Schedule ${schedule?._id || "unknown"} reconciliation failed: ${error.message}`,
      );
    }
  }
};

module.exports = {
  createDriveSyncReconciliationSummary,
  createDriveSyncDryRunSummary,
  createDriveSyncNormalizationSummary,
  mergeDriveAssetEntries,
  normalizeDocumentType,
  inferDocumentTypeFromMixedFile,
  buildScanFolderCandidates,
  buildDepartmentDayFolderNormalizationPreview,
  applyDepartmentDayFolderDuplicateCleanup,
  appendNormalizationPreview,
  reconcileDepartmentSchedulesDriveEvidence,
};
