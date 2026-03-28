const {
  DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  ensureDriveFolder,
  findDriveFolder,
  moveDriveItemToParent,
  syncDriveFolder,
  deleteFromDrive,
} = require("./googleDriveService");

const TRAINING_ROOT_FOLDER_NAME = String(
  process.env.GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_NAME || "Trainer-Uploads",
).trim();

const EXPLICIT_TRAINING_ROOT_FOLDER_ID = String(
  process.env.GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_ID || "",
).trim();

const TRAINING_PARENT_FOLDER_ID = String(
  process.env.GOOGLE_DRIVE_TRAINING_PARENT_FOLDER_ID ||
    DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID ||
    "",
).trim();

const toName = (value, fallback) => {
  const normalized = String(value || "").trim();
  return normalized || fallback;
};

const resolveBatchFolderName = ({ batch, college, department, course }) => {
  const explicitBatchName = toName(batch?.name || batch, "");
  if (explicitBatchName) return explicitBatchName;

  const departmentName = toName(department?.name || department, "");
  const collegeName = toName(college?.name || college, "");
  const courseName = toName(course?.title || course, "");

  // Keep a single "Batch" level while preserving uniqueness when needed.
  if (departmentName && collegeName) return `${collegeName}-${departmentName}`;
  if (departmentName) return departmentName;
  if (collegeName && courseName) return `${collegeName}-${courseName}`;
  if (collegeName) return `Batch_${collegeName}`;

  const fallbackId = department?._id || college?._id || "GENERAL";
  return `Batch_${fallbackId}`;
};

const toFolderPayload = (folder) => {
  if (!folder?.id) return null;
  return {
    id: folder.id,
    name: folder.name || null,
    link: folder.webViewLink || null,
  };
};

