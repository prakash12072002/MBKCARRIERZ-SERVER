const googleDriveService = require("../../services/googleDriveService");
const driveHierarchyService = require("./driveHierarchy.service");
const driveTrainerDocumentsService = require("./driveTrainerDocuments.service");

module.exports = {
  // Low-level Drive IO helpers (single module access point)
  uploadToDrive: googleDriveService.uploadToDrive,
  uploadToDriveWithRetry: googleDriveService.uploadToDriveWithRetry,
  deleteFromDrive: googleDriveService.deleteFromDrive,
  ensureDriveFolder: googleDriveService.ensureDriveFolder,
  listDriveFolderChildren: googleDriveService.listDriveFolderChildren,
  mergeDuplicateDriveFolders: googleDriveService.mergeDuplicateDriveFolders,
  cleanupDuplicateDriveFilesByName:
    googleDriveService.cleanupDuplicateDriveFilesByName,

  // Training hierarchy + canonical day folders
  isTrainingDriveEnabled: driveHierarchyService.isTrainingDriveEnabled,
  ensureTrainingRootFolder: driveHierarchyService.ensureTrainingRootFolder,
  ensureCompanyHierarchy: driveHierarchyService.ensureCompanyHierarchy,
  ensureCourseHierarchy: driveHierarchyService.ensureCourseHierarchy,
  ensureCollegeHierarchy: driveHierarchyService.ensureCollegeHierarchy,
  ensureDepartmentHierarchy: driveHierarchyService.ensureDepartmentHierarchy,
  createFullStructure: driveHierarchyService.createFullStructure,
  toDepartmentDayFolders: driveHierarchyService.toDepartmentDayFolders,

  // Trainer-document hierarchy helpers
  ensureTrainerDocumentHierarchy:
    driveTrainerDocumentsService.ensureTrainerDocumentHierarchy,
};
