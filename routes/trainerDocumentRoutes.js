const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs").promises;
const mongoose = require("mongoose");
const { TrainerDocument, Trainer, User } = require("../models");
const Notification = require("../models/Notification");
const { authenticate, authenticateOptional } = require("../middleware/auth");
const {
  sendDocumentRejectionEmail,
  sendProfileRejectionEmail,
  sendAdminSubmissionNotificationEmail,
  sendAccountVerificationSuccessEmail,
  sendTrainerDocumentReminderEmail,
} = require("../utils/emailService");
const scanFile = require("../middleware/virusScan");
const {
  uploadToDrive,
  deleteFromDrive,
} = require("../services/googleDriveService");
const {
  ensureTrainerDocumentHierarchy,
} = require("../services/googleDriveTrainerDocumentHierarchyService");
const {
  REQUIRED_TRAINER_DOCUMENTS,
  evaluateTrainerDocumentWorkflow,
  syncTrainerDocumentWorkflow,
} = require("../utils/trainerDocumentWorkflow");
const { updateUserAvatar } = require("../services/streamChatService");

const isValidObjectId = (id) =>
  typeof id === "string" && mongoose.Types.ObjectId.isValid(id);

const TRAINER_SIGNUP_RESUME_LINK = `${
  process.env.FRONTEND_URL || "http://localhost:3000"
}/trainer-signup`;
const NOTIFICATION_TYPE_APPROVAL = "Approval";
const VALID_NOTIFICATION_ROLES = new Set([
  "SuperAdmin",
  "CompanyAdmin",
  "CollegeAdmin",
  "SPOCAdmin",
  "Trainer",
  "AccouNDAnt",
  "Student",
]);

const createInAppNotification = async ({
  userId,
  role,
  title,
  message,
  link = null,
  type = "System",
}) => {
  const normalizedRole = String(role || "").trim();

  if (!userId || !VALID_NOTIFICATION_ROLES.has(normalizedRole)) {
    console.warn(
      "[NOTIFICATION-DEBUG] Skipping notification due to invalid recipient:",
      {
        userId,
        role,
        title,
      },
    );
    return null;
  }

  return Notification.create({
    userId,
    role: normalizedRole,
    title,
    message,
    type,
    link,
  });
};

const buildTrainerWorkflowPayload = (trainer, trainerDocuments = []) => {
  const workflow = evaluateTrainerDocumentWorkflow(trainer, trainerDocuments);

  return {
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
  };
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

const syncTrainerWorkflowState = async (trainerOrId, trainerDocuments = null) => {
  const trainer =
    typeof trainerOrId === "string" || trainerOrId instanceof mongoose.Types.ObjectId
      ? await Trainer.findById(trainerOrId)
      : trainerOrId;

  if (!trainer) {
    return null;
  }

  const documents =
    trainerDocuments || (await TrainerDocument.find({ trainerId: trainer._id }));
  const workflow = syncTrainerDocumentWorkflow(trainer, documents);
  await trainer.save();

  return workflow;
};

const getTrainerRegistrationAccessState = async (trainer) => {
  const trainerDocuments = await TrainerDocument.find({ trainerId: trainer._id });
  const workflow = syncTrainerDocumentWorkflow(trainer, trainerDocuments);
  await trainer.save();

  return {
    trainerDocuments,
    workflow,
    currentStep: Number(trainer.registrationStep || 1),
    registrationStatus: String(trainer.registrationStatus || "pending")
      .trim()
      .toLowerCase(),
  };
};

const rejectTrainerStepAccess = (
  res,
  { requiredStep, currentStep, registrationStatus, workflow },
) => {
  if (registrationStatus === "approved") {
    return res.status(409).json({
      success: false,
      message: "Registration is already approved. Trainer onboarding steps are locked.",
      data: {
        registrationStep: 6,
        registrationStatus,
        nextStepLabel: getTrainerStepLabel(6),
        documentStatus: workflow?.documentStatus || null,
      },
    });
  }

  if (registrationStatus === "under_review") {
    return res.status(409).json({
      success: false,
      message:
        "Registration is already submitted for admin review. Trainer onboarding steps are locked.",
      data: {
        registrationStep: 6,
        registrationStatus,
        nextStepLabel: getTrainerStepLabel(6),
        documentStatus: workflow?.documentStatus || null,
      },
    });
  }

  return res.status(409).json({
    success: false,
    message: buildTrainerStepLockMessage(requiredStep, currentStep),
    data: {
      registrationStep: currentStep,
      registrationStatus,
      nextStepLabel: getTrainerStepLabel(currentStep),
      documentStatus: workflow?.documentStatus || null,
    },
  });
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

const resetTrainerSubmissionProgress = async (
  trainer,
  { preserveDocumentId = null } = {},
) => {
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

  const ndaDocumentFilter = {
    trainerId: trainer._id,
    documentType: { $in: getTrainerDocumentTypeCandidates("ndaAgreement") },
  };

  if (preserveDocumentId && mongoose.Types.ObjectId.isValid(preserveDocumentId)) {
    ndaDocumentFilter._id = { $ne: preserveDocumentId };
  }

  const ndaDocuments = await TrainerDocument.find(ndaDocumentFilter);
  for (const ndaDocument of ndaDocuments) {
    await ndaDocument.deleteOne();

    try {
      if (ndaDocument.driveFileId) {
        await deleteFromDrive(ndaDocument.driveFileId);
      } else if (ndaDocument.filePath) {
        await deleteLegacyLocalDocument(ndaDocument.filePath);
      }
    } catch (cleanupError) {
      console.warn(
        "[VERIFY-DEBUG] Failed to remove stale NDA document asset:",
        cleanupError.message,
      );
    }
  }

  if (trainer.userId) {
    await User.findByIdAndUpdate(trainer.userId, {
      $set: {
        accountStatus: "pending",
      },
      $unset: {
        password: 1,
        plainPassword: 1,
      },
    });
  }
};

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
    normalizedDocumentType === "selfiePhoto" &&
    (!currentProfilePicture ||
      currentProfilePicture === filePath ||
      currentProfilePicture === previousSelfiePath)
  ) {
    trainer.profilePicture = previousPassportPath || null;
  } else if (
    normalizedDocumentType === "passportPhoto" &&
    (!currentProfilePicture ||
      currentProfilePicture === filePath ||
      currentProfilePicture === previousPassportPath)
  ) {
    trainer.profilePicture = previousSelfiePath || null;
  }
};

