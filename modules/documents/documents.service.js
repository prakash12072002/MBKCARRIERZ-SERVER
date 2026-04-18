const fs = require("fs").promises;
const mongoose = require("mongoose");
const path = require("path");
const bcrypt = require("bcryptjs");
const {
  uploadToDrive,
  deleteFromDrive,
  ensureTrainerDocumentHierarchy,
  cleanupDuplicateDriveFilesByName,
} = require("../drive/driveGateway");
const {
  enqueueFileWorkflowJob,
  registerFileWorkflowJobHandler,
} = require("../../jobs/queues/fileWorkflowQueue");
const { FILE_WORKFLOW_JOB_TYPES } = require("../../jobs/fileWorkflowJobTypes");
const { updateUserAvatar } = require("../../services/streamChatService");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");
const {
  sendAdminSubmissionNotificationEmail,
  sendDocumentRejectionEmail,
  sendProfileRejectionEmail,
  sendTrainerApprovalEmail,
} = require("../../utils/emailService");
const {
  normalizeTrainerDocumentVerificationStatus,
  normalizeTrainerOverallStatus,
} = require("../../utils/statusNormalizer");
const {
  evaluateTrainerDocumentWorkflow,
  REQUIRED_TRAINER_DOCUMENTS,
  syncTrainerDocumentWorkflow,
} = require("../../utils/trainerDocumentWorkflow");
const { sendTrainerDocumentReminderEmail } = require("../../utils/emailService");
const {
  activateUserById,
  createNotificationRecord,
  createTrainerDocument,
  deleteTrainerDocumentRecord,
  findDocumentByIdWithTrainerUser,
  findNdaDocumentsForTrainer,
  findTrainerById,
  findTrainerByEmail,
  findTrainerByIdWithUser,
  findTrainerDocumentByTypeCandidates,
  findTrainerByUserId,
  findTrainerForNdaBackfill,
  findUserById,
  findUserByIdWithPlainPassword,
  findUsersByRole,
  listTrainerDocumentsByTrainerId,
  listTrainerDocumentsByTrainerIdExcluding,
  resetUserForTrainerSubmission,
  saveTrainerDocument,
  saveTrainerRecord,
  updateUserPasswordById,
  updateUserProfilePictureById,
  upsertLegacyNdaDocument,
} = require("./documents.repository");
const {
  DOCUMENT_NOT_FOUND_MESSAGE,
  DOCUMENT_UPLOAD_FAILED_MESSAGE,
  DOCUMENT_UPLOAD_SUCCESS_MESSAGE,
  ACCESS_DENIED_MESSAGE,
  INVALID_DOCUMENT_TYPE_MESSAGE,
  INVALID_DOCUMENT_ID_MESSAGE,
  INVALID_STATUS_MESSAGE,
  INVALID_TRAINER_ID_MESSAGE,
  INVALID_VERIFICATION_STATUS_MESSAGE,
  MOVE_TO_REVIEW_SUCCESS_MESSAGE,
  NDA_DEFAULT_FILE_NAME,
  NO_FILE_UPLOADED_MESSAGE,
  NOTIFICATION_TYPE_APPROVAL,
  SUBMISSION_RECEIVED_MESSAGE,
  SUBMISSION_RECEIVED_TITLE,
  SUBMIT_VERIFICATION_SUCCESS_MESSAGE,
  TRAINER_HAS_REJECTED_DOCUMENTS_MESSAGE,
  TRAINER_LOGIN_ROUTE,
  TRAINER_MISSING_REQUIRED_DOCUMENTS_MESSAGE,
  TRAINER_NO_OUTSTANDING_DOCUMENTS_MESSAGE,
  TRAINER_NOT_FOUND_MESSAGE,
  TRAINER_PROFILE_ROUTE,
  TRAINER_REMINDER_SUCCESS_MESSAGE,
  TRAINER_PROFILE_NOT_FOUND_MESSAGE,
  TRAINER_SIGNUP_RESUME_LINK,
  VALID_NOTIFICATION_ROLES,
  VERIFY_DOCUMENT_REJECTED_CLEANUP_WARNING_MESSAGE,
  VERIFY_DOCUMENT_REJECTED_SUCCESS_MESSAGE,
  VERIFY_DOCUMENT_SUCCESS_MESSAGE,
} = require("./documents.types");

const isValidObjectId = (id) =>
  typeof id === "string" && mongoose.Types.ObjectId.isValid(id);

const normalizeTrainerDocumentType = (documentType) => {
  if (documentType === "ntaAgreement" || documentType === "NDAAgreement") {
    return "ndaAgreement";
  }

  return documentType;
};

const getTrainerDocumentTypeCandidates = (documentType) => {
  const normalizedType = normalizeTrainerDocumentType(documentType);

  if (normalizedType === "ndaAgreement") {
    return [normalizedType, "ntaAgreement", "NDAAgreement"];
  }

  return [normalizedType];
};

const normalizeTrainerDocumentRecord = (document) => {
  const plainDocument = document?.toObject ? document.toObject() : { ...(document || {}) };

  return {
    ...plainDocument,
    documentType: normalizeTrainerDocumentType(plainDocument.documentType),
  };
};

const isAbsoluteUrl = (value = "") => /^https?:\/\//i.test(String(value || "").trim());

const normalizeStoredDocumentPath = (value = "") => {
  const normalized = String(value || "").trim();
  if (!normalized) return null;

  return isAbsoluteUrl(normalized)
    ? normalized
    : `/${normalized.replace(/^\/+/, "")}`;
};

const createStatusError = (statusCode, message, extras = null) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extras && typeof extras === "object") {
    Object.assign(error, extras);
  }
  return error;
};

const documentsUploadLogger = createStructuredLogger({
  service: "documents",
  component: "upload-flow",
});

const logUploadTelemetry = (level, fields = {}) => {
  const method = typeof documentsUploadLogger[level] === "function" ? level : "info";
  documentsUploadLogger[method]({
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
    contextLabel: fields.contextLabel || null,
    documentType: fields.documentType || null,
    targetTrainerId: fields.targetTrainerId || null,
    driveFileId: fields.driveFileId || null,
    isAdminUpload:
      typeof fields.isAdminUpload === "boolean" ? fields.isAdminUpload : null,
  });
};

const DOCUMENT_TYPE_ALIASES = Object.freeze({
  aadhar_front: "aadharFront",
  aadhar_back: "aadharBack",
  bank_passbook: "passbook",
  bank_document: "passbook",
  degree_certificate: "degreePdf",
  degreeCertificate: "degreePdf",
  resume: "resumePdf",
  profilePhoto: "selfiePhoto",
  photo: "passportPhoto",
  ntaAgreement: "ndaAgreement",
  NDAAgreement: "ndaAgreement",
});

const ALLOWED_TYPES_MAP = Object.freeze({
  selfiePhoto: ["image/jpeg", "image/png"],
  passportPhoto: ["image/jpeg", "image/png"],
  aadharFront: ["image/jpeg", "image/png", "application/pdf"],
  aadharBack: ["image/jpeg", "image/png", "application/pdf"],
  pan: ["image/jpeg", "image/png", "application/pdf"],
  passbook: ["image/jpeg", "image/png", "application/pdf"],
  degreePdf: ["image/jpeg", "image/png", "application/pdf"],
  resumePdf: ["application/pdf"],
  ndaAgreement: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
});

