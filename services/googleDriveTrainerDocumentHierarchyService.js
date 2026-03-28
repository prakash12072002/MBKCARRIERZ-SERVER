const { TrainerDocument } = require("../models");
const {
  DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  ensureDriveFolder,
  findDriveFolder,
  moveDriveItemToParent,
  syncDriveFolder,
} = require("./googleDriveService");

const TRAINERS_FOLDER_NAME = String(
  process.env.GOOGLE_DRIVE_TRAINERS_FOLDER_NAME || "Trainers",
).trim();

const TRAINER_DOCUMENTS_SUBFOLDER_NAME = String(
  process.env.GOOGLE_DRIVE_TRAINER_DOCUMENTS_SUBFOLDER_NAME || "Documents",
).trim();

const normalizeName = (value = "") => String(value || "").trim().toLowerCase();

const toFolderPayload = (folder) => {
  if (!folder?.id) return null;

  return {
    id: folder.id,
    name: folder.name || null,
    link: folder.webViewLink || null,
  };
};

const isDocumentsFolderReference = (trainer = {}) =>
  normalizeName(trainer.driveFolderName) ===
  normalizeName(TRAINER_DOCUMENTS_SUBFOLDER_NAME);

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

  const trainersFolder = await ensureDriveFolder({
    parentFolderId: DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
    folderName: TRAINERS_FOLDER_NAME,
  });

  let existingTrainerFolderId = null;
  let existingDocumentsFolderId = null;

  if (isDocumentsFolderReference(trainer)) {
    existingDocumentsFolderId = trainer.driveFolderId || null;
    const existingTrainerFolder = await findDriveFolder({
      folderName: trainerCode,
      parentFolderId: trainersFolder.id,
    });
    existingTrainerFolderId = existingTrainerFolder?.id || null;
  } else {
    existingTrainerFolderId = trainer.driveFolderId || null;
  }

  const trainerFolder = await syncDriveFolder({
    folderId: existingTrainerFolderId,
    folderName: trainerCode,
    parentFolderId: trainersFolder.id,
  });

  const documentsFolder = await syncDriveFolder({
    folderId: existingDocumentsFolderId,
    folderName: TRAINER_DOCUMENTS_SUBFOLDER_NAME,
    parentFolderId: trainerFolder.id,
  });

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
    trainersFolder: toFolderPayload(trainersFolder),
    trainerFolder: toFolderPayload(trainerFolder),
    documentsFolder: toFolderPayload(documentsFolder),
  };
};

module.exports = {
  TRAINERS_FOLDER_NAME,
  TRAINER_DOCUMENTS_SUBFOLDER_NAME,
  ensureTrainerDocumentHierarchy,
};