const deleteLegacyLocalDocument = async (filePath) => {
  if (!filePath || /^https?:\/\//i.test(filePath)) {
    return;
  }

  const oldFilename = filePath.split(/[\\/]/).pop();
  if (!oldFilename) {
    return;
  }

  const oldFilePath = path.join(
    __dirname,
    "../uploads/trainer-documents",
    oldFilename,
  );

  try {
    await fs.access(oldFilePath);
    await fs.unlink(oldFilePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.log(
        `[UPLOAD-DEBUG] Failed to delete legacy file: ${oldFilePath}`,
        error,
      );
    }
  }
};

const FIXED_TRAINER_DOCUMENT_FILE_NAMES = {
  selfiePhoto: "Selfie",
  passportPhoto: "ProfilePhoto",
  aadharFront: "Aadhar-Front",
  aadharBack: "Aadhar-Back",
  pan: "PAN",
  passbook: "BankProof",
  degreePdf: "Certificate",
  resumePdf: "Resume",
  ndaAgreement: "NDA-Form",
};

const FIXED_DOCUMENT_EXTENSION_MAP = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
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

const isAbsoluteUrl = (value = "") => /^https?:\/\//i.test(String(value || "").trim());

const normalizeStoredDocumentPath = (value = "") => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }

  return isAbsoluteUrl(normalized)
    ? normalized
    : `/${normalized.replace(/^\/+/, "")}`;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB limit
  },
  fileFilter: (req, file, cb) => {
    // Initial loose check to allow processing.
    // Strict mapping check happens in the route handler.
    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);
    const allowedExtensions = new Set([".jpeg", ".jpg", ".png", ".pdf", ".doc", ".docx"]);
    const extname = allowedExtensions.has(
      path.extname(file.originalname).toLowerCase(),
    );
    const mimetype = allowedMimeTypes.has(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPG, PNG, PDF, DOC, and DOCX are allowed."));
    }
  },
});