const MIME_TYPE_BY_EXTENSION = Object.freeze({
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

const resolveUploadMimeType = (file = {}) => {
  const rawMimeType = String(file?.mimetype || "").trim().toLowerCase();
  if (rawMimeType && rawMimeType !== "application/octet-stream") {
    return rawMimeType;
  }

  const extension = path.extname(String(file?.originalname || "")).toLowerCase();
  return MIME_TYPE_BY_EXTENSION[extension] || rawMimeType;
};

const FIXED_TRAINER_DOCUMENT_FILE_NAMES = Object.freeze({
  selfiePhoto: "Selfie",
  passportPhoto: "ProfilePhoto",
  aadharFront: "Aadhar-Front",
  aadharBack: "Aadhar-Back",
  pan: "PAN",
  passbook: "BankProof",
  degreePdf: "Certificate",
  resumePdf: "Resume",
  ndaAgreement: "NDA-Form",
});

const FIXED_DOCUMENT_EXTENSION_MAP = Object.freeze({
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
});

let trainerDocumentCleanupJobRegistered = false;
const ensureTrainerDocumentCleanupJobRegistration = ({
  deleteDriveFileLoader = deleteFromDrive,
  deleteLegacyFileLoader = deleteLegacyLocalDocument,
} = {}) => {
  if (trainerDocumentCleanupJobRegistered) return;

  registerFileWorkflowJobHandler(
    FILE_WORKFLOW_JOB_TYPES.DRIVE_FILE_CLEANUP,
    async (payload = {}, job = {}) => {
      const correlationId = payload?.correlationId || createCorrelationId("doc_cleanup");
      const attempt = Number.parseInt(job?.attempt || "0", 10) + 1;
      const cleanupMode = payload?.driveFileId ? "drive_file" : "local_file";

      logUploadTelemetry("debug", {
        correlationId,
        stage: "cleanup_worker_started",
        status: "cleanup_worker",
        outcome: "started",
        attempt,
        cleanupMode,
        driveFileId: payload?.driveFileId || null,
      });

      if (payload.driveFileId) {
        await deleteDriveFileLoader(payload.driveFileId);
      } else if (payload.filePath) {
        await deleteLegacyFileLoader(payload.filePath, {
          correlationId,
          contextLabel: payload?.contextLabel || "trainer-document-cleanup",
        });
      }

      logUploadTelemetry("info", {
        correlationId,
        stage: "cleanup_worker_succeeded",
        status: "cleanup_worker",
        outcome: "succeeded",
        attempt,
        cleanupMode,
        driveFileId: payload?.driveFileId || null,
      });
    },
  );

  trainerDocumentCleanupJobRegistered = true;
};

const queueTrainerDocumentCleanup = ({
  driveFileId = null,
  filePath = null,
  contextLabel = "trainer-document-cleanup",
  correlationId = null,
  ensureRegistrationLoader = ensureTrainerDocumentCleanupJobRegistration,
  enqueueCleanupJobLoader = enqueueFileWorkflowJob,
  deleteDriveFileLoader = deleteFromDrive,
  deleteLegacyFileLoader = deleteLegacyLocalDocument,
} = {}) => {
  if (!driveFileId && !filePath) return false;
  const resolvedCorrelationId = correlationId || createCorrelationId("doc_cleanup");

  ensureRegistrationLoader();

  enqueueCleanupJobLoader({
    type: FILE_WORKFLOW_JOB_TYPES.DRIVE_FILE_CLEANUP,
    payload: {
      driveFileId: driveFileId || null,
      filePath: filePath || null,
      contextLabel,
      correlationId: resolvedCorrelationId,
    },
    maxAttempts: 3,
  }).catch((error) => {
    logUploadTelemetry("warn", {
      correlationId: resolvedCorrelationId,
      stage: "cleanup_job_enqueue_failed",
      status: "cleanup_queued",
      outcome: "failed",
      cleanupMode: "queue",
      attempt: 1,
      reason: error.message,
    });

    // Best-effort fallback when queueing fails: try immediate cleanup asynchronously.
    if (driveFileId) {
      deleteDriveFileLoader(driveFileId)
        .then(() => {
          logUploadTelemetry("info", {
            correlationId: resolvedCorrelationId,
            stage: "cleanup_fallback_drive_succeeded",
            status: "cleanup_fallback",
            outcome: "succeeded",
            cleanupMode: "drive_file",
            attempt: 1,
            driveFileId,
          });
        })
        .catch((fallbackError) => {
          logUploadTelemetry("warn", {
            correlationId: resolvedCorrelationId,
            stage: "cleanup_fallback_drive_failed",
            status: "cleanup_fallback",
            outcome: "failed",
            cleanupMode: "drive_file",
            attempt: 1,
            reason: fallbackError.message,
            driveFileId,
          });
        });
      return;
    }

    if (filePath) {
      deleteLegacyFileLoader(filePath, {
        correlationId: resolvedCorrelationId,
        contextLabel,
      })
        .then(() => {
          logUploadTelemetry("info", {
            correlationId: resolvedCorrelationId,
            stage: "cleanup_fallback_local_succeeded",
            status: "cleanup_fallback",
            outcome: "succeeded",
            cleanupMode: "local_file",
            attempt: 1,
          });
        })
        .catch((fallbackError) => {
          logUploadTelemetry("warn", {
            correlationId: resolvedCorrelationId,
            stage: "cleanup_fallback_local_failed",
            status: "cleanup_fallback",
            outcome: "failed",
            cleanupMode: "local_file",
            attempt: 1,
            reason: fallbackError.message,
          });
        });
    }
  });

  return true;
};

const buildFixedTrainerDocumentFileName = (documentType, mimetype, originalName) => {
  const baseName =
    FIXED_TRAINER_DOCUMENT_FILE_NAMES[documentType] || documentType || "Document";
  const extension =
    FIXED_DOCUMENT_EXTENSION_MAP[mimetype] ||
    path.extname(originalName || "") ||
    "";

  return `${baseName}${extension}`;
};

const getTrainerStepLabel = (step) => {
  const stepLabels = {
    1: "Email Verify",
    2: "Details",
    3: "Upload Documents",
    4: "Agreement",
    5: "Password",
    6: "Completed",
  };

  return stepLabels[Number(step) || 1] || "Registration";
};

const buildTrainerStepLockMessage = (requiredStep, currentStep) => {
  const requiredLabel = getTrainerStepLabel(requiredStep);
  const currentLabel = getTrainerStepLabel(currentStep);

  if (currentStep > requiredStep) {
    return `${requiredLabel} is already completed and locked. Continue from ${currentLabel}.`;
  }

  return `${requiredLabel} is not available yet. Continue from ${currentLabel}.`;
};

const getTrainerRegistrationAccessState = async (
  trainer,
  {
    listTrainerDocumentsLoader = listTrainerDocumentsByTrainerId,
    syncTrainerDocumentWorkflowLoader = syncTrainerDocumentWorkflow,
    saveTrainerLoader = saveTrainerRecord,
  } = {},
) => {
  const trainerDocuments = await listTrainerDocumentsLoader({ trainerId: trainer._id });
  const workflow = syncTrainerDocumentWorkflowLoader(trainer, trainerDocuments);
  await saveTrainerLoader({ trainer });

  return {
    trainerDocuments,
    workflow,
    currentStep: Number(trainer.registrationStep || 1),
    registrationStatus: String(trainer.registrationStatus || "pending")
      .trim()
      .toLowerCase(),
  };
};

const buildRejectTrainerStepAccessPayload = ({
  requiredStep,
  currentStep,
  registrationStatus,
  workflow,
}) => {
  if (registrationStatus === "approved") {
    return {
      success: false,
      message:
        "Registration is already approved. Trainer onboarding steps are locked.",
      data: {
        registrationStep: 6,
        registrationStatus,
        nextStepLabel: getTrainerStepLabel(6),
        documentStatus: workflow?.documentStatus || null,
      },
    };
  }

  if (registrationStatus === "under_review") {
    return {
      success: false,
      message:
        "Registration is already submitted for admin review. Trainer onboarding steps are locked.",
      data: {
        registrationStep: 6,
        registrationStatus,
        nextStepLabel: getTrainerStepLabel(6),
        documentStatus: workflow?.documentStatus || null,
      },
    };
  }

  return {
    success: false,
    message: buildTrainerStepLockMessage(requiredStep, currentStep),
    data: {
      registrationStep: currentStep,
      registrationStatus,
      nextStepLabel: getTrainerStepLabel(currentStep),
      documentStatus: workflow?.documentStatus || null,
    },
  };
};

const listMyDocumentsFeed = async ({
  userId,
  findTrainerByUserIdLoader = findTrainerByUserId,
  listTrainerDocumentsLoader = listTrainerDocumentsByTrainerId,
} = {}) => {
  const trainer = await findTrainerByUserIdLoader({ userId });
  if (!trainer) {
    throw createStatusError(404, TRAINER_PROFILE_NOT_FOUND_MESSAGE);
  }

  const documents = await listTrainerDocumentsLoader({
    trainerId: trainer._id,
  });

  return {
    success: true,
    data: documents.map(normalizeTrainerDocumentRecord),
  };
};

const listTrainerDocumentsFeed = async ({
  trainerId,
  findTrainerForNdaBackfillLoader = findTrainerForNdaBackfill,
  listTrainerDocumentsLoader = listTrainerDocumentsByTrainerId,
  upsertLegacyNdaDocumentLoader = upsertLegacyNdaDocument,
} = {}) => {
  if (!isValidObjectId(trainerId)) {
    throw createStatusError(400, INVALID_TRAINER_ID_MESSAGE);
  }

  const trainer = await findTrainerForNdaBackfillLoader({ trainerId });
  const NDAPath =
    normalizeStoredDocumentPath(trainer?.documents?.ndaAgreement) ||
    normalizeStoredDocumentPath(trainer?.documents?.ntaAgreement) ||
    normalizeStoredDocumentPath(trainer?.documents?.NDAAgreement) ||
    normalizeStoredDocumentPath(trainer?.ndaAgreementPdf) ||
    normalizeStoredDocumentPath(trainer?.ntaAgreementPdf) ||
    normalizeStoredDocumentPath(trainer?.NDAAgreementPdf);

  if (NDAPath) {
    await upsertLegacyNdaDocumentLoader({
      trainerId,
      documentTypeCandidates: getTrainerDocumentTypeCandidates("ndaAgreement"),
      setOnInsert: {
        fileName: isAbsoluteUrl(NDAPath)
          ? NDA_DEFAULT_FILE_NAME
          : path.basename(NDAPath),
        filePath: NDAPath,
        mimeType: "application/pdf",
        verificationStatus: "PENDING",
        verificationComment: null,
        verifiedAt: null,
        verifiedBy: null,
      },
    });
  }

  const documents = await listTrainerDocumentsLoader({ trainerId });

  return {
    success: true,
    data: documents.map(normalizeTrainerDocumentRecord),
  };
};

const uploadTrainerDocumentFeed = async ({
  payload = {},
  file = null,
  actorUser = null,
  findTrainerByIdLoader = findTrainerById,
  findTrainerByEmailLoader = findTrainerByEmail,
  findTrainerByUserIdLoader = findTrainerByUserId,
  saveTrainerLoader = saveTrainerRecord,
  getTrainerRegistrationAccessStateLoader = getTrainerRegistrationAccessState,
  buildRejectTrainerStepAccessPayloadLoader = buildRejectTrainerStepAccessPayload,
  findTrainerDocumentByTypeCandidatesLoader = findTrainerDocumentByTypeCandidates,
  ensureTrainerDocumentHierarchyLoader = ensureTrainerDocumentHierarchy,
  buildFixedTrainerDocumentFileNameLoader = buildFixedTrainerDocumentFileName,
  uploadToDriveLoader = uploadToDrive,
  deleteDriveFileLoader = deleteFromDrive,
  cleanupDuplicateDriveFilesByNameLoader = cleanupDuplicateDriveFilesByName,
  saveDocumentLoader = saveTrainerDocument,
  createDocumentLoader = createTrainerDocument,
  listTrainerDocumentsLoader = listTrainerDocumentsByTrainerId,
  syncTrainerDocumentWorkflowLoader = syncTrainerDocumentWorkflow,
  updateUserProfilePictureLoader = updateUserProfilePictureById,
  updateUserAvatarLoader = updateUserAvatar,
  queueTrainerDocumentCleanupLoader = queueTrainerDocumentCleanup,
} = {}) => {
  const {
    documentType,
    accountNumber,
    bankName,
    ifscCode,
    email,
    targetTrainerId,
  } = payload;
  const correlationId = createCorrelationId("doc_upload");
  const baseTelemetry = {
    correlationId,
    documentType: documentType || null,
    targetTrainerId: targetTrainerId || null,
  };

  logUploadTelemetry("info", {
    ...baseTelemetry,
    stage: "upload_started",
    status: "accepted",
    outcome: "started",
  });

  if (!file) {
    throw createStatusError(400, NO_FILE_UPLOADED_MESSAGE);
  }

  let trainer = null;
  const actorRole = String(actorUser?.role || "").trim();
  const actorUserId = actorUser?.id || actorUser?._id || null;
  const isAdminUpload = Boolean(
    targetTrainerId &&
      actorUser &&
      ["SuperAdmin", "Admin"].includes(actorRole),
  );

  if (isAdminUpload) {
    if (!isValidObjectId(String(targetTrainerId))) {
      throw createStatusError(400, INVALID_TRAINER_ID_MESSAGE);
    }
    trainer = await findTrainerByIdLoader({ trainerId: targetTrainerId });
  } else if (email) {
    trainer = await findTrainerByEmailLoader({ email });
  } else if (actorUserId) {
    trainer = await findTrainerByUserIdLoader({ userId: actorUserId });
  }

  if (!trainer) {
    throw createStatusError(404, TRAINER_PROFILE_NOT_FOUND_MESSAGE);
  }

  logUploadTelemetry("info", {
    ...baseTelemetry,
    stage: "trainer_resolved",
    trainerId: String(trainer._id),
    isAdminUpload,
    status: "validated",
    outcome: "resolved",
  });

  if (!isAdminUpload) {
    const accessState = await getTrainerRegistrationAccessStateLoader(trainer);
    if (
      accessState.registrationStatus !== "pending" ||
      accessState.currentStep !== 3
    ) {
      throw createStatusError(
        409,
        buildTrainerStepLockMessage(3, accessState.currentStep),
        {
          responsePayload: buildRejectTrainerStepAccessPayloadLoader({
            requiredStep: 3,
            currentStep: accessState.currentStep,
            registrationStatus: accessState.registrationStatus,
            workflow: accessState.workflow,
          }),
        },
      );
    }
  }

  if (!trainer.trainerId) {
    await saveTrainerLoader({ trainer });
  }

  if (!trainer.trainerId) {
    throw createStatusError(
      500,
      "Trainer ID could not be generated for document upload",
    );
  }

  const normalizedDocType = DOCUMENT_TYPE_ALIASES[documentType] || documentType;
  if (!ALLOWED_TYPES_MAP[normalizedDocType]) {
    throw createStatusError(400, INVALID_DOCUMENT_TYPE_MESSAGE);
  }

  const resolvedMimeType = resolveUploadMimeType(file);

  if (!ALLOWED_TYPES_MAP[normalizedDocType].includes(resolvedMimeType)) {
    throw createStatusError(
      400,
      `Invalid file type for ${normalizedDocType}. Expected: ${ALLOWED_TYPES_MAP[normalizedDocType].join(", ")}`,
    );
  }

  const existingDoc = await findTrainerDocumentByTypeCandidatesLoader({
    trainerId: trainer._id,
    documentTypeCandidates: getTrainerDocumentTypeCandidates(normalizedDocType),
  });

  const hierarchy = await ensureTrainerDocumentHierarchyLoader({
    trainer,
    persistTrainer: false,
    syncExistingDocuments: true,
  });
  const trainerDriveFolder = hierarchy.trainerFolder;
  const trainerDocumentsFolder = hierarchy.documentsFolder;
  trainer.driveFolderId = trainerDriveFolder.id;
  trainer.driveFolderName = trainerDriveFolder.name;

  const fixedDriveFileName = buildFixedTrainerDocumentFileNameLoader(
    normalizedDocType,
    resolvedMimeType,
    file.originalname,
  );

  const driveUpload = await uploadToDriveLoader({
    fileBuffer: file.buffer,
    mimeType: resolvedMimeType,
    originalName: file.originalname,
    folderId: trainerDocumentsFolder.id,
    fileName: fixedDriveFileName,
    replaceExistingFile: false,
    cleanupDuplicateFiles: false,
  });

  const fileLink = driveUpload.fileUrl;
  logUploadTelemetry("info", {
    ...baseTelemetry,
    stage: "drive_upload_succeeded",
    trainerId: String(trainer._id),
    documentType: normalizedDocType,
    driveFileId: driveUpload.fileId,
    status: "drive_upload",
    outcome: "succeeded",
    attempt: 1,
  });
  const previousDriveFileId = existingDoc?.driveFileId || null;
  const previousFilePath = existingDoc?.filePath || null;

  const documentData = {
    trainerId: trainer._id,
    documentType: normalizedDocType,
    fileName: fixedDriveFileName,
    filePath: fileLink,
    driveFileId: driveUpload.fileId,
    driveViewLink: driveUpload.webViewLink,
    driveDownloadLink: driveUpload.downloadLink,
    driveFolderId: trainerDocumentsFolder.id,
    driveFolderName: trainerDocumentsFolder.name,
    fileSize: file.size,
    mimeType: resolvedMimeType,
    verificationStatus: "PENDING",
    verifiedAt: null,
    verificationComment: null,
  };

  if (normalizedDocType === "passbook") {
    documentData.accountNumber = accountNumber;
    documentData.bankName = bankName;
    documentData.ifscCode = ifscCode;
  }

  let document;
  try {
    if (existingDoc) {
      Object.assign(existingDoc, documentData);
      await saveDocumentLoader({ document: existingDoc });
      document = existingDoc;
    } else {
      document = await createDocumentLoader({ payload: documentData });
    }

    trainer.documents = trainer.documents || {};
    trainer.documents[normalizedDocType] = fileLink;

    if (normalizedDocType === "ndaAgreement") {
      trainer.ndaAgreementPdf = fileLink;
      trainer.ntaAgreementPdf = fileLink;
      trainer.documents.ndaAgreement = fileLink;
      trainer.documents.ntaAgreement = fileLink;
    }

    if (!trainer.documents.verification) {
      trainer.documents.verification = new Map();
    }
    trainer.documents.verification.set(normalizedDocType, {
      verified: false,
      reason: null,
      updatedAt: new Date(),
    });

    const shouldSetAsProfilePicture =
      normalizedDocType === "selfiePhoto" ||
      (normalizedDocType === "passportPhoto" && !trainer.documents?.selfiePhoto);

    if (shouldSetAsProfilePicture) {
      trainer.profilePicture = fileLink;
    }

    const trainerDocuments = await listTrainerDocumentsLoader({
      trainerId: trainer._id,
    });
    const workflow = syncTrainerDocumentWorkflowLoader(trainer, trainerDocuments);
    await saveTrainerLoader({ trainer });

    if (shouldSetAsProfilePicture && trainer.userId) {
      await updateUserProfilePictureLoader({
        userId: trainer.userId,
        profilePicture: fileLink,
      });
      try {
        await updateUserAvatarLoader(String(trainer.userId), fileLink);
      } catch (chatErr) {
        logUploadTelemetry("warn", {
          ...baseTelemetry,
          stage: "stream_avatar_sync_failed",
          trainerId: String(trainer._id),
          documentType: normalizedDocType,
          status: "stream_sync",
          outcome: "failed",
          reason: chatErr.message,
        });
      }
    }

    logUploadTelemetry("info", {
      ...baseTelemetry,
      stage: "trainer_workflow_updated",
      trainerId: String(trainer._id),
      documentType: normalizedDocType,
      status: "workflow_sync",
      outcome: "succeeded",
    });

    try {
      await cleanupDuplicateDriveFilesByNameLoader({
        folderId: trainerDocumentsFolder.id,
        fileName: fixedDriveFileName,
        keepFileId: driveUpload.fileId,
      });
    } catch (driveDuplicateCleanupError) {
      logUploadTelemetry("warn", {
        ...baseTelemetry,
        stage: "drive_duplicate_cleanup_failed",
        trainerId: String(trainer._id),
        documentType: normalizedDocType,
        driveFileId: driveUpload.fileId,
        status: "cleanup",
        outcome: "failed",
        cleanupMode: "drive_duplicate",
        reason: driveDuplicateCleanupError.message,
      });
    }

    if (existingDoc) {
      try {
        if (previousDriveFileId && previousDriveFileId !== driveUpload.fileId) {
          queueTrainerDocumentCleanupLoader({
            driveFileId: previousDriveFileId,
            contextLabel: "trainer-document-replaced",
            correlationId,
          });
        } else if (previousFilePath && previousFilePath !== fileLink) {
          queueTrainerDocumentCleanupLoader({
            filePath: previousFilePath,
            contextLabel: "trainer-document-local-replaced",
            correlationId,
          });
        }
      } catch (cleanupQueueError) {
        logUploadTelemetry("warn", {
          ...baseTelemetry,
          stage: "cleanup_queue_call_failed",
          trainerId: String(trainer._id),
          documentType: normalizedDocType,
          status: "cleanup_queued",
          outcome: "failed",
          cleanupMode: "queue",
          reason: cleanupQueueError.message,
        });
      }
    }

    logUploadTelemetry("info", {
      ...baseTelemetry,
      stage: "upload_completed",
      trainerId: String(trainer._id),
      documentType: normalizedDocType,
      documentId: String(document._id),
      driveFileId: document.driveFileId || null,
      status: "completed",
      outcome: "succeeded",
    });

    return {
      success: true,
      message: DOCUMENT_UPLOAD_SUCCESS_MESSAGE,
      data: {
        id: document._id,
        documentType: normalizeTrainerDocumentType(document.documentType),
        fileName: document.fileName,
        filePath: document.filePath,
        fileLink: document.filePath,
        driveFileId: document.driveFileId,
        driveViewLink: document.driveViewLink,
        driveDownloadLink: document.driveDownloadLink,
        driveFolderId: document.driveFolderId,
        driveFolderName: document.driveFolderName,
        verificationStatus: document.verificationStatus,
        normalizedStatus: "pending",
        documentStatus: workflow.documentStatus,
        documentProgress: workflow.documentProgress,
        documentProgressItem: workflow.documentProgress?.[normalizedDocType] || null,
        missingDocuments: workflow.missingDocuments,
        uploadDate: document.createdAt,
      },
    };
  } catch (dbError) {
    logUploadTelemetry("warn", {
      ...baseTelemetry,
      stage: "document_persist_failed_rollback_started",
      trainerId: String(trainer._id),
      documentType: normalizedDocType,
      driveFileId: driveUpload.fileId,
      status: "rollback",
      outcome: "started",
      cleanupMode: "drive_file",
      reason: dbError.message,
    });
    try {
      await deleteDriveFileLoader(driveUpload.fileId);
      logUploadTelemetry("info", {
        ...baseTelemetry,
        stage: "document_persist_failed_rollback_succeeded",
        trainerId: String(trainer._id),
        documentType: normalizedDocType,
        driveFileId: driveUpload.fileId,
        status: "rollback",
        outcome: "succeeded",
        cleanupMode: "drive_file",
      });
    } catch (cleanupError) {
      logUploadTelemetry("warn", {
        ...baseTelemetry,
        stage: "document_persist_failed_rollback_failed",
        trainerId: String(trainer._id),
        documentType: normalizedDocType,
        driveFileId: driveUpload.fileId,
        status: "rollback",
        outcome: "failed",
        cleanupMode: "drive_file",
        reason: cleanupError.message,
      });
    }

    throw dbError;
  }
};

const clearTrainerDocumentReference = ({
  trainer,
  documentType,
  filePath,
  rejectionReason,
}) => {
  if (!trainer) {
    return;
  }

  const normalizedDocumentType = normalizeTrainerDocumentType(documentType);
  const previousSelfiePath = trainer.documents?.selfiePhoto || null;
  const previousPassportPath = trainer.documents?.passportPhoto || null;
  const currentProfilePicture = String(trainer.profilePicture || "").trim();

  if (!trainer.documents) {
    trainer.documents = {};
  }

  getTrainerDocumentTypeCandidates(normalizedDocumentType).forEach((candidate) => {
    trainer.documents[candidate] = null;
  });

  if (normalizedDocumentType === "ndaAgreement") {
    trainer.ndaAgreementPdf = null;
    trainer.ntaAgreementPdf = null;
    trainer.NDAAgreementPdf = null;
    trainer.documents.ndaAgreement = null;
    trainer.documents.ntaAgreement = null;
  }

  if (!trainer.documents.verification) {
    trainer.documents.verification = new Map();
  }

  trainer.documents.verification.set(normalizedDocumentType, {
    verified: false,
    reason: rejectionReason || null,
    updatedAt: new Date(),
  });

  if (
    normalizedDocumentType === "selfiePhoto"
    && (!currentProfilePicture
      || currentProfilePicture === filePath
      || currentProfilePicture === previousSelfiePath)
  ) {
    trainer.profilePicture = previousPassportPath || null;
  } else if (
    normalizedDocumentType === "passportPhoto"
    && (!currentProfilePicture
      || currentProfilePicture === filePath
      || currentProfilePicture === previousPassportPath)
  ) {
    trainer.profilePicture = previousSelfiePath || null;
  }
};

const deleteLegacyLocalDocument = async (filePath, options = {}) => {
  const correlationId =
    options?.correlationId || createCorrelationId("doc_local_cleanup");
  const contextLabel =
    options?.contextLabel || "trainer-document-local-cleanup";
  if (!filePath || /^https?:\/\//i.test(filePath)) {
    return;
  }

  const oldFilename = filePath.split(/[\\/]/).pop();
  if (!oldFilename) {
    return;
  }

  const oldFilePath = path.join(
    __dirname,
    "../../uploads/trainer-documents",
    oldFilename,
  );

  try {
    await fs.access(oldFilePath);
    await fs.unlink(oldFilePath);
    logUploadTelemetry("debug", {
      correlationId,
      stage: "cleanup_local_file_deleted",
      status: "cleanup_local",
      outcome: "succeeded",
      cleanupMode: "local_file",
      reason: oldFilePath,
      contextLabel,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      logUploadTelemetry("warn", {
        correlationId,
        stage: "cleanup_local_file_delete_failed",
        status: "cleanup_local",
        outcome: "failed",
        cleanupMode: "local_file",
        reason: `${oldFilePath}: ${error.message}`,
        contextLabel,
      });
    }
  }
};

const createInAppNotification = async ({
  userId,
  role,
  title,
  message,
  link = null,
  type = "System",
  createNotificationLoader = createNotificationRecord,
}) => {
  const normalizedRole = String(role || "").trim();

  if (!userId || !VALID_NOTIFICATION_ROLES.includes(normalizedRole)) {
    logUploadTelemetry("warn", {
      correlationId: createCorrelationId("doc_notification"),
      stage: "notification_recipient_invalid",
      status: "notification",
      outcome: "skipped",
      reason: `userId=${userId || "null"};role=${role || "null"};title=${title || "untitled"}`,
      cleanupMode: "notification_validation",
    });
    return null;
  }

  return createNotificationLoader({
    payload: {
      userId,
      role: normalizedRole,
      title,
      message,
      type,
      link,
    },
  });
};

const resetTrainerSubmissionProgress = async ({
  trainer,
  preserveDocumentId = null,
  listNdaDocumentsLoader = findNdaDocumentsForTrainer,
  deleteDocumentLoader = deleteTrainerDocumentRecord,
  deleteDriveFileLoader = deleteFromDrive,
  deleteLegacyFileLoader = deleteLegacyLocalDocument,
  resetTrainerUserLoader = resetUserForTrainerSubmission,
} = {}) => {
  if (!trainer?._id) {
    return;
  }

  trainer.signature = null;
  trainer.agreementAccepted = false;
  trainer.agreemeNDAccepted = false;
  trainer.agreementDate = null;
  trainer.passwordHash = null;
  trainer.registrationStep = 3;
  trainer.registrationStatus = "pending";

  if (!trainer.documents) {
    trainer.documents = {};
  }

  trainer.ndaAgreementPdf = null;
  trainer.ntaAgreementPdf = null;
  trainer.NDAAgreementPdf = null;
  trainer.documents.ndaAgreement = null;
  trainer.documents.ntaAgreement = null;
  trainer.documents.NDAAgreement = null;

  const ndaDocuments = await listNdaDocumentsLoader({
    trainerId: trainer._id,
    documentTypeCandidates: getTrainerDocumentTypeCandidates("ndaAgreement"),
    preserveDocumentId,
  });

  for (const ndaDocument of ndaDocuments) {
    await deleteDocumentLoader({ document: ndaDocument });

    try {
      if (ndaDocument.driveFileId) {
        await deleteDriveFileLoader(ndaDocument.driveFileId);
      } else if (ndaDocument.filePath) {
        await deleteLegacyFileLoader(ndaDocument.filePath);
      }
    } catch (cleanupError) {
      logUploadTelemetry("warn", {
        correlationId: createCorrelationId("doc_reset_cleanup"),
        stage: "cleanup_stale_nda_asset_failed",
        status: "cleanup_reset",
        outcome: "failed",
        cleanupMode: "document_asset",
        reason: cleanupError.message,
        trainerId: trainer?._id ? String(trainer._id) : null,
      });
    }
  }

  if (trainer.userId) {
    await resetTrainerUserLoader({ userId: trainer.userId });
  }
};

const verifyDocumentFeed = async ({
  documentId,
  payload = {},
  actorUserId = null,
  normalizeVerificationStatusLoader = normalizeTrainerDocumentVerificationStatus,
  getDocumentByIdLoader = findDocumentByIdWithTrainerUser,
  getTrainerByIdLoader = findTrainerById,
  listTrainerDocumentsLoader = listTrainerDocumentsByTrainerId,
  listTrainerDocumentsExcludingLoader = listTrainerDocumentsByTrainerIdExcluding,
  saveDocumentLoader = saveTrainerDocument,
  deleteDocumentLoader = deleteTrainerDocumentRecord,
  saveTrainerLoader = saveTrainerRecord,
  updateUserProfilePictureLoader = updateUserProfilePictureById,
  syncTrainerDocumentWorkflowLoader = syncTrainerDocumentWorkflow,
  resetTrainerSubmissionProgressLoader = resetTrainerSubmissionProgress,
  deleteDriveFileLoader = deleteFromDrive,
  deleteLegacyFileLoader = deleteLegacyLocalDocument,
  sendDocumentRejectionEmailLoader = sendDocumentRejectionEmail,
  createInAppNotificationLoader = createInAppNotification,
  trainerSignupResumeLink = TRAINER_SIGNUP_RESUME_LINK,
} = {}) => {
  if (!isValidObjectId(documentId)) {
    throw createStatusError(400, INVALID_DOCUMENT_ID_MESSAGE);
  }

  const verificationStatus = normalizeVerificationStatusLoader(
    payload?.verificationStatus,
    null,
  );
  const verificationComment = payload?.verificationComment;

  if (!["APPROVED", "REJECTED"].includes(verificationStatus)) {
    throw createStatusError(400, INVALID_VERIFICATION_STATUS_MESSAGE);
  }

  const document = await getDocumentByIdLoader({ documentId });
  if (!document) {
    throw createStatusError(404, DOCUMENT_NOT_FOUND_MESSAGE);
  }

  const normalizedDocType = normalizeTrainerDocumentType(document.documentType);
  if (document.documentType !== normalizedDocType) {
    document.documentType = normalizedDocType;
  }

  const rejectedDocumentSnapshot = normalizeTrainerDocumentRecord({
    ...document.toObject(),
    documentType: normalizedDocType,
    verificationStatus,
    verificationComment,
    verifiedBy: actorUserId,
    verifiedAt: new Date(),
  });
  let workflow = null;
  let cleanupWarning = null;

  if (document.trainerId) {
    const trainer = await getTrainerByIdLoader({ trainerId: document.trainerId._id });
    if (trainer) {
      const docType = normalizedDocType;
      if (!trainer.documents) trainer.documents = {};
      if (!trainer.documents.verification) {
        trainer.documents.verification = new Map();
      }

      if (verificationStatus === "APPROVED") {
        document.verificationStatus = verificationStatus;
        document.verificationComment = verificationComment;
        document.verifiedBy = actorUserId;
        document.verifiedAt = new Date();
        await saveDocumentLoader({ document });

        trainer.documents.verification.set(docType, {
          verified: true,
          reason: null,
          updatedAt: new Date(),
        });

        let approvedProfilePicture = null;
        if (docType === "selfiePhoto") {
          trainer.profilePicture = document.filePath;
          approvedProfilePicture = document.filePath;
        } else if (docType === "passportPhoto" && !trainer.documents?.selfiePhoto) {
          trainer.profilePicture = document.filePath;
          approvedProfilePicture = document.filePath;
        }

        if (approvedProfilePicture && trainer.userId) {
          await updateUserProfilePictureLoader({
            userId: trainer.userId,
            profilePicture: approvedProfilePicture,
          });
        }

        const trainerDocuments = await listTrainerDocumentsLoader({
          trainerId: trainer._id,
        });
        workflow = syncTrainerDocumentWorkflowLoader(trainer, trainerDocuments);
        await saveTrainerLoader({ trainer });
      } else {
        clearTrainerDocumentReference({
          trainer,
          documentType: docType,
          filePath: document.filePath,
          rejectionReason: verificationComment,
        });

        await resetTrainerSubmissionProgressLoader({
          trainer,
          preserveDocumentId: docType === "ndaAgreement" ? document._id : null,
        });

        const remainingDocuments = await listTrainerDocumentsExcludingLoader({
          trainerId: trainer._id,
          excludedDocumentId: document._id,
        });
        workflow = syncTrainerDocumentWorkflowLoader(trainer, remainingDocuments);
        await saveTrainerLoader({ trainer });

        if (trainer.userId) {
          await updateUserProfilePictureLoader({
            userId: trainer.userId,
            profilePicture: trainer.profilePicture || null,
          });
        }

        await deleteDocumentLoader({ document });

        try {
          if (document.driveFileId) {
            await deleteDriveFileLoader(document.driveFileId);
          } else if (document.filePath) {
            await deleteLegacyFileLoader(document.filePath);
          }
        } catch (cleanupError) {
          cleanupWarning = cleanupError.message;
          logUploadTelemetry("warn", {
            correlationId: createCorrelationId("doc_verify_cleanup"),
            stage: "cleanup_rejected_document_asset_failed",
            status: "cleanup_verify",
            outcome: "failed",
            cleanupMode: "document_asset",
            reason: cleanupError.message,
            trainerId: trainer?._id ? String(trainer._id) : null,
            documentId: document?._id ? String(document._id) : null,
            documentType: normalizedDocType,
          });
        }
      }
    }
  }

  if (
    verificationStatus === "REJECTED"
    && document.trainerId
    && document.trainerId.userId
  ) {
    const trainerEmail = document.trainerId.userId.email;
    const trainerName = document.trainerId.userId.name;
    const docReadable = normalizedDocType
      .replace(/([A-Z])/g, " $1")
      .trim()
      .replace(/^\w/, (token) => token.toUpperCase());

    try {
      await sendDocumentRejectionEmailLoader(
        trainerEmail,
        trainerName,
        docReadable,
        verificationComment,
        {
          actionUrl: trainerSignupResumeLink,
          buttonLabel: "Upload Corrected Document",
        },
      );

      await createInAppNotificationLoader({
        userId: document.trainerId.userId._id,
        role: document.trainerId.userId.role || "Trainer",
        title: "Document Rejected",
        message: `Your ${docReadable} has been rejected. Reason: ${verificationComment}`,
        type: NOTIFICATION_TYPE_APPROVAL,
        link: "/trainer-signup",
      });
    } catch (notificationError) {
      logUploadTelemetry("warn", {
        correlationId: createCorrelationId("doc_notification"),
        stage: "document_rejection_notification_failed",
        status: "notification",
        outcome: "failed",
        reason: notificationError.message,
        trainerId: document?.trainerId?._id ? String(document.trainerId._id) : null,
        documentId: document?._id ? String(document._id) : null,
        documentType: normalizedDocType,
      });
    }
  }

  return {
    success: true,
    message:
      verificationStatus === "REJECTED"
        ? cleanupWarning
          ? VERIFY_DOCUMENT_REJECTED_CLEANUP_WARNING_MESSAGE
          : VERIFY_DOCUMENT_REJECTED_SUCCESS_MESSAGE
        : VERIFY_DOCUMENT_SUCCESS_MESSAGE,
    data: {
      ...(verificationStatus === "REJECTED"
        ? rejectedDocumentSnapshot
        : normalizeTrainerDocumentRecord(document)),
      workflow,
      removed: verificationStatus === "REJECTED",
      cleanupWarning,
    },
  };
};

const getTrainerReviewGate = (trainer = {}) => {
  const hasAgreementSubmission = Boolean(
    (trainer.agreementAccepted ?? trainer.agreemeNDAccepted) && trainer.signature,
  );
  const hasPassword = Boolean(trainer.passwordHash);

  if (!hasAgreementSubmission) {
    return {
      ready: false,
      nextStep: 4,
      nextStepLabel: "Agreement",
    };
  }

  if (!hasPassword) {
    return {
      ready: false,
      nextStep: 5,
      nextStepLabel: "Password",
    };
  }

  return {
    ready: true,
    nextStep: 6,
    nextStepLabel: "Completed",
  };
};

const generateTrainerLoginPassword = () => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!";
  return Array.from(
    { length: 10 },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
};

const updateTrainerStatusFeed = async ({
  trainerId,
  payload = {},
  normalizeOverallStatusLoader = normalizeTrainerOverallStatus,
  getTrainerByIdWithUserLoader = findTrainerByIdWithUser,
  saveTrainerLoader = saveTrainerRecord,
  resetTrainerSubmissionProgressLoader = resetTrainerSubmissionProgress,
  sendProfileRejectionEmailLoader = sendProfileRejectionEmail,
  sendTrainerApprovalEmailLoader = sendTrainerApprovalEmail,
  createInAppNotificationLoader = createInAppNotification,
  getUserByIdWithPlainPasswordLoader = findUserByIdWithPlainPassword,
  hashPasswordLoader = bcrypt.hash,
  updateUserPasswordLoader = updateUserPasswordById,
  activateUserLoader = activateUserById,
  frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000",
} = {}) => {
  if (!isValidObjectId(trainerId)) {
    throw createStatusError(400, INVALID_TRAINER_ID_MESSAGE);
  }
  const statusCorrelationId = createCorrelationId("doc_trainer_status");

  const status = normalizeOverallStatusLoader(payload?.status, null);
  const reason = payload?.reason;
  const validStatuses = ["APPROVED", "REJECTED", "PENDING"];

  if (!validStatuses.includes(status)) {
    throw createStatusError(400, INVALID_STATUS_MESSAGE);
  }

  const trainer = await getTrainerByIdWithUserLoader({ trainerId });
  if (!trainer) {
    throw createStatusError(404, TRAINER_NOT_FOUND_MESSAGE);
  }

  const reviewGate = getTrainerReviewGate(trainer);
  if ((status === "APPROVED" || status === "PENDING") && !reviewGate.ready) {
    throw createStatusError(
      400,
      `Trainer must complete ${reviewGate.nextStepLabel} before admin review`,
      {
        data: {
          nextStep: reviewGate.nextStep,
          nextStepLabel: reviewGate.nextStepLabel,
        },
      },
    );
  }

  trainer.status = status;

  if (status === "APPROVED") {
    trainer.verificationStatus = "VERIFIED";
    trainer.documentStatus = "approved";
  } else if (status === "REJECTED") {
    trainer.verificationStatus = "REJECTED";
    trainer.documentStatus = "rejected";
    await resetTrainerSubmissionProgressLoader({ trainer });
  } else {
    trainer.verificationStatus = "PENDING";
    trainer.documentStatus = "under_review";
  }

  if (status === "REJECTED" && reason) {
    const trainerEmail = trainer.userId.email;
    const trainerName = trainer.userId.name;

    const docKeys = REQUIRED_TRAINER_DOCUMENTS.map(({ key }) => key);
    docKeys.forEach((key) => {
      if (trainer.documents && trainer.documents[key]) {
        if (!trainer.documents.verification) {
          trainer.documents.verification = new Map();
        }

        trainer.documents.verification.set(key, {
          verified: false,
          reason,
          updatedAt: new Date(),
        });
      }
    });

    if (trainer.documents?.profilePhoto) {
      if (!trainer.documents.verification) {
        trainer.documents.verification = new Map();
      }

      trainer.documents.verification.set("profilePhoto", {
        verified: false,
        reason,
        updatedAt: new Date(),
      });
    }

    try {
      await sendProfileRejectionEmailLoader(trainerEmail, trainerName, reason);

      await createInAppNotificationLoader({
        userId: trainer.userId._id,
        role: trainer.userId.role || "Trainer",
        title: "Profile Rejected",
        message: `Your profile verification was rejected. Reason: ${reason}. Please re-upload all documents.`,
        type: NOTIFICATION_TYPE_APPROVAL,
        link: "/trainer-signup",
      });
    } catch (notificationError) {
      logUploadTelemetry("warn", {
        correlationId: statusCorrelationId,
        stage: "trainer_status_rejection_notification_failed",
        trainerId: trainer?._id ? String(trainer._id) : null,
        status: "trainer_status",
        outcome: "failed",
        reason: notificationError.message,
      });
    }
  }

  if (status === "APPROVED") {
    const trainerEmail = trainer.userId.email;
    const trainerName = trainer.userId.name;
    const trainerUserId = trainer.userId._id;
    let plainPassword = null;

    try {
      const userWithPlain = await getUserByIdWithPlainPasswordLoader({
        userId: trainerUserId,
      });

      if (userWithPlain && userWithPlain.plainPassword) {
        plainPassword = userWithPlain.plainPassword;
      } else {
        plainPassword = generateTrainerLoginPassword();
        const hashedPassword = await hashPasswordLoader(plainPassword, 10);
        await updateUserPasswordLoader({
          userId: trainerUserId,
          password: hashedPassword,
          plainPassword,
        });
      }
    } catch (passwordError) {
      logUploadTelemetry("warn", {
        correlationId: statusCorrelationId,
        stage: "trainer_status_password_handling_failed",
        trainerId: trainer?._id ? String(trainer._id) : null,
        status: "trainer_status",
        outcome: "failed",
        reason: passwordError.message,
      });
    }

    await activateUserLoader({ userId: trainerUserId });

    const loginUrl = `${frontendUrl}${TRAINER_LOGIN_ROUTE}`;
    await sendTrainerApprovalEmailLoader(
      trainerEmail,
      trainerName,
      loginUrl,
      trainer.trainerId,
      plainPassword,
    );

    await createInAppNotificationLoader({
      userId: trainerUserId,
      role: trainer.userId.role || "Trainer",
      title: "Profile Approved Successfully",
      message:
        "Your trainer profile has been approved successfully. Check your email for the portal login link, email address, and password.",
      type: NOTIFICATION_TYPE_APPROVAL,
      link: "/trainer/profile",
    });
  }

  await saveTrainerLoader({ trainer });

  return {
    success: true,
    message: `Trainer profile ${status} successfully`,
    data: {
      verificationStatus: trainer.verificationStatus,
      documentStatus: trainer.documentStatus,
    },
  };
};

const buildTrainerWorkflowPayload = (workflow = {}) => ({
  documentStatus: workflow.documentStatus,
  documentSummary: {
    uploadedCount: workflow.uploadedCount,
    approvedCount: workflow.approvedCount,
    pendingReviewCount: workflow.pendingReviewCount,
    requiredCount: workflow.requiredCount,
  },
  documentProgress: workflow.documentProgress,
  documentChecklist: workflow.checklist,
  missingDocuments: workflow.missingDocuments,
  rejectedDocuments: workflow.rejectedDocuments,
  hasAllRequiredDocuments: workflow.hasAllRequiredDocuments,
  allRequiredDocumentsApproved: workflow.allRequiredDocumentsApproved,
  canProceedToAgreement: workflow.canProceedToAgreement,
});

const approachTrainerDocumentsFeed = async ({
  trainerId,
  actorUserId = null,
  actorRole = "",
  findTrainerByIdWithUserLoader = findTrainerByIdWithUser,
  listTrainerDocumentsLoader = listTrainerDocumentsByTrainerId,
  syncTrainerDocumentWorkflowLoader = syncTrainerDocumentWorkflow,
  evaluateTrainerDocumentWorkflowLoader = evaluateTrainerDocumentWorkflow,
  saveTrainerLoader = saveTrainerRecord,
  sendTrainerDocumentReminderEmailLoader = sendTrainerDocumentReminderEmail,
  frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000",
} = {}) => {
  if (!["SuperAdmin", "Admin"].includes(actorRole)) {
    throw createStatusError(403, ACCESS_DENIED_MESSAGE);
  }

  if (!isValidObjectId(trainerId)) {
    throw createStatusError(400, INVALID_TRAINER_ID_MESSAGE);
  }

  const trainer = await findTrainerByIdWithUserLoader({ trainerId });
  if (!trainer || !trainer.userId) {
    throw createStatusError(404, TRAINER_NOT_FOUND_MESSAGE);
  }

  const trainerDocuments = await listTrainerDocumentsLoader({ trainerId });
  const workflow = syncTrainerDocumentWorkflowLoader(trainer, trainerDocuments);
  await saveTrainerLoader({ trainer });

  const outstandingItems =
    workflow.missingDocuments.length > 0
      ? workflow.missingDocuments
      : workflow.rejectedDocuments;

  if (outstandingItems.length === 0) {
    throw createStatusError(400, TRAINER_NO_OUTSTANDING_DOCUMENTS_MESSAGE);
  }

  trainer.lastApproachedAt = new Date();
  trainer.lastApproachedBy = actorUserId;
  await saveTrainerLoader({ trainer });

  await sendTrainerDocumentReminderEmailLoader({
    trainerEmail: trainer.userId.email,
    trainerName: trainer.userId.name,
    missingDocuments: outstandingItems.map((item) => item.label),
    loginUrl: `${frontendUrl}${TRAINER_PROFILE_ROUTE}`,
  });

  const finalWorkflow = evaluateTrainerDocumentWorkflowLoader(
    trainer,
    trainerDocuments,
  );

  return {
    success: true,
    message: TRAINER_REMINDER_SUCCESS_MESSAGE,
    data: {
      ...buildTrainerWorkflowPayload(finalWorkflow),
      lastApproachedAt: trainer.lastApproachedAt,
    },
  };
};

const moveTrainerToReviewFeed = async ({
  trainerId,
  actorRole = "",
  findTrainerByIdWithUserLoader = findTrainerByIdWithUser,
  listTrainerDocumentsLoader = listTrainerDocumentsByTrainerId,
  evaluateTrainerDocumentWorkflowLoader = evaluateTrainerDocumentWorkflow,
  saveTrainerLoader = saveTrainerRecord,
  getTrainerReviewGateLoader = getTrainerReviewGate,
  buildTrainerWorkflowPayloadLoader = buildTrainerWorkflowPayload,
} = {}) => {
  if (!["SuperAdmin", "Admin"].includes(actorRole)) {
    throw createStatusError(403, ACCESS_DENIED_MESSAGE);
  }

  if (!isValidObjectId(trainerId)) {
    throw createStatusError(400, INVALID_TRAINER_ID_MESSAGE);
  }

  const trainer = await findTrainerByIdWithUserLoader({ trainerId });
  if (!trainer) {
    throw createStatusError(404, TRAINER_NOT_FOUND_MESSAGE);
  }

  const trainerDocuments = await listTrainerDocumentsLoader({ trainerId });
  const workflow = evaluateTrainerDocumentWorkflowLoader(trainer, trainerDocuments);

  if (!workflow.hasAllRequiredDocuments) {
    throw createStatusError(400, TRAINER_MISSING_REQUIRED_DOCUMENTS_MESSAGE, {
      data: { missingDocuments: workflow.missingDocuments },
    });
  }

  if (workflow.hasRejectedDocuments) {
    throw createStatusError(400, TRAINER_HAS_REJECTED_DOCUMENTS_MESSAGE, {
      data: { rejectedDocuments: workflow.rejectedDocuments },
    });
  }

  const reviewGate = getTrainerReviewGateLoader(trainer);
  if (!reviewGate.ready) {
    throw createStatusError(
      400,
      `Trainer must complete ${reviewGate.nextStepLabel} before moving to admin review`,
      {
        data: {
          nextStep: reviewGate.nextStep,
          nextStepLabel: reviewGate.nextStepLabel,
        },
      },
    );
  }

  trainer.status = "PENDING";
  trainer.verificationStatus = "PENDING";
  trainer.documentStatus = "under_review";
  await saveTrainerLoader({ trainer });

  const finalWorkflow = evaluateTrainerDocumentWorkflowLoader(trainer, trainerDocuments);

  return {
    success: true,
    message: MOVE_TO_REVIEW_SUCCESS_MESSAGE,
    data: buildTrainerWorkflowPayloadLoader(finalWorkflow),
  };
};

const submitVerificationFeed = async ({
  actorUserId = null,
  actorRole = "Trainer",
  findTrainerByUserIdLoader = findTrainerByUserId,
  saveTrainerLoader = saveTrainerRecord,
  findUsersByRoleLoader = findUsersByRole,
  findUserByIdLoader = findUserById,
  sendAdminSubmissionNotificationEmailLoader = sendAdminSubmissionNotificationEmail,
  createInAppNotificationLoader = createInAppNotification,
  requiredTrainerDocuments = REQUIRED_TRAINER_DOCUMENTS,
  getTrainerReviewGateLoader = getTrainerReviewGate,
} = {}) => {
  const submitCorrelationId = createCorrelationId("doc_submit_verification");
  const trainer = await findTrainerByUserIdLoader({ userId: actorUserId });
  if (!trainer) {
    throw createStatusError(404, TRAINER_PROFILE_NOT_FOUND_MESSAGE);
  }

  const docs = trainer.documents || {};
  const requiredKeys = requiredTrainerDocuments.map(({ key }) => key);
  const missing = requiredKeys.filter((key) => !docs[key]);

  if (missing.length > 0) {
    throw createStatusError(
      400,
      `Please upload all required documents first. Missing: ${missing.join(", ")}`,
    );
  }

  const reviewGate = getTrainerReviewGateLoader(trainer);
  if (!reviewGate.ready) {
    throw createStatusError(
      400,
      `Complete ${reviewGate.nextStepLabel} before submitting for admin review`,
      {
        data: {
          nextStep: reviewGate.nextStep,
          nextStepLabel: reviewGate.nextStepLabel,
        },
      },
    );
  }

  trainer.status = "PENDING";
  trainer.verificationStatus = "PENDING";
  trainer.documentStatus = "under_review";
  await saveTrainerLoader({ trainer });

  try {
    const superAdmins = await findUsersByRoleLoader({
      role: "SuperAdmin",
      select: "email _id",
    });
    const actorUser = await findUserByIdLoader({ userId: actorUserId });

    if (Array.isArray(superAdmins) && superAdmins.length > 0) {
      const adminEmails = superAdmins.map((admin) => admin.email);

      await sendAdminSubmissionNotificationEmailLoader(
        adminEmails,
        actorUser?.name,
        actorUser?.email,
        trainer.trainerId,
      );

      await Promise.all(
        superAdmins.map((admin) =>
          createInAppNotificationLoader({
            userId: admin._id,
            role: "SuperAdmin",
            title: "New Trainer Submission",
            message: `${actorUser?.name} has submitted their profile for verification.`,
            type: NOTIFICATION_TYPE_APPROVAL,
            link: "/documents",
          }),
        ),
      );
    }

    await createInAppNotificationLoader({
      userId: actorUserId,
      role: actorRole || "Trainer",
      title: SUBMISSION_RECEIVED_TITLE,
      message: SUBMISSION_RECEIVED_MESSAGE,
      type: NOTIFICATION_TYPE_APPROVAL,
      link: "/trainer-signup",
    });
  } catch (notificationError) {
    logUploadTelemetry("warn", {
      correlationId: submitCorrelationId,
      stage: "submit_verification_notifications_failed",
      trainerId: trainer?._id ? String(trainer._id) : null,
      status: "submit_verification",
      outcome: "failed",
      reason: notificationError.message,
    });
  }

  return {
    success: true,
    message: SUBMIT_VERIFICATION_SUCCESS_MESSAGE,
    data: {
      verificationStatus: "pending",
      documentStatus: "under_review",
    },
  };
};

module.exports = {
  approachTrainerDocumentsFeed,
  buildTrainerWorkflowPayload,
  clearTrainerDocumentReference,
  createInAppNotification,
  deleteLegacyLocalDocument,
  getTrainerDocumentTypeCandidates,
  isAbsoluteUrl,
  isValidObjectId,
  listMyDocumentsFeed,
  listTrainerDocumentsFeed,
  normalizeStoredDocumentPath,
  normalizeTrainerDocumentRecord,
  normalizeTrainerDocumentType,
  queueTrainerDocumentCleanup,
  resetTrainerSubmissionProgress,
  moveTrainerToReviewFeed,
  submitVerificationFeed,
  uploadTrainerDocumentFeed,
  updateTrainerStatusFeed,
  verifyDocumentFeed,
};
