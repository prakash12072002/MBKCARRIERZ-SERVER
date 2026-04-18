const { TrainerDocument } = require("../../models");
const {
  DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  ensureDriveFolder,
  findDriveFolder,
  moveDriveItemToParent,
  syncDriveFolder,
} = require("../../services/googleDriveService");

const TRAINER_REGISTRATION_FOLDER_NAME = String(
  process.env.GOOGLE_DRIVE_TRAINER_REGISTRATION_FOLDER_NAME ||
    "REGISTER DOCUMENT",
).trim();

const TRAINER_DOCUMENTS_SUBFOLDER_NAME = String(
  process.env.GOOGLE_DRIVE_TRAINER_DOCUMENTS_SUBFOLDER_NAME || "",
).trim();

const normalizeName = (value = "") => String(value || "").trim().toLowerCase();

const LEGACY_TRAINER_DOCUMENTS_FOLDER_NAMES = [
  TRAINER_DOCUMENTS_SUBFOLDER_NAME,
  "Documents",
  "Trainer Documents",
]
  .map((value) => normalizeName(value))
  .filter(Boolean);

const toFolderPayload = (folder) => {
  if (!folder?.id) return null;

  return {
    id: folder.id,
    name: folder.name || null,
    link: folder.webViewLink || null,
  };
};

const isDocumentsFolderReference = (trainer = {}) =>
  Boolean(trainer?.driveFolderId) &&
  LEGACY_TRAINER_DOCUMENTS_FOLDER_NAMES.includes(
    normalizeName(trainer?.driveFolderName),
  );

const ensureTrainerCode = async (trainer) => {
  if (!trainer) {
    throw new Error("Trainer record is required.");
  }

  if (!trainer.trainerId) {
    await trainer.save();
  }

  if (!trainer.trainerId) {
    throw new Error("Trainer ID could not be generated.");
  }

  return trainer.trainerId;
};

const syncTrainerDocumentRecords = async ({ trainerId, documentsFolder }) => {
  if (!trainerId || !documentsFolder?.id) return;

  const trainerDocuments = await TrainerDocument.find({
    trainerId,
  }).select("_id driveFileId driveFolderId driveFolderName");

  for (const document of trainerDocuments) {
    let canPersistFolderMetadata = true;

    if (document.driveFileId && document.driveFolderId !== documentsFolder.id) {
      try {
        await moveDriveItemToParent({
          itemId: document.driveFileId,
          targetParentId: documentsFolder.id,
        });
      } catch (error) {
        canPersistFolderMetadata = false;
        console.warn(
          `[GOOGLE-DRIVE] Failed to move trainer document ${document._id} into "${documentsFolder.name}": ${error.message}`,
        );
      }
    }

    if (
      canPersistFolderMetadata &&
      (document.driveFolderId !== documentsFolder.id ||
        document.driveFolderName !== documentsFolder.name)
    ) {
      document.driveFolderId = documentsFolder.id;
      document.driveFolderName = documentsFolder.name || null;
      await document.save();
    }
  }
};

const ensureTrainerDocumentHierarchy = async ({
  trainer,
  persistTrainer = true,
  syncExistingDocuments = false,
} = {}) => {
  if (!DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID) {
    throw new Error("Google Drive folder ID is required.");
  }

  const trainerCode = await ensureTrainerCode(trainer);

  const registrationFolder = await ensureDriveFolder({
    parentFolderId: DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
    folderName: TRAINER_REGISTRATION_FOLDER_NAME,
  });

  const legacyTrainersFolderName = String(
    process.env.GOOGLE_DRIVE_TRAINERS_FOLDER_NAME || "Trainers",
  ).trim();
  const legacyTrainersFolder = await findDriveFolder({
    folderName: legacyTrainersFolderName,
    parentFolderId: DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  });

  let existingTrainerFolderId = null;
  let existingDocumentsFolderId = null;

  if (isDocumentsFolderReference(trainer)) {
    existingDocumentsFolderId = trainer.driveFolderId || null;
    const existingTrainerFolder = await findDriveFolder({
      folderName: trainerCode,
      parentFolderId: registrationFolder.id,
    });
    existingTrainerFolderId = existingTrainerFolder?.id || null;

    if (!existingTrainerFolderId && legacyTrainersFolder?.id) {
      const existingLegacyTrainerFolder = await findDriveFolder({
        folderName: trainerCode,
        parentFolderId: legacyTrainersFolder.id,
      });
      existingTrainerFolderId = existingLegacyTrainerFolder?.id || null;
    }
  } else {
    const existingTrainerFolder = await findDriveFolder({
      folderName: trainerCode,
      parentFolderId: registrationFolder.id,
    });
    existingTrainerFolderId = existingTrainerFolder?.id || null;

    if (!existingTrainerFolderId && legacyTrainersFolder?.id) {
      const existingLegacyTrainerFolder = await findDriveFolder({
        folderName: trainerCode,
        parentFolderId: legacyTrainersFolder.id,
      });
      existingTrainerFolderId = existingLegacyTrainerFolder?.id || null;
    }

    if (!existingTrainerFolderId && trainer.driveFolderId) {
      // Last-resort fallback for older/stale DB pointers.
      // Prefer canonical name-based lookup first to avoid hard failures on inaccessible IDs.
      existingTrainerFolderId = trainer.driveFolderId || null;
    }
  }

  const trainerFolder = await syncDriveFolder({
    folderId: existingTrainerFolderId,
    folderName: trainerCode,
    parentFolderId: registrationFolder.id,
  });

  const documentsFolder = TRAINER_DOCUMENTS_SUBFOLDER_NAME
    ? await syncDriveFolder({
        folderId: existingDocumentsFolderId,
        folderName: TRAINER_DOCUMENTS_SUBFOLDER_NAME,
        parentFolderId: trainerFolder.id,
      })
    : trainerFolder;

  if (
    trainer.driveFolderId !== trainerFolder.id ||
    trainer.driveFolderName !== trainerFolder.name
  ) {
    trainer.driveFolderId = trainerFolder.id;
    trainer.driveFolderName = trainerFolder.name;

    if (persistTrainer) {
      await trainer.save();
    }
  }

  if (syncExistingDocuments) {
    await syncTrainerDocumentRecords({
      trainerId: trainer._id,
      documentsFolder,
    });
  }

  return {
    rootFolder: {
      id: DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
      name: null,
      link: null,
    },
    trainersFolder: toFolderPayload(registrationFolder),
    trainerFolder: toFolderPayload(trainerFolder),
    documentsFolder: toFolderPayload(documentsFolder),
  };
};

module.exports = {
  TRAINER_REGISTRATION_FOLDER_NAME,
  TRAINER_DOCUMENTS_SUBFOLDER_NAME,
  ensureTrainerDocumentHierarchy,
};