// Custom middleware to handle both 'document' and 'file' field names
const uploadHandler = (req, res, next) => {
  const uploadMiddleware = upload.fields([
    { name: "document", maxCount: 1 },
    { name: "file", maxCount: 1 },
  ]);

  uploadMiddleware(req, res, (err) => {
    if (err) {
      console.error(`[MULTER-DEBUG] Upload Error: ${err.message}`);
      return next(err);
    }

    // Map the file to req.file for subsequent middleware (like scanFile)
    if (req.files) {
      if (req.files["document"] && req.files["document"][0]) {
        req.file = req.files["document"][0];
      } else if (req.files["file"] && req.files["file"][0]) {
        req.file = req.files["file"][0];
      }
    }

    if (req.file) {
      console.log(
        `[MULTER-DEBUG] Received file in field: ${req.file.fieldname}`,
      );
    } else {
      console.log("[MULTER-DEBUG] No file received in expected fields");
    }

    next();
  });
};

// Upload trainer document
router.post(
  "/upload",
  authenticateOptional,
  uploadHandler,
  scanFile,
  async (req, res) => {
    try {
      const { documentType, accountNumber, bankName, ifscCode, email } =
        req.body;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded",
        });
      }

      // Get trainer ID from targetTrainerId (for Super Admin), email (for registration), or auth user
      let trainer;
      const isAdminUpload = Boolean(
        req.body.targetTrainerId &&
          req.user &&
          ["SuperAdmin", "Admin"].includes(req.user.role),
      );

      if (
        isAdminUpload
      ) {
        if (!isValidObjectId(req.body.targetTrainerId)) {
          return res.status(400).json({
            success: false,
            message: "Invalid trainer ID",
          });
        }
        trainer = await Trainer.findById(req.body.targetTrainerId);
      } else if (email) {
        trainer = await Trainer.findOne({ email });
      } else if (req.user) {
        trainer = await Trainer.findOne({ userId: req.user.id });
      }

      if (!trainer) {
        return res.status(404).json({
          success: false,
          message: "Trainer profile not found",
        });
      }

      if (!isAdminUpload) {
        const accessState = await getTrainerRegistrationAccessState(trainer);
        if (
          accessState.registrationStatus !== "pending" ||
          accessState.currentStep !== 3
        ) {
          return rejectTrainerStepAccess(res, {
            requiredStep: 3,
            currentStep: accessState.currentStep,
            registrationStatus: accessState.registrationStatus,
            workflow: accessState.workflow,
          });
        }
      }

      if (!trainer.trainerId) {
        await trainer.save();
      }

      if (!trainer.trainerId) {
        return res.status(500).json({
          success: false,
          message: "Trainer ID could not be generated for document upload",
        });
      }

      // Normalize legacy/new document type keys from different clients
      const DOCUMENT_TYPE_ALIASES = {
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
      };

      const normalizedDocType =
        DOCUMENT_TYPE_ALIASES[documentType] || documentType;

      // Strict Mapping & Validation per spec (supports registration + profile flows)
      const ALLOWED_TYPES_MAP = {
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
      };

      if (!ALLOWED_TYPES_MAP[normalizedDocType]) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid document type" });
      }

      if (!ALLOWED_TYPES_MAP[normalizedDocType].includes(req.file.mimetype)) {
        return res.status(400).json({
          success: false,
          message: `Invalid file type for ${normalizedDocType}. Expected: ${ALLOWED_TYPES_MAP[normalizedDocType].join(", ")}`,
        });
      }

      // Check if document already exists
      const existingDoc = await TrainerDocument.findOne({
        trainerId: trainer._id,
        documentType: { $in: getTrainerDocumentTypeCandidates(normalizedDocType) },
      });

      const hierarchy = await ensureTrainerDocumentHierarchy({
        trainer,
        persistTrainer: false,
        syncExistingDocuments: true,
      });
      const trainerDriveFolder = hierarchy.trainerFolder;
      const trainerDocumentsFolder = hierarchy.documentsFolder;
      trainer.driveFolderId = trainerDriveFolder.id;
      trainer.driveFolderName = trainerDriveFolder.name;
      const fixedDriveFileName = buildFixedTrainerDocumentFileName(
        normalizedDocType,
        req.file.mimetype,
        req.file.originalname,
      );

      const driveUpload = await uploadToDrive({
        fileBuffer: req.file.buffer,
        mimeType: req.file.mimetype,
        originalName: req.file.originalname,
        folderId: trainerDocumentsFolder.id,
        fileName: fixedDriveFileName,
      });

      const fileLink = driveUpload.fileUrl;
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
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        verificationStatus: "PENDING",
        verifiedAt: null,
        verificationComment: null,
      };

      // Add bank details if it's a passbook document
      if (normalizedDocType === "passbook") {
        documentData.accountNumber = accountNumber;
        documentData.bankName = bankName;
        documentData.ifscCode = ifscCode;
      }

      let document;
      try {
        if (existingDoc) {
          Object.assign(existingDoc, documentData);
          await existingDoc.save();
          document = existingDoc;
        } else {
          document = await TrainerDocument.create(documentData);
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
          (normalizedDocType === "passportPhoto" &&
            !trainer.documents?.selfiePhoto);

        if (shouldSetAsProfilePicture) {
          trainer.profilePicture = fileLink;
        }

        const trainerDocuments = await TrainerDocument.find({
          trainerId: trainer._id,
        });
        const workflow = syncTrainerDocumentWorkflow(trainer, trainerDocuments);
        await trainer.save();

        if (shouldSetAsProfilePicture && trainer.userId) {
          await User.findByIdAndUpdate(trainer.userId, {
            $set: { profilePicture: fileLink },
          });
          // Sync to Stream Chat automatically
          try {
            await updateUserAvatar(trainer.userId.toString(), fileLink);
          } catch (chatErr) {
            console.error('[STREAM-SYNC] Failed to update avatar on upload:', chatErr.message);
          }
        }

        console.log(
          `[UPLOAD-DEBUG] Trainer workflow updated: ${workflow.documentStatus}`,
        );

        if (existingDoc) {
          try {
            if (
              previousDriveFileId &&
              previousDriveFileId !== driveUpload.fileId
            ) {
              await deleteFromDrive(previousDriveFileId);
            } else if (previousFilePath && previousFilePath !== fileLink) {
              await deleteLegacyLocalDocument(previousFilePath);
            }
          } catch (cleanupError) {
            console.warn(
              "[UPLOAD-DEBUG] Previous document cleanup failed:",
              cleanupError.message,
            );
          }
        }

        res.json({
          success: true,
          message: "Document uploaded successfully",
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
            documentProgressItem:
              workflow.documentProgress?.[normalizedDocType] || null,
            missingDocuments: workflow.missingDocuments,
            uploadDate: document.createdAt,
          },
        });
      } catch (dbError) {
        try {
          await deleteFromDrive(driveUpload.fileId);
        } catch (cleanupError) {
          console.warn(
            "[UPLOAD-DEBUG] Failed to roll back Google Drive upload:",
            cleanupError.message,
          );
        }

        throw dbError;
      }
    } catch (error) {
      console.error("Error uploading document:", error);
      const isDriveSetupIssue =
        typeof error?.message === "string" &&
        (error.message.includes("Google Drive setup issue") ||
          error.message.includes("domain-wide delegation") ||
          error.message.includes("Service accounts do not have storage quota"));

      const statusCode = isDriveSetupIssue ? 400 : 500;

      res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to upload document",
        error: error.message,
      });
    }
  },
);