const toDepartmentDayFolders = (dayFoldersByDayNumber = {}) =>
  Object.entries(dayFoldersByDayNumber || {})
    .map(([dayKey, folderMeta]) => {
      const day = Number.parseInt(dayKey, 10);
      if (!Number.isFinite(day) || day <= 0) return null;
      return {
        day,
        folderId: folderMeta?.id || null,
        folderName: folderMeta?.name || null,
        folderLink: folderMeta?.link || null,
        attendanceFolderId: folderMeta?.attendanceFolder?.id || null,
        attendanceFolderName: folderMeta?.attendanceFolder?.name || null,
        attendanceFolderLink: folderMeta?.attendanceFolder?.link || null,
        geoTagFolderId: folderMeta?.geoTagFolder?.id || null,
        geoTagFolderName: folderMeta?.geoTagFolder?.name || null,
        geoTagFolderLink: folderMeta?.geoTagFolder?.link || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.day - b.day);

const ensureDayFolderWithSubFolders = async ({ parentFolderId, dayNumber }) => {
  const dayFolder = await ensureDriveFolder({
    folderName: `Day_${dayNumber}`,
    parentFolderId,
  });

  const attendanceFolder = await ensureDriveFolder({
    folderName: "Attendance",
    parentFolderId: dayFolder.id,
  });

  const geoTagFolder = await ensureDriveFolder({
    folderName: "GeoTag",
    parentFolderId: dayFolder.id,
  });

  return {
    ...toFolderPayload(dayFolder),
    attendanceFolder: toFolderPayload(attendanceFolder),
    geoTagFolder: toFolderPayload(geoTagFolder),
  };
};

const isTrainingDriveEnabled = () =>
  Boolean(EXPLICIT_TRAINING_ROOT_FOLDER_ID || TRAINING_PARENT_FOLDER_ID);

const ensureTrainingRootFolder = async () => {
  if (EXPLICIT_TRAINING_ROOT_FOLDER_ID) {
    return {
      id: EXPLICIT_TRAINING_ROOT_FOLDER_ID,
      name: TRAINING_ROOT_FOLDER_NAME || "Trainer-Uploads",
      webViewLink: null,
    };
  }

  if (!TRAINING_PARENT_FOLDER_ID) return null;

  return ensureDriveFolder({
    folderName: TRAINING_ROOT_FOLDER_NAME || "Trainer-Uploads",
    parentFolderId: TRAINING_PARENT_FOLDER_ID,
  });
};

const ensureCompanyHierarchy = async ({ company }) => {
  if (!company?._id) return null;
  const rootFolder = await ensureTrainingRootFolder();
  if (!rootFolder?.id) return null;

  const companyFolder = await syncDriveFolder({
    folderId: company.driveFolderId || null,
    folderName: toName(company.name, `Company_${company._id}`),
    parentFolderId: rootFolder.id,
  });

  return {
    rootFolder: toFolderPayload(rootFolder),
    companyFolder: toFolderPayload(companyFolder),
  };
};

const ensureCourseHierarchy = async ({ company, course }) => {
  if (!company?._id) return null;
  const base = await ensureCompanyHierarchy({ company });
  if (!base?.companyFolder?.id) return null;

  if (!course?._id) {
    return {
      ...base,
      courseFolder: null,
    };
  }

  const courseFolder = await syncDriveFolder({
    folderId: course.driveFolderId || null,
    folderName: toName(course.title, `Course_${course._id}`),
    parentFolderId: base.companyFolder.id,
  });

  return {
    ...base,
    courseFolder: toFolderPayload(courseFolder),
  };
};

const ensureCollegeHierarchy = async ({ company, course, college }) => {
  if (!company?._id || !college?._id) return null;
  const base = await ensureCourseHierarchy({ company, course });
  const parentFolderId = base?.courseFolder?.id || base?.companyFolder?.id;
  if (!parentFolderId) return null;

  const collegeFolder = await syncDriveFolder({
    folderId: college.driveFolderId || null,
    folderName: toName(college.name, `College_${college._id}`),
    parentFolderId,
  });

  return {
    ...base,
    collegeFolder: toFolderPayload(collegeFolder),
  };
};

const ensureDepartmentHierarchy = async ({
  company,
  course,
  college,
  batch,
  department,
  totalDays = 12,
}) => {
  if (!company?._id) return null;
  const base = college?._id
    ? await ensureCollegeHierarchy({ company, course, college })
    : await ensureCourseHierarchy({ company, course });
  const parentFolderId =
    base?.collegeFolder?.id || base?.courseFolder?.id || base?.companyFolder?.id;
  if (!parentFolderId) return null;

  const departmentFolderName = resolveBatchFolderName({
    batch,
    college,
    department,
    course,
  });
  const knownDepartmentFolderId =
    batch?.driveFolderId ||
    batch?.folderId ||
    batch?.id ||
    department?.driveFolderId ||
    department?.folderId ||
    null;

  let batchFolder = null;
  if (knownDepartmentFolderId) {
    batchFolder = await syncDriveFolder({
      folderId: knownDepartmentFolderId,
      folderName: departmentFolderName,
      parentFolderId,
    });
  } else if (base?.collegeFolder?.id) {
    const folderInCollege = await findDriveFolder({
      folderName: departmentFolderName,
      parentFolderId: base.collegeFolder.id,
    });

    if (folderInCollege?.id) {
      batchFolder = folderInCollege;

      // Cleanup duplicate legacy folders from course level once a college-scoped
      // folder exists, so old and new structures do not coexist.
      if (base?.courseFolder?.id && base.courseFolder.id !== base.collegeFolder.id) {
        const legacyFolder = await findDriveFolder({
          folderName: departmentFolderName,
          parentFolderId: base.courseFolder.id,
        });
        if (legacyFolder?.id && legacyFolder.id !== folderInCollege.id) {
          await deleteFromDrive(legacyFolder.id);
        }
      }
    } else if (base?.courseFolder?.id && base.courseFolder.id !== base.collegeFolder.id) {
      // Legacy migration: move old course-level department folder into college.
      const legacyFolder = await findDriveFolder({
        folderName: departmentFolderName,
        parentFolderId: base.courseFolder.id,
      });

      if (legacyFolder?.id) {
        batchFolder = await moveDriveItemToParent({
          itemId: legacyFolder.id,
          targetParentId: base.collegeFolder.id,
        });
      }
    }
  }

  if (!batchFolder?.id) {
    batchFolder = await ensureDriveFolder({
      folderName: departmentFolderName,
      parentFolderId,
    });
  }

  if (
    batchFolder?.id &&
    base?.collegeFolder?.id &&
    base?.courseFolder?.id &&
    base.courseFolder.id !== base.collegeFolder.id
  ) {
    const legacyFolder = await findDriveFolder({
      folderName: departmentFolderName,
      parentFolderId: base.courseFolder.id,
    });

    if (legacyFolder?.id && legacyFolder.id !== batchFolder.id) {
      await deleteFromDrive(legacyFolder.id);
    }
  }

  const dayFoldersByDayNumber = {};
  const safeDays = Math.max(1, Number(totalDays) || 12);
  for (let dayNumber = 1; dayNumber <= safeDays; dayNumber += 1) {
    dayFoldersByDayNumber[dayNumber] = await ensureDayFolderWithSubFolders({
      parentFolderId: batchFolder.id,
      dayNumber,
    });
  }

  return {
    ...base,
    batchFolder: toFolderPayload(batchFolder),
    // Backward-compatible alias expected by existing routes/models.
    departmentFolder: toFolderPayload(batchFolder),
    dayFoldersByDayNumber,
  };
};

const createFullStructure = async ({
  company,
  course,
  college,
  batch,
  department,
  rootFolderId = null,
  totalDays = 12,
}) => {
  const providedRootFolderId = String(rootFolderId || "").trim();
  const rootFolder = providedRootFolderId
    ? { id: providedRootFolderId, name: "ROOT", webViewLink: null }
    : await ensureTrainingRootFolder();

  if (!rootFolder?.id) {
    throw new Error(
      "Google Drive training root folder is not configured. Set GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_ID or GOOGLE_DRIVE_TRAINING_PARENT_FOLDER_ID.",
    );
  }

  const companyFolder = await ensureDriveFolder({
    folderName: toName(company, "Company"),
    parentFolderId: rootFolder.id,
  });

  const courseFolder = await ensureDriveFolder({
    folderName: toName(course, "Course"),
    parentFolderId: companyFolder.id,
  });

  const collegeName = toName(college?.name || college, "");
  const collegeFolder = collegeName
    ? await ensureDriveFolder({
        folderName: collegeName,
        parentFolderId: courseFolder.id,
      })
    : null;

  const departmentFolderName = resolveBatchFolderName({
    batch,
    college,
    department,
    course,
  });

  let batchFolder = null;
  if (collegeFolder?.id) {
    const folderInCollege = await findDriveFolder({
      folderName: departmentFolderName,
      parentFolderId: collegeFolder.id,
    });

    if (folderInCollege?.id) {
      batchFolder = folderInCollege;

      const legacyFolder = await findDriveFolder({
        folderName: departmentFolderName,
        parentFolderId: courseFolder.id,
      });
      if (legacyFolder?.id && legacyFolder.id !== folderInCollege.id) {
        await deleteFromDrive(legacyFolder.id);
      }
    } else {
      const legacyFolder = await findDriveFolder({
        folderName: departmentFolderName,
        parentFolderId: courseFolder.id,
      });
      if (legacyFolder?.id) {
        batchFolder = await moveDriveItemToParent({
          itemId: legacyFolder.id,
          targetParentId: collegeFolder.id,
        });
      }
    }
  }

  if (!batchFolder?.id) {
    batchFolder = await ensureDriveFolder({
      folderName: departmentFolderName,
      parentFolderId: collegeFolder?.id || courseFolder.id,
    });
  }

  const dayFoldersByDayNumber = {};
  const safeDays = Math.max(1, Number(totalDays) || 12);
  for (let dayNumber = 1; dayNumber <= safeDays; dayNumber += 1) {
    dayFoldersByDayNumber[dayNumber] = await ensureDayFolderWithSubFolders({
      parentFolderId: batchFolder.id,
      dayNumber,
    });
  }

  return {
    rootFolder: toFolderPayload(rootFolder),
    companyFolder: toFolderPayload(companyFolder),
    courseFolder: toFolderPayload(courseFolder),
    collegeFolder: toFolderPayload(collegeFolder),
    batchFolder: toFolderPayload(batchFolder),
    // Backward-compatible aliases
    departmentFolder: toFolderPayload(batchFolder),
    dayFoldersByDayNumber,
  };
};

module.exports = {
  isTrainingDriveEnabled,
  ensureTrainingRootFolder,
  ensureCompanyHierarchy,
  ensureCourseHierarchy,
  ensureCollegeHierarchy,
  ensureDepartmentHierarchy,
  createFullStructure,
  toDepartmentDayFolders,
};
