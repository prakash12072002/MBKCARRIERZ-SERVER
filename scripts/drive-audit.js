#!/usr/bin/env node

const path = require("path");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const {
  Attendance,
  Schedule,
  ScheduleDocument,
  Trainer,
  TrainerDocument,
} = require("../models");
const {
  cleanupDuplicateDriveFilesByName,
  cleanupDuplicateDriveFoldersByName,
  deleteFromDrive,
} = require("../services/googleDriveService");
const { ensureScheduleFolderState } = require("../services/trainingFolderService");

const args = new Set(process.argv.slice(2));
const shouldFixMetadata = args.has("--fix-metadata");
const shouldCleanupDrive = args.has("--cleanup-drive");
const shouldRepairScheduleFolders = args.has("--repair-schedule-folders");
const shouldCleanupTrainerDocRecords = args.has("--cleanup-trainer-docs");

const dedupeDriveAssetEntries = (entries = []) => {
  const deduped = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;

    const identity =
      entry.fileId ||
      [
        entry.folderId || "",
        entry.folderType || entry.fileType || "",
        entry.fieldName || "",
        entry.fileName || "",
        entry.localPath || entry.fileUrl || entry.webViewLink || "",
      ].join("|");

    if (!identity.replace(/\|/g, "").trim()) continue;
    if (deduped.has(identity)) {
      deduped.delete(identity);
    }
    deduped.set(identity, entry);
  }

  return Array.from(deduped.values());
};