// Get trainer documents
router.get("/my-documents", authenticate, async (req, res) => {
  try {
    const trainer = await Trainer.findOne({ userId: req.user.id });

    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: "Trainer profile not found",
      });
    }

    const documents = await TrainerDocument.find({
      trainerId: trainer._id,
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: documents.map(normalizeTrainerDocumentRecord),
    });
  } catch (error) {
    console.error("Error fetching documents:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch documents",
      error: error.message,
    });
  }
});

// Get documents for specific trainer (Super Admin)
router.get("/trainer/:trainerId", authenticate, async (req, res) => {
  try {
    const { trainerId } = req.params;
    if (!isValidObjectId(trainerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid trainer ID",
      });
    }

    // Backfill legacy NDA PDF into TrainerDocument if missing
    const trainer = await Trainer.findById(trainerId).select(
      "ndaAgreementPdf ntaAgreementPdf NDAAgreementPdf documents.ndaAgreement documents.ntaAgreement documents.NDAAgreement",
    );
    const NDAPath =
      normalizeStoredDocumentPath(trainer?.documents?.ndaAgreement) ||
      normalizeStoredDocumentPath(trainer?.documents?.ntaAgreement) ||
      normalizeStoredDocumentPath(trainer?.documents?.NDAAgreement) ||
      normalizeStoredDocumentPath(trainer?.ndaAgreementPdf) ||
      normalizeStoredDocumentPath(trainer?.ntaAgreementPdf) ||
      normalizeStoredDocumentPath(trainer?.NDAAgreementPdf);

    if (NDAPath) {
      await TrainerDocument.findOneAndUpdate(
        {
          trainerId,
          documentType: { $in: getTrainerDocumentTypeCandidates("ndaAgreement") },
        },
        {
          $set: {
            documentType: "ndaAgreement",
          },
          $setOnInsert: {
            fileName: isAbsoluteUrl(NDAPath)
              ? "NDA-Form.pdf"
              : path.basename(NDAPath),
            filePath: NDAPath,
            mimeType: "application/pdf",
            verificationStatus: "PENDING",
            verificationComment: null,
            verifiedAt: null,
            verifiedBy: null,
          },
        },
        { upsert: true, new: true },
      );
    }

    const documents = await TrainerDocument.find({ trainerId }).sort({
      createdAt: -1,
    });

    res.json({
      success: true,
      data: documents.map(normalizeTrainerDocumentRecord),
    });
  } catch (error) {
    console.error("Error fetching trainer documents:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch documents",
      error: error.message,
    });
  }
});

// Verify document (Super Admin only)
router.put("/:id/verify", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { verificationStatus, verificationComment } = req.body;
    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid document ID",
      });
    }

    if (!["APPROVED", "REJECTED"].includes(verificationStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid verification status",
      });
    }

    const document = await TrainerDocument.findById(id).populate({
      path: "trainerId",
      populate: { path: "userId" },
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document not found",
      });
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
      verifiedBy: req.user.id,
      verifiedAt: new Date(),
    });
    let workflow = null;
    let cleanupWarning = null;

    // Sync with Trainer Model
    if (document.trainerId) {
      const trainer = await Trainer.findById(document.trainerId._id);
      if (trainer) {
        const docType = normalizedDocType;
        if (!trainer.documents) trainer.documents = {};
        if (!trainer.documents.verification)
          trainer.documents.verification = new Map();

        if (verificationStatus === "APPROVED") {
          document.verificationStatus = verificationStatus;
          document.verificationComment = verificationComment;
          document.verifiedBy = req.user.id;
          document.verifiedAt = new Date();
          await document.save();

          trainer.documents.verification.set(docType, {
            verified: true,
            reason: null,
            updatedAt: new Date(),
          });

          // Special Mapping: Approved selfie/passport photo -> Main Profile Picture
          let approvedProfilePicture = null;

          if (docType === "selfiePhoto") {
            trainer.profilePicture = document.filePath;
            approvedProfilePicture = document.filePath;
          } else if (
            docType === "passportPhoto" &&
            !trainer.documents?.selfiePhoto
          ) {
            // Only set passportPhoto if selfiePhoto hasn't already set it
            trainer.profilePicture = document.filePath;
            approvedProfilePicture = document.filePath;
          }

          if (approvedProfilePicture && trainer.userId) {
            await User.findByIdAndUpdate(trainer.userId, {
              $set: { profilePicture: approvedProfilePicture },
            });
          }
          
          const trainerDocuments = await TrainerDocument.find({
            trainerId: trainer._id,
          });
          workflow = syncTrainerDocumentWorkflow(trainer, trainerDocuments);
          await trainer.save();
        } else {
          clearTrainerDocumentReference({
            trainer,
            documentType: docType,
            filePath: document.filePath,
            rejectionReason: verificationComment,
          });
          await resetTrainerSubmissionProgress(trainer, {
            preserveDocumentId:
              docType === "ndaAgreement" ? document._id : null,
          });

          const remainingDocuments = await TrainerDocument.find({
            trainerId: trainer._id,
            _id: { $ne: document._id },
          });
          workflow = syncTrainerDocumentWorkflow(trainer, remainingDocuments);
          await trainer.save();

          if (trainer.userId) {
            await User.findByIdAndUpdate(trainer.userId, {
              $set: { profilePicture: trainer.profilePicture || null },
            });
          }

          await document.deleteOne();

          try {
            if (document.driveFileId) {
              await deleteFromDrive(document.driveFileId);
            } else if (document.filePath) {
              await deleteLegacyLocalDocument(document.filePath);
            }
          } catch (cleanupError) {
            cleanupWarning = cleanupError.message;
            console.warn(
              "[VERIFY-DEBUG] Failed to remove rejected document asset:",
              cleanupError.message,
            );
          }
        }
      }
    }

    // Send Email & Notification on Rejection
    if (
      verificationStatus === "REJECTED" &&
      document.trainerId &&
      document.trainerId.userId
    ) {
      const trainerEmail = document.trainerId.userId.email;
      const trainerName = document.trainerId.userId.name;
      const docReadable = normalizedDocType
        .replace(/([A-Z])/g, " $1")
        .trim()
        .replace(/^\w/, (c) => c.toUpperCase());

      try {
        await sendDocumentRejectionEmail(
          trainerEmail,
          trainerName,
          docReadable,
          verificationComment,
          {
            actionUrl: TRAINER_SIGNUP_RESUME_LINK,
            buttonLabel: "Upload Corrected Document",
          },
        );

        await createInAppNotification({
          userId: document.trainerId.userId._id,
          role: document.trainerId.userId.role || "Trainer",
          title: "Document Rejected",
          message: `Your ${docReadable} has been rejected. Reason: ${verificationComment}`,
          type: NOTIFICATION_TYPE_APPROVAL,
          link: "/trainer-signup",
        });
      } catch (notificationError) {
        console.error(
          "Error sending document rejection notification:",
          notificationError,
        );
      }
    }

    res.json({
      success: true,
      message:
        verificationStatus === "REJECTED"
          ? cleanupWarning
            ? "Document rejected. Trainer can re-upload, but the previous Drive file could not be deleted automatically."
            : "Document rejected and removed. Trainer can re-upload a replacement."
          : "Document verification updated",
      data: {
        ...(verificationStatus === "REJECTED"
          ? rejectedDocumentSnapshot
          : normalizeTrainerDocumentRecord(document)),
        workflow,
        removed: verificationStatus === "REJECTED",
        cleanupWarning,
      },
    });
  } catch (error) {
    console.error("Error verifying document:", error);
    res.status(500).json({
      success: false,
      message: "Failed to verify document",
      error: error.message,
    });
  }
});