const groupBy = (items, keyBuilder) => {
  const grouped = new Map();
  for (const item of items) {
    const key = keyBuilder(item);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
};

const printSection = (title, findings = []) => {
  console.log(`\n=== ${title} ===`);
  if (!findings.length) {
    console.log("OK");
    return;
  }

  console.log(`Found ${findings.length}`);
  findings.slice(0, 25).forEach((finding, index) => {
    console.log(`${index + 1}. ${JSON.stringify(finding)}`);
  });

  if (findings.length > 25) {
    console.log(`... ${findings.length - 25} more`);
  }
};

const auditAttendanceDriveAssets = async () => {
  const attendances = await Attendance.find({
    $or: [
      { "driveAssets.files.0": { $exists: true } },
      { "driveAssets.filesByField": { $exists: true } },
    ],
  }).select("_id scheduleId driveAssets updatedAt");

  const findings = [];
  let fixedCount = 0;

  for (const attendance of attendances) {
    const originalFiles = Array.isArray(attendance.driveAssets?.files)
      ? attendance.driveAssets.files
      : [];
    const dedupedFiles = dedupeDriveAssetEntries(originalFiles);

    const originalByField =
      attendance.driveAssets?.filesByField &&
      typeof attendance.driveAssets.filesByField === "object"
        ? attendance.driveAssets.filesByField
        : {};

    let fieldChanged = false;
    const dedupedByField = {};

    for (const [fieldName, fieldEntries] of Object.entries(originalByField)) {
      const normalizedEntries = Array.isArray(fieldEntries) ? fieldEntries : [];
      const dedupedEntries = dedupeDriveAssetEntries(normalizedEntries);
      dedupedByField[fieldName] = dedupedEntries;
      if (dedupedEntries.length !== normalizedEntries.length) {
        fieldChanged = true;
      }
    }

    if (dedupedFiles.length !== originalFiles.length || fieldChanged) {
      findings.push({
        attendanceId: String(attendance._id),
        scheduleId: attendance.scheduleId ? String(attendance.scheduleId) : null,
        duplicateFileEntries: originalFiles.length - dedupedFiles.length,
        duplicateFieldEntries: Object.entries(originalByField)
          .map(([fieldName, entries]) => ({
            fieldName,
            removed:
              (Array.isArray(entries) ? entries.length : 0) -
              (dedupedByField[fieldName]?.length || 0),
          }))
          .filter((item) => item.removed > 0),
      });

      if (shouldFixMetadata) {
        attendance.driveAssets = {
          ...(attendance.driveAssets && typeof attendance.driveAssets === "object"
            ? attendance.driveAssets
            : {}),
          files: dedupedFiles,
          filesByField: dedupedByField,
        };
        await attendance.save();
        fixedCount += 1;
      }
    }
  }

  return { findings, fixedCount };
};

const auditTrainerDocumentDuplicates = async () => {
  const trainerDocuments = await TrainerDocument.find({})
    .select("_id trainerId documentType driveFileId driveFolderId fileName updatedAt")
    .sort({ updatedAt: -1 });

  const byTrainerAndType = groupBy(
    trainerDocuments,
    (doc) => `${String(doc.trainerId)}|${doc.documentType}`,
  );

  const findings = [];
  for (const [key, docs] of byTrainerAndType.entries()) {
    if (docs.length <= 1) continue;
    const [trainerId, documentType] = key.split("|");
    findings.push({
      trainerId,
      documentType,
      documentIds: docs.map((doc) => String(doc._id)),
      driveFileIds: docs.map((doc) => doc.driveFileId || null),
      fileNames: docs.map((doc) => doc.fileName || null),
    });
  }

  let fixedCount = 0;

  if (shouldCleanupTrainerDocRecords) {
    for (const docs of byTrainerAndType.values()) {
      if (docs.length <= 1) continue;
      const [keepDoc, ...duplicates] = docs;

      for (const duplicate of duplicates) {
        if (
          duplicate.driveFileId &&
          duplicate.driveFileId !== keepDoc.driveFileId
        ) {
          try {
            await deleteFromDrive(duplicate.driveFileId);
          } catch (error) {
            console.warn(
              `[drive-audit] Failed to delete duplicate trainer document drive file ${duplicate.driveFileId}: ${error.message}`,
            );
          }
        }

        await TrainerDocument.deleteOne({ _id: duplicate._id });
        fixedCount += 1;
      }
    }
  }

  return { findings, fixedCount };
};

const auditScheduleDocumentDuplicates = async () => {
  const scheduleDocuments = await ScheduleDocument.find({})
    .select("_id scheduleId fileType driveFileId fileName updatedAt")
    .sort({ updatedAt: -1 });

  const findings = [];

  const byDriveFile = groupBy(
    scheduleDocuments.filter((doc) => doc.driveFileId),
    (doc) => doc.driveFileId,
  );
  for (const [driveFileId, docs] of byDriveFile.entries()) {
    if (docs.length <= 1) continue;
    findings.push({
      driveFileId,
      scheduleDocumentIds: docs.map((doc) => String(doc._id)),
      scheduleIds: docs.map((doc) => String(doc.scheduleId || "")),
      fileNames: docs.map((doc) => doc.fileName || null),
    });
  }

  return { findings };
};

const auditScheduleFolderConsistency = async () => {
  const schedules = await Schedule.find({})
    .select(
      "_id departmentId collegeId dayNumber driveFolderId dayFolderId attendanceFolderId geoTagFolderId driveFolderName dayFolderName",
    )
    .sort({ dayNumber: 1 });

  const findings = [];
  let fixedCount = 0;

  for (const schedule of schedules) {
    const issues = [];
    let touched = false;

    if (!schedule.dayFolderId && schedule.driveFolderId) {
      issues.push("missing dayFolderId");
      if (shouldFixMetadata) {
        schedule.dayFolderId = schedule.driveFolderId;
        schedule.dayFolderName = schedule.dayFolderName || schedule.driveFolderName;
        touched = true;
      }
    }

    if (!schedule.driveFolderId && schedule.dayFolderId) {
      issues.push("missing driveFolderId");
      if (shouldFixMetadata) {
        schedule.driveFolderId = schedule.dayFolderId;
        schedule.driveFolderName = schedule.driveFolderName || schedule.dayFolderName;
        touched = true;
      }
    }

    if (!schedule.attendanceFolderId) {
      issues.push("missing attendanceFolderId");
    }

    if (!schedule.geoTagFolderId) {
      issues.push("missing geoTagFolderId");
    }

    if (issues.length) {
      findings.push({
        scheduleId: String(schedule._id),
        dayNumber: schedule.dayNumber ?? null,
        issues,
        driveFolderId: schedule.driveFolderId || null,
        dayFolderId: schedule.dayFolderId || null,
        attendanceFolderId: schedule.attendanceFolderId || null,
        geoTagFolderId: schedule.geoTagFolderId || null,
      });
    }

    if (touched) {
      await schedule.save();
      fixedCount += 1;
    }
  }

  let repairedCount = 0;
  if (shouldRepairScheduleFolders) {
    for (const schedule of schedules) {
      if (schedule.dayFolderId && schedule.attendanceFolderId && schedule.geoTagFolderId) {
        continue;
      }

      try {
        const repairResult = await ensureScheduleFolderState({
          scheduleId: schedule._id,
        });
        if (
          repairResult?.folderState?.dayFolderId &&
          repairResult?.folderState?.attendanceFolderId &&
          repairResult?.folderState?.geoTagFolderId
        ) {
          repairedCount += 1;
        }
      } catch (error) {
        console.warn(
          `[drive-audit] Failed to repair schedule ${schedule._id}: ${error.message}`,
        );
      }
    }
  }

  const crossDayFolderFindings = [];
  const folderMap = groupBy(
    schedules.filter((item) => item.dayFolderId),
    (item) => item.dayFolderId,
  );

  for (const [folderId, folderSchedules] of folderMap.entries()) {
    const uniqueDayNumbers = Array.from(
      new Set(folderSchedules.map((item) => Number(item.dayNumber || 0))),
    );
    if (uniqueDayNumbers.length > 1) {
      crossDayFolderFindings.push({
        dayFolderId: folderId,
        dayNumbers: uniqueDayNumbers,
        scheduleIds: folderSchedules.map((item) => String(item._id)),
      });
    }
  }

  return { findings, crossDayFolderFindings, fixedCount, repairedCount };
};

const auditTrainerFolderReferences = async () => {
  const trainers = await Trainer.find({
    driveFolderId: { $exists: true, $ne: null },
  }).select("_id trainerId driveFolderId driveFolderName");

  const findings = trainers
    .filter(
      (trainer) =>
        String(trainer.driveFolderName || "").trim().toLowerCase() === "documents",
    )
    .map((trainer) => ({
      trainerDbId: String(trainer._id),
      trainerCode: trainer.trainerId || null,
      driveFolderId: trainer.driveFolderId || null,
      driveFolderName: trainer.driveFolderName || null,
      issue: "trainer is still pointing at Documents folder instead of trainer folder",
    }));

  return { findings };
};

const buildDriveCleanupTargets = async () => {
  const targets = new Map();

  const registerTarget = ({ folderId, fileName, keepFileId, updatedAt, source }) => {
    if (!folderId || !fileName || !keepFileId) return;
    const key = `${folderId}|${fileName}`;
    const timestamp = new Date(updatedAt || 0).getTime();
    const existing = targets.get(key);

    if (!existing || timestamp >= existing.timestamp) {
      targets.set(key, {
        folderId,
        fileName,
        keepFileId,
        timestamp,
        source,
      });
    }
  };

  const trainerDocuments = await TrainerDocument.find({
    driveFolderId: { $exists: true, $ne: null },
    driveFileId: { $exists: true, $ne: null },
    fileName: { $exists: true, $ne: null },
  }).select("driveFolderId driveFileId fileName updatedAt");

  trainerDocuments.forEach((doc) =>
    registerTarget({
      folderId: doc.driveFolderId,
      fileName: doc.fileName,
      keepFileId: doc.driveFileId,
      updatedAt: doc.updatedAt,
      source: "trainer-document",
    }),
  );

  const attendances = await Attendance.find({
    "driveAssets.files.0": { $exists: true },
  }).select("driveAssets updatedAt");

  attendances.forEach((attendance) => {
    const files = Array.isArray(attendance.driveAssets?.files)
      ? attendance.driveAssets.files
      : [];
    files.forEach((file) =>
      registerTarget({
        folderId: file.folderId || null,
        fileName: file.fileName || null,
        keepFileId: file.fileId || null,
        updatedAt: file.uploadedAt || attendance.updatedAt,
        source: "attendance-drive-assets",
      }),
    );
  });

  return Array.from(targets.values());
};

const cleanupDriveDuplicates = async () => {
  const targets = await buildDriveCleanupTargets();
  const findings = [];
  const errors = [];

  for (const target of targets) {
    try {
      const result = await cleanupDuplicateDriveFilesByName({
        folderId: target.folderId,
        fileName: target.fileName,
        keepFileId: target.keepFileId,
      });

      if (Array.isArray(result.removedFileIds) && result.removedFileIds.length) {
        findings.push({
          folderId: target.folderId,
          fileName: target.fileName,
          keepFileId: target.keepFileId,
          removedFileIds: result.removedFileIds,
          source: target.source,
        });
      }
    } catch (error) {
      errors.push({
        folderId: target.folderId,
        fileName: target.fileName,
        keepFileId: target.keepFileId,
        source: target.source,
        error: error.message,
      });
    }
  }

  return { findings, errors };
};

const buildDriveFolderCleanupTargets = async () => {
  const targets = new Map();

  const registerTarget = ({
    parentFolderId,
    folderName,
    keepFolderId,
    updatedAt,
    source,
  }) => {
    if (!parentFolderId || !folderName) return;

    const key = `${parentFolderId}|${folderName}`;
    const timestamp = new Date(updatedAt || 0).getTime();
    const existing = targets.get(key);

    if (!existing || timestamp >= existing.timestamp) {
      targets.set(key, {
        parentFolderId,
        folderName,
        keepFolderId: keepFolderId || null,
        timestamp,
        source,
      });
    }
  };

  const schedules = await Schedule.find({
    dayFolderId: { $exists: true, $ne: null },
  }).select("_id dayFolderId attendanceFolderId geoTagFolderId updatedAt");

  schedules.forEach((schedule) => {
    registerTarget({
      parentFolderId: schedule.dayFolderId,
      folderName: "Attendance",
      keepFolderId: schedule.attendanceFolderId || null,
      updatedAt: schedule.updatedAt,
      source: `schedule:${schedule._id}:attendance-folder`,
    });

    registerTarget({
      parentFolderId: schedule.dayFolderId,
      folderName: "GeoTag",
      keepFolderId: schedule.geoTagFolderId || null,
      updatedAt: schedule.updatedAt,
      source: `schedule:${schedule._id}:geotag-folder`,
    });
  });

  return Array.from(targets.values());
};

const cleanupDriveFolderDuplicates = async () => {
  const targets = await buildDriveFolderCleanupTargets();
  const findings = [];
  const errors = [];

  for (const target of targets) {
    try {
      const result = await cleanupDuplicateDriveFoldersByName({
        parentFolderId: target.parentFolderId,
        folderName: target.folderName,
        keepFolderId: target.keepFolderId,
      });

      if (Array.isArray(result.removedFolderIds) && result.removedFolderIds.length) {
        findings.push({
          parentFolderId: target.parentFolderId,
          folderName: target.folderName,
          keepFolderId: target.keepFolderId,
          removedFolderIds: result.removedFolderIds,
          movedItems: result.movedItems || [],
          source: target.source,
        });
      }
    } catch (error) {
      errors.push({
        parentFolderId: target.parentFolderId,
        folderName: target.folderName,
        keepFolderId: target.keepFolderId,
        source: target.source,
        error: error.message,
      });
    }
  }

  return { findings, errors };
};

const main = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is missing in environment.");
  }

  await mongoose.connect(process.env.MONGO_URI);

  const attendanceAudit = await auditAttendanceDriveAssets();
  const trainerDocumentAudit = await auditTrainerDocumentDuplicates();
  const scheduleDocumentAudit = await auditScheduleDocumentDuplicates();
  const scheduleFolderAudit = await auditScheduleFolderConsistency();
  const trainerFolderAudit = await auditTrainerFolderReferences();
  const driveCleanupAudit = shouldCleanupDrive
    ? await cleanupDriveDuplicates()
    : { findings: [], errors: [] };
  const driveFolderCleanupAudit = shouldCleanupDrive
    ? await cleanupDriveFolderDuplicates()
    : { findings: [], errors: [] };

  printSection("Attendance Drive Metadata Duplicates", attendanceAudit.findings);
  printSection("Trainer Document Duplicate Records", trainerDocumentAudit.findings);
  printSection("Schedule Document Duplicate Records", scheduleDocumentAudit.findings);
  printSection("Schedule Folder Consistency Issues", scheduleFolderAudit.findings);
  printSection(
    "Cross-Day Folder Reuse Issues",
    scheduleFolderAudit.crossDayFolderFindings,
  );
  printSection("Trainer Folder Reference Issues", trainerFolderAudit.findings);

  if (shouldCleanupDrive) {
    printSection("Removed Drive Duplicate Files", driveCleanupAudit.findings);
    printSection("Removed Drive Duplicate Folders", driveFolderCleanupAudit.findings);
    printSection("Drive Duplicate File Cleanup Errors", driveCleanupAudit.errors);
    printSection("Drive Duplicate Folder Cleanup Errors", driveFolderCleanupAudit.errors);
  }

  console.log("\n=== Summary ===");
  console.log(
    JSON.stringify(
      {
        fixedAttendanceMetadata: attendanceAudit.fixedCount,
        fixedScheduleMetadata: scheduleFolderAudit.fixedCount,
        repairedScheduleFolders: scheduleFolderAudit.repairedCount,
        removedDuplicateTrainerDocuments: trainerDocumentAudit.fixedCount,
        attendanceDuplicateRecords: attendanceAudit.findings.length,
        trainerDocumentDuplicateRecords: trainerDocumentAudit.findings.length,
        scheduleDocumentDuplicateRecords: scheduleDocumentAudit.findings.length,
        scheduleFolderIssues: scheduleFolderAudit.findings.length,
        crossDayFolderReuseIssues:
          scheduleFolderAudit.crossDayFolderFindings.length,
        trainerFolderIssues: trainerFolderAudit.findings.length,
        removedDriveDuplicateGroups: driveCleanupAudit.findings.length,
        removedDriveDuplicateFolderGroups: driveFolderCleanupAudit.findings.length,
        driveDuplicateCleanupErrors:
          driveCleanupAudit.errors.length + driveFolderCleanupAudit.errors.length,
      },
      null,
      2,
    ),
  );
};

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\nDrive audit failed:", error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