router.post("/trainer/:trainerId/approach", authenticate, async (req, res) => {
  try {
    if (!["SuperAdmin", "Admin"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    const { trainerId } = req.params;
    if (!isValidObjectId(trainerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid trainer ID",
      });
    }

    const trainer = await Trainer.findById(trainerId).populate("userId");
    if (!trainer || !trainer.userId) {
      return res.status(404).json({
        success: false,
        message: "Trainer not found",
      });
    }

    const trainerDocuments = await TrainerDocument.find({ trainerId });
    const workflow = await syncTrainerWorkflowState(trainer, trainerDocuments);
    const outstandingItems =
      workflow.missingDocuments.length > 0
        ? workflow.missingDocuments
        : workflow.rejectedDocuments;

    if (outstandingItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: "This trainer has no missing or rejected documents.",
      });
    }

    trainer.lastApproachedAt = new Date();
    trainer.lastApproachedBy = req.user.id;
    await trainer.save();

    await sendTrainerDocumentReminderEmail({
      trainerEmail: trainer.userId.email,
      trainerName: trainer.userId.name,
      missingDocuments: outstandingItems.map((item) => item.label),
      loginUrl: `${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/profile`,
    });

    res.json({
      success: true,
      message: "Reminder email sent to trainer successfully",
      data: {
        ...buildTrainerWorkflowPayload(trainer, trainerDocuments),
        lastApproachedAt: trainer.lastApproachedAt,
      },
    });
  } catch (error) {
    console.error("Error sending trainer document reminder:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send trainer reminder",
      error: error.message,
    });
  }
});

router.put(
  "/trainer/:trainerId/move-to-review",
  authenticate,
  async (req, res) => {
    try {
      if (!["SuperAdmin", "Admin"].includes(req.user.role)) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      const { trainerId } = req.params;
      if (!isValidObjectId(trainerId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid trainer ID",
        });
      }

      const trainer = await Trainer.findById(trainerId).populate("userId");
      if (!trainer) {
        return res.status(404).json({
          success: false,
          message: "Trainer not found",
        });
      }

      const trainerDocuments = await TrainerDocument.find({ trainerId });
      const workflow = evaluateTrainerDocumentWorkflow(trainer, trainerDocuments);

      if (!workflow.hasAllRequiredDocuments) {
        return res.status(400).json({
          success: false,
          message: "Trainer is still missing required documents",
          data: { missingDocuments: workflow.missingDocuments },
        });
      }

      if (workflow.hasRejectedDocuments) {
        return res.status(400).json({
          success: false,
          message: "Trainer has rejected documents and cannot move to review",
          data: { rejectedDocuments: workflow.rejectedDocuments },
        });
      }

      const reviewGate = getTrainerReviewGate(trainer);
      if (!reviewGate.ready) {
        return res.status(400).json({
          success: false,
          message: `Trainer must complete ${reviewGate.nextStepLabel} before moving to admin review`,
          data: {
            nextStep: reviewGate.nextStep,
            nextStepLabel: reviewGate.nextStepLabel,
          },
        });
      }

      trainer.status = "PENDING";
      trainer.verificationStatus = "PENDING";
      trainer.documentStatus = "under_review";
      await trainer.save();

      res.json({
        success: true,
        message: "Trainer moved to Review Docs successfully",
        data: buildTrainerWorkflowPayload(trainer, trainerDocuments),
      });
    } catch (error) {
      console.error("Error moving trainer to review:", error);
      res.status(500).json({
        success: false,
        message: "Failed to move trainer to review",
        error: error.message,
      });
    }
  },
);

// Submit for verification
router.put("/submit-verification", authenticate, async (req, res) => {
  try {
    const trainer = await Trainer.findOne({ userId: req.user.id });

    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: "Trainer profile not found",
      });
    }

    // Required docs for submission
    const docs = trainer.documents;
    const requiredKeys = REQUIRED_TRAINER_DOCUMENTS.map(({ key }) => key);

    const missing = requiredKeys.filter((k) => !docs[k]);

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Please upload all required documents first. Missing: ${missing.join(", ")}`,
      });
    }

    const reviewGate = getTrainerReviewGate(trainer);
    if (!reviewGate.ready) {
      return res.status(400).json({
        success: false,
        message: `Complete ${reviewGate.nextStepLabel} before submitting for admin review`,
        data: {
          nextStep: reviewGate.nextStep,
          nextStepLabel: reviewGate.nextStepLabel,
        },
      });
    }

    trainer.status = "PENDING";
    trainer.verificationStatus = "PENDING";
    trainer.documentStatus = "under_review";
    await trainer.save();

    // ðŸ”” NOFITICATIONS
    try {
      // 1. Find Super Admins
      const superAdmins = await User.find({ role: "SuperAdmin" }).select(
        "email _id",
      );
      const user = await User.findById(req.user.id); // Get trainer details

      if (superAdmins.length > 0) {
        const adminEmails = superAdmins.map((admin) => admin.email);

        // 2. Send Email
        await sendAdminSubmissionNotificationEmail(
          adminEmails,
          user.name,
          user.email,
          trainer.trainerId,
        );

        // 3. Create Notifications
        const notificationPromises = superAdmins.map((admin) => {
          return createInAppNotification({
            userId: admin._id,
            role: "SuperAdmin",
            title: "New Trainer Submission",
            message: `${user.name} has submitted their profile for verification.`,
            type: NOTIFICATION_TYPE_APPROVAL,
            link: "/documents",
          });
        });
        await Promise.all(notificationPromises);
      }

      // 4. Confirm to Trainer (In-App only)
      await createInAppNotification({
        userId: req.user.id,
        role: req.user.role || "Trainer",
        title: "Submission Received",
        message:
          "Your documents have been submitted securely. An admin will review them shortly.",
        type: NOTIFICATION_TYPE_APPROVAL,
        link: "/trainer-signup",
      });
    } catch (notifError) {
      console.error("Error sending submission notifications:", notifError);
      // Don't block the actual submission if notifications fail
    }

    res.json({
      success: true,
      message: "Profile submitted for verification successfully",
      data: { verificationStatus: "pending", documentStatus: "under_review" },
    });
  } catch (error) {
    console.error("Error submitting verification:", error);
    res.status(500).json({
      success: false,
      message: "Failed to submit for verification",
      error: error.message,
    });
  }
});

// Update trainer verification status (Super Admin)
router.put("/trainer/:trainerId/status", authenticate, async (req, res) => {
  try {
    const { trainerId } = req.params;
    const { status, reason } = req.body;
    if (!isValidObjectId(trainerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid trainer ID",
      });
    }

    const validStatuses = ["APPROVED", "REJECTED", "PENDING"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    const trainer = await Trainer.findById(trainerId).populate("userId");

    if (!trainer) {
      return res.status(404).json({
        success: false,
        message: "Trainer not found",
      });
    }

    const reviewGate = getTrainerReviewGate(trainer);
    if ((status === "APPROVED" || status === "PENDING") && !reviewGate.ready) {
      return res.status(400).json({
        success: false,
        message: `Trainer must complete ${reviewGate.nextStepLabel} before admin review`,
        data: {
          nextStep: reviewGate.nextStep,
          nextStepLabel: reviewGate.nextStepLabel,
        },
      });
    }

    trainer.status = status;
    if (status === "APPROVED") {
      trainer.verificationStatus = "VERIFIED";
      trainer.documentStatus = "approved";
    } else if (status === "REJECTED") {
      trainer.verificationStatus = "REJECTED";
      trainer.documentStatus = "rejected";
      await resetTrainerSubmissionProgress(trainer);
    } else {
      trainer.verificationStatus = "PENDING";
      trainer.documentStatus = "under_review";
    }

    // ðŸ”” Send Email & Notification for Rejection
    if (status === "REJECTED" && reason) {
      const trainerEmail = trainer.userId.email;
      const trainerName = trainer.userId.name;

      // Mark all documents as rejected so they can be re-uploaded
      const docKeys = REQUIRED_TRAINER_DOCUMENTS.map(({ key }) => key);
      docKeys.forEach((key) => {
        if (trainer.documents && trainer.documents[key]) {
          if (!trainer.documents.verification)
            trainer.documents.verification = new Map();

          trainer.documents.verification.set(key, {
            verified: false,
            reason: reason,
            updatedAt: new Date(),
          });
        }
      });

      if (trainer.documents?.profilePhoto) {
        if (!trainer.documents.verification)
          trainer.documents.verification = new Map();

        trainer.documents.verification.set("profilePhoto", {
          verified: false,
          reason: reason,
          updatedAt: new Date(),
        });
      }

      try {
        await sendProfileRejectionEmail(trainerEmail, trainerName, reason);

        await createInAppNotification({
          userId: trainer.userId._id,
          role: trainer.userId.role || "Trainer",
          title: "Profile Rejected",
          message: `Your profile verification was rejected. Reason: ${reason}. Please re-upload all documents.`,
          type: NOTIFICATION_TYPE_APPROVAL,
          link: "/trainer-signup",
        });
      } catch (notificationError) {
        console.error(
          "Error sending trainer profile rejection notification:",
          notificationError,
        );
      }
    }

    // ðŸ”” Send Email & Notification for APPROVED (Approval)
    if (status === "APPROVED") {
      const trainerEmail = trainer.userId.email;
      const trainerName = trainer.userId.name;

      // 0. Generate a new plain-text login password if not already stored
      let plainPassword = null;
      try {
        // Try to get stored plain password (if set during registration)
        const userWithPlain = await User.findById(trainer.userId._id).select(
          "+plainPassword",
        );
        if (userWithPlain && userWithPlain.plainPassword) {
          plainPassword = userWithPlain.plainPassword;
        } else {
          // Generate a strong new password for the trainer
          const chars =
            "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!";
          plainPassword = Array.from(
            { length: 10 },
            () => chars[Math.floor(Math.random() * chars.length)],
          ).join("");
          const bcrypt = require("bcryptjs");
          const hashedPassword = await bcrypt.hash(plainPassword, 10);
          await User.findByIdAndUpdate(trainer.userId._id, {
            password: hashedPassword,
            plainPassword: plainPassword,
          });
        }
      } catch (pwErr) {
        console.error("[APPROVAL] Error handling password:", pwErr);
      }

      // 0b. Activate User Account
      await User.findByIdAndUpdate(trainer.userId._id, {
        isActive: true,
        accountStatus: "active",
      });

      // 1. Send Approval Email with Login URL & Credentials
      const { sendTrainerApprovalEmail } = require("../utils/emailService");
      const loginUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/login/trainer`;
      await sendTrainerApprovalEmail(
        trainerEmail,
        trainerName,
        loginUrl,
        trainer.trainerId,
        plainPassword,
      );

      // 2. Create Success Notification
      await createInAppNotification({
        userId: trainer.userId._id,
        role: trainer.userId.role || "Trainer",
        title: "Profile Approved Successfully",
        message:
          "Your trainer profile has been approved successfully. Check your email for the portal login link, email address, and password.",
        type: NOTIFICATION_TYPE_APPROVAL,
        link: "/trainer/profile",
      });
    }

    await trainer.save();

    res.json({
      success: true,
      message: `Trainer profile ${status} successfully`,
      data: {
        verificationStatus: trainer.verificationStatus,
        documentStatus: trainer.documentStatus,
      },
    });
  } catch (error) {
    console.error("Error updating trainer status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update trainer status",
      error: error.message,
    });
  }
});

module.exports = router;


