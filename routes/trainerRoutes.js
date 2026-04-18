const express = require("express");
const router = express.Router();
const fs = require("fs").promises;
const path = require("path");
const mongoose = require("mongoose");
const {
  Trainer,
  User,
  College,
  Schedule,
  Attendance,
  TrainerDocument,
  NdaTemplate,
  City,
} = require("../models");
const { authenticate } = require("../middleware/auth");
const bcrypt = require("bcryptjs");
const {
  sendAccountVerificationSuccessEmail,
  sendDocumentRejectionEmail,
} = require("../utils/emailService");
const Notification = require("../models/Notification");
const { generateNdaPdf } = require("../utils/generateNdaPdf");
const {
  uploadToDrive,
  deleteFromDrive,
  ensureTrainerDocumentHierarchy,
  cleanupDuplicateDriveFilesByName,
} = require("../modules/drive/driveGateway");
const {
  evaluateTrainerDocumentWorkflow,
  hasCompletedTrainerDetails,
  resolveTrainerRegistrationStatus,
  resolveTrainerResumeStep,
} = require("../utils/trainerDocumentWorkflow");
const {
  NDA_TEMPLATE_KEY,
  DEFAULT_NDA_TEMPLATE,
  normalizeAcceptanceConditions,
  normalizeNdaTemplate,
} = require("../utils/ndaTemplate");
const {
  autoCreateTrainerAdminChannels,
  cleanupDeletedUserChatArtifacts,
} = require("../services/streamChatService");

const escapeRegex = (value = "") =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NDA_DOCUMENT_TYPE = "ndaAgreement";
const LEGACY_NDA_DOCUMENT_TYPES = ["ntaAgreement", "NDAAgreement"];
const NDA_DRIVE_FILE_NAME = "NDA-Form.pdf";
const PROFILE_PICTURE_MIME_EXTENSION_MAP = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const resolveGeneratedFilePath = (relativePath = "") =>
  path.join(__dirname, "..", String(relativePath || "").replace(/^\/+/, ""));

const buildProfilePictureDriveFileName = (file = {}) => {
  const extension =
    PROFILE_PICTURE_MIME_EXTENSION_MAP[file.mimetype] ||
    path.extname(file.originalname || "") ||
    "";

  return `ProfilePicture${extension}`;
};

const toPlainObject = (value) =>
  value?.toObject ? value.toObject() : { ...(value || {}) };

const normalizeTrainerAgreementFields = (trainer) => {
  if (!trainer) {
    return trainer;
  }

  const plainTrainer = toPlainObject(trainer);
  const documents = plainTrainer.documents || {};
  const agreementAccepted = Boolean(
    plainTrainer.agreementAccepted ?? plainTrainer.agreemeNDAccepted,
  );
  const ndaAgreementPdf =
    plainTrainer.ndaAgreementPdf ||
    plainTrainer.ntaAgreementPdf ||
    plainTrainer.NDAAgreementPdf ||
    null;
  const ndaAgreement =
    documents.ndaAgreement ||
    documents.ntaAgreement ||
    documents.NDAAgreement ||
    ndaAgreementPdf ||
    null;

  return {
    ...plainTrainer,
    agreementAccepted,
    agreemeNDAccepted: agreementAccepted,
    ndaAgreementPdf: ndaAgreementPdf || ndaAgreement || null,
    ntaAgreementPdf: ndaAgreementPdf || ndaAgreement || null,
    NDAAgreementPdf: ndaAgreementPdf || ndaAgreement || null,
    documents: {
      ...documents,
      ndaAgreement,
      ntaAgreement: ndaAgreement,
      NDAAgreement: ndaAgreement,
    },
  };
};

const hasCompletedTrainerRegistration = (source = {}) => {
  const normalizedTrainer = normalizeTrainerAgreementFields(source);

  return Boolean(
    normalizedTrainer?.signature &&
      normalizedTrainer?.agreementAccepted &&
      (normalizedTrainer?.passwordHash || normalizedTrainer?.password),
  );
};

const getPersistedRegistrationState = (requestedStep, source = {}) => {
  const safeRequestedStep = Math.min(Math.max(Number(requestedStep) || 1, 1), 6);
  const hasCompletedRegistration = hasCompletedTrainerRegistration(source);

  if (hasCompletedRegistration && safeRequestedStep >= 6) {
    return {
      registrationStep: 6,
      registrationStatus: "under_review",
    };
  }

  return {
    registrationStep: Math.min(safeRequestedStep, 5),
    registrationStatus: "pending",
  };
};

const getCurrentNdaTemplate = async () => {
  const template = await NdaTemplate.findOne({ key: NDA_TEMPLATE_KEY })
    .populate("updatedBy", "name email")
    .lean();

  return normalizeNdaTemplate(template || DEFAULT_NDA_TEMPLATE);
};

const ensureTrainerDriveFolder = async (trainer) => {
  const hierarchy = await ensureTrainerDocumentHierarchy({
    trainer,
    persistTrainer: true,
  });

  return hierarchy.trainerFolder;
};

const syncTrainerNdaAgreementPdfToDrive = async (trainer) => {
  if (!trainer?._id) {
    throw new Error("Trainer record is required to generate the NDA PDF.");
  }

  const hierarchy = await ensureTrainerDocumentHierarchy({
    trainer,
    persistTrainer: true,
    syncExistingDocuments: true,
  });
  const trainerDriveFolder = hierarchy.trainerFolder;
  const trainerDocumentsFolder = hierarchy.documentsFolder;
  const ndaTemplate = await getCurrentNdaTemplate();
  const pdfPath = await generateNdaPdf(trainer, ndaTemplate);
  const pdfBuffer = await fs.readFile(resolveGeneratedFilePath(pdfPath));
  const existingNDADoc = await TrainerDocument.findOne({
    trainerId: trainer._id,
    documentType: { $in: [NDA_DOCUMENT_TYPE, ...LEGACY_NDA_DOCUMENT_TYPES] },
  });
  let driveUpload;

  try {
    driveUpload = await uploadToDrive({
      fileBuffer: pdfBuffer,
      mimeType: "application/pdf",
      originalName: path.basename(pdfPath),
      folderId: trainerDocumentsFolder.id,
      fileName: NDA_DRIVE_FILE_NAME,
      replaceExistingFile: false,
      cleanupDuplicateFiles: false,
    });

    trainer.documents = trainer.documents || {};
    trainer.ndaAgreementPdf = driveUpload.fileUrl;
    trainer.ntaAgreementPdf = driveUpload.fileUrl;
    trainer.documents.ndaAgreement = driveUpload.fileUrl;
    trainer.documents.ntaAgreement = driveUpload.fileUrl;
    trainer.driveFolderId = trainerDriveFolder.id;
    trainer.driveFolderName = trainerDriveFolder.name;

    await TrainerDocument.findOneAndUpdate(
      {
        trainerId: trainer._id,
        documentType: { $in: [NDA_DOCUMENT_TYPE, ...LEGACY_NDA_DOCUMENT_TYPES] },
      },
      {
        $set: {
          documentType: NDA_DOCUMENT_TYPE,
          fileName: driveUpload.fileName,
          filePath: driveUpload.fileUrl,
          driveFileId: driveUpload.fileId,
          driveViewLink: driveUpload.webViewLink,
          driveDownloadLink: driveUpload.downloadLink,
          driveFolderId: trainerDocumentsFolder.id,
          driveFolderName: trainerDocumentsFolder.name,
          fileSize: pdfBuffer.length,
          mimeType: "application/pdf",
          verificationStatus: existingNDADoc?.verificationStatus || "PENDING",
          verificationComment: existingNDADoc?.verificationComment || null,
          verifiedAt: existingNDADoc?.verifiedAt || null,
          verifiedBy: existingNDADoc?.verifiedBy || null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (driveUpload?.fileId) {
      try {
        await deleteFromDrive(driveUpload.fileId);
      } catch (cleanupError) {
        console.warn(
          "Failed to clean up uploaded NDA file after error:",
          cleanupError.message,
        );
      }
    }

    throw error;
  }

  if (
    existingNDADoc?.driveFileId &&
    existingNDADoc.driveFileId !== driveUpload.fileId
  ) {
    try {
      await deleteFromDrive(existingNDADoc.driveFileId);
    } catch (cleanupError) {
      console.warn(
        "Failed to clean up previous NDA file from Drive:",
        cleanupError.message,
      );
    }
  }

  try {
    await cleanupDuplicateDriveFilesByName({
      folderId: trainerDocumentsFolder.id,
      fileName: NDA_DRIVE_FILE_NAME,
      keepFileId: driveUpload.fileId,
    });
  } catch (cleanupError) {
    console.warn(
      "Failed to clean up older NDA files from Drive:",
      cleanupError.message,
    );
  }

  return {
    pdfPath,
    filePath: driveUpload.fileUrl,
    driveFolderId: trainerDocumentsFolder.id,
    driveFolderName: trainerDocumentsFolder.name,
  };
};

const enrichTrainerWithDocumentWorkflow = (trainer) => {
  const source = normalizeTrainerAgreementFields(trainer);
  const workflow = evaluateTrainerDocumentWorkflow(source);

  return {
    ...source,
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
    registrationStatus:
      source.registrationStatus || resolveTrainerRegistrationStatus(source, workflow),
  };
};

const buildTrainerRegistrationWorkflowState = async (trainer) => {
  const normalizedTrainer = normalizeTrainerAgreementFields(trainer);
  const trainerDocuments = normalizedTrainer?._id
    ? await TrainerDocument.find({ trainerId: normalizedTrainer._id })
    : [];
  const workflow = evaluateTrainerDocumentWorkflow(
    normalizedTrainer,
    trainerDocuments,
  );
  const registrationStatus = resolveTrainerRegistrationStatus(
    normalizedTrainer,
    workflow,
  );
  const resumeStep =
    registrationStatus === "pending"
      ? resolveTrainerResumeStep(normalizedTrainer, workflow)
      : 6;

  return {
    normalizedTrainer,
    trainerDocuments,
    workflow,
    registrationStatus,
    resumeStep,
  };
};

const notifyAdminNewTrainer = async (trainer) => {
  try {
    const superAdmins = await User.find({ role: "SuperAdmin" }).select("email");
    const adminEmails = superAdmins.map((admin) => admin.email).filter(Boolean);

    if (adminEmails.length > 0) {
      const {
        sendAdminSubmissionNotificationEmail,
      } = require("../utils/emailService");
      const City = require("../models/City");

      const trainerName = trainer.firstName
        ? `${trainer.firstName} ${trainer.lastName}`
        : trainer.email || "New Trainer";

      // Fetch city name if cityId exists
      let cityName = "N/A";
      if (trainer.cityId) {
        const city = await City.findById(trainer.cityId);
        if (city) cityName = city.name;
      }

      await sendAdminSubmissionNotificationEmail(
        adminEmails,
        trainerName,
        trainer.email,
        trainer.trainerId || trainer._id,
        cityName,
        trainer.qualification || "N/A",
      );
    }
  } catch (error) {
    console.error("notifyAdminNewTrainer error:", error.message);
  }
};

const getRegistrationStepMeta = (value = 1) => {
  const step = Math.min(Math.max(Number(value) || 1, 1), 6);
  const nextStepLabels = {
    1: "Email Verify",
    2: "Details",
    3: "Upload Documents",
    4: "Agreement",
    5: "Password",
    6: "Registration Complete",
  };

  return {
    step,
    nextStepLabel: nextStepLabels[step] || "Registration",
  };
};

const buildTrainerStepLockMessage = (requiredStep, currentStep) => {
  const requiredLabel = getRegistrationStepMeta(requiredStep).nextStepLabel;
  const currentLabel = getRegistrationStepMeta(currentStep).nextStepLabel;

  if (currentStep > requiredStep) {
    return `${requiredLabel} is already completed and locked. Continue from ${currentLabel}.`;
  }

  return `${requiredLabel} is not available yet. Continue from ${currentLabel}.`;
};

const ensureTrainerStepAccess = async (res, trainer, requiredStep) => {
  const workflowState = await buildTrainerRegistrationWorkflowState(trainer);
  const currentStep =
    workflowState.registrationStatus === "pending" ? workflowState.resumeStep : 6;

  if (
    trainer.registrationStatus !== workflowState.registrationStatus ||
    trainer.documentStatus !== workflowState.workflow.documentStatus ||
    Number(trainer.registrationStep || 1) !== currentStep
  ) {
    trainer.registrationStatus = workflowState.registrationStatus;
    trainer.documentStatus = workflowState.workflow.documentStatus;
    trainer.registrationStep = currentStep;
    await trainer.save();
  }

  if (workflowState.registrationStatus === "approved") {
    res.status(409).json({
      success: false,
      message: "Registration is already approved. Trainer onboarding steps are locked.",
      data: {
        registrationStep: 6,
        registrationStatus: workflowState.registrationStatus,
        nextStepLabel: getRegistrationStepMeta(6).nextStepLabel,
        documentStatus: workflowState.workflow.documentStatus,
      },
    });
    return null;
  }

  if (workflowState.registrationStatus === "under_review") {
    res.status(409).json({
      success: false,
      message:
        "Registration is already submitted for admin review. Trainer onboarding steps are locked.",
      data: {
        registrationStep: 6,
        registrationStatus: workflowState.registrationStatus,
        nextStepLabel: getRegistrationStepMeta(6).nextStepLabel,
        documentStatus: workflowState.workflow.documentStatus,
      },
    });
    return null;
  }

  if (currentStep !== requiredStep) {
    res.status(409).json({
      success: false,
      message: buildTrainerStepLockMessage(requiredStep, currentStep),
      data: {
        registrationStep: currentStep,
        registrationStatus: workflowState.registrationStatus,
        nextStepLabel: getRegistrationStepMeta(currentStep).nextStepLabel,
        documentStatus: workflowState.workflow.documentStatus,
      },
    });
    return null;
  }

  return {
    ...workflowState,
    currentStep,
  };
};

// Middleware to check if user is SPOCAdmin or SuperAdmin
const isSPOCAdmin = (req, res, next) => {
  if (req.user.role !== "SPOCAdmin" && req.user.role !== "SuperAdmin") {
    return res
      .status(403)
      .json({ message: "Access denied. SPOC Admin or Super Admin only." });
  }
  next();
};

// GET /api/trainers
// Supports optional query: ?city=SALEM
router.get("/", authenticate, async (req, res) => {
  try {
    const allowedRoles = ["SuperAdmin", "SPOCAdmin", "AccouNDAnt"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied." });
    }

    const { city } = req.query;
    const userQuery = { role: "Trainer" };

    const trainerUsers = await User.find(userQuery).select(
      "name firstName lastName email phoneNumber city specialization experience isActive role createdAt",
    );
    const userIds = trainerUsers.map((u) => u._id);

    if (userIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const trainerQuery = { userId: { $in: userIds } };

    if (city && String(city).trim()) {
      const normalizedCityName = String(city).trim();
      const matchingCity = await City.findOne({
        name: new RegExp(`^${escapeRegex(normalizedCityName)}$`, "i"),
      }).select("_id name");

      trainerQuery.$or = [
        { city: new RegExp(`^${escapeRegex(normalizedCityName)}$`, "i") },
      ];

      if (matchingCity?._id) {
        trainerQuery.$or.unshift({ cityId: matchingCity._id });
      }
    }

    const trainers = await Trainer.find(trainerQuery)
      .populate(
        "userId",
        "name firstName lastName email phoneNumber city specialization experience isActive role createdAt",
      )
      .sort({ createdAt: -1 });

    const trainerIds = trainers.map((trainer) => trainer._id);
    let completedDaysMap = new Map();
    let pendingDaysMap = new Map();

    if (trainerIds.length > 0) {
      const attendanceSummary = await Attendance.aggregate([
        {
          $match: {
            trainerId: { $in: trainerIds },
          },
        },
        {
          $group: {
            _id: "$trainerId",
            completedDaysCount: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $ne: ["$completedAt", null] },
                      {
                        $and: [
                          { $eq: ["$verificationStatus", "approved"] },
                          {
                            $or: [
                              { $eq: ["$attendanceStatus", "PRESENT"] },
                              { $eq: ["$status", "Present"] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            pendingDaysCount: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$verificationStatus", "pending"] },
                      { $eq: ["$status", "Pending"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);

      completedDaysMap = new Map(
        attendanceSummary.map((entry) => [
          String(entry._id),
          Number(entry.completedDaysCount || 0),
        ]),
      );
      pendingDaysMap = new Map(
        attendanceSummary.map((entry) => [
          String(entry._id),
          Number(entry.pendingDaysCount || 0),
        ]),
      );
    }

    res.json({
      success: true,
      data: trainers.map((trainer) => {
        const enriched = enrichTrainerWithDocumentWorkflow(trainer);
        return {
          ...enriched,
          completedDaysCount: completedDaysMap.get(String(trainer._id)) || 0,
          pendingDaysCount: pendingDaysMap.get(String(trainer._id)) || 0,
        };
      }),
    });
  } catch (error) {
    console.error("Error fetching trainers:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/check-email", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const existingUser = await User.findOne({ email }).select(
      "name firstName lastName role accountStatus",
    );
    const trainer = await Trainer.findOne({ email }).populate(
      "userId",
      "name firstName lastName email accountStatus role",
    );

    if (!trainer && existingUser) {
      return res.json({
        success: true,
        status: "approved",
        step: 6,
        registrationStatus: "approved",
        trainerName:
          existingUser.firstName || existingUser.name || email.split("@")[0],
        message:
          "This email is already linked to an existing account. Please login to continue.",
      });
    }

    if (!trainer) {
      return res.json({
        success: true,
        status: "new",
        step: 1,
        nextStepLabel: "Email Verify",
      });
    }

    const {
      workflow,
      registrationStatus,
      resumeStep,
    } = await buildTrainerRegistrationWorkflowState(trainer);
    const { step, nextStepLabel } = getRegistrationStepMeta(
      registrationStatus === "pending" ? resumeStep : 6,
    );
    const trainerName =
      [trainer.firstName, trainer.lastName].filter(Boolean).join(" ").trim() ||
      trainer.userId?.firstName ||
      trainer.userId?.name ||
      email.split("@")[0];

    trainer.registrationStatus = registrationStatus;
    trainer.documentStatus = workflow.documentStatus;
    trainer.registrationStep = registrationStatus === "pending" ? resumeStep : 6;
    await trainer.save();

    if (registrationStatus === "approved") {
      return res.json({
        success: true,
        status: "approved",
        step: 6,
        registrationStatus,
        trainerName,
        message:
          "Your trainer account is already approved. Please login to access dashboard.",
      });
    }

    if (registrationStatus === "under_review") {
      return res.json({
        success: true,
        status: "review",
        step: 6,
        registrationStatus,
        trainerName,
        message:
          "Your registration is under review by Super Admin. You will receive approval soon.",
      });
    }

    return res.json({
      success: true,
      status: "resume",
      step,
      registrationStatus,
      trainerName,
      nextStepLabel,
      documentStatus: workflow.documentStatus,
      documentSummary: {
        uploadedCount: workflow.uploadedCount,
        approvedCount: workflow.approvedCount,
        pendingReviewCount: workflow.pendingReviewCount,
        requiredCount: workflow.requiredCount,
      },
      documentProgress: workflow.documentProgress,
      canProceedToAgreement: workflow.canProceedToAgreement,
      message:
        step > 1
          ? `Continue your registration from ${nextStepLabel}.`
          : "Continue your trainer registration.",
    });
  } catch (error) {
    console.error("check-email error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 📡 API – GET TRAINER PROGRESS (As requested)
router.get("/progress", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const trainer = await Trainer.findOne({ email });
    if (!trainer) {
      return res.json({});
    }

    const {
      normalizedTrainer,
      workflow,
      registrationStatus,
      resumeStep,
    } = await buildTrainerRegistrationWorkflowState(trainer);

    trainer.registrationStatus = registrationStatus;
    trainer.documentStatus = workflow.documentStatus;
    trainer.registrationStep = registrationStatus === "pending" ? resumeStep : 6;
    await trainer.save();

    res.json({
      ...normalizedTrainer,
      registrationStatus,
      registrationStep: registrationStatus === "pending" ? resumeStep : 6,
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
  } catch (error) {
    console.error("progress error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/nda-template", async (_req, res) => {
  try {
    const template = await getCurrentNdaTemplate();
    res.json({ success: true, data: template });
  } catch (error) {
    console.error("Error fetching NDA template:", error);
    res.status(500).json({ success: false, message: "Failed to load NDA agreement content." });
  }
});

router.put("/nda-template", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "SuperAdmin") {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const title = String(req.body?.title || "").trim();
    const introText = String(req.body?.introText || "").trim();
    const content = String(req.body?.content || "").trim();
    const acceptanceConditions = normalizeAcceptanceConditions(req.body || {});
    const checkboxLabel = acceptanceConditions[0] || DEFAULT_NDA_TEMPLATE.checkboxLabel;

    if (!content) {
      return res.status(400).json({
        success: false,
        message: "Agreement content is required.",
      });
    }

    const existingTemplate = await NdaTemplate.findOne({ key: NDA_TEMPLATE_KEY });
    const nextVersion = Math.max(Number(existingTemplate?.version || 0) + 1, 1);
    const updatedByCandidate = req.user?._id || req.user?.id || null;
    const updatedBy = mongoose.Types.ObjectId.isValid(updatedByCandidate)
      ? updatedByCandidate
      : null;

    const template = await NdaTemplate.findOneAndUpdate(
      { key: NDA_TEMPLATE_KEY },
      {
        $set: {
          title: title || DEFAULT_NDA_TEMPLATE.title,
          introText: introText || DEFAULT_NDA_TEMPLATE.introText,
          content,
          checkboxLabel,
          acceptanceConditions,
          version: nextVersion,
          updatedBy,
        },
        $setOnInsert: {
          key: NDA_TEMPLATE_KEY,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    ).populate("updatedBy", "name email");

    res.json({
      success: true,
      message: "NDA agreement content updated successfully.",
      data: normalizeNdaTemplate(template),
    });
  } catch (error) {
    console.error("Error updating NDA template:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update NDA agreement content.",
    });
  }
});

router.get("/nda-records", authenticate, async (req, res) => {
  try {
    const allowedRoles = ["SuperAdmin", "AccouNDAnt", "SPOCAdmin", "CollegeAdmin"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const trainers = await Trainer.find({
      email: { $exists: true, $ne: null },
    })
      .populate(
        "userId",
        "name firstName lastName email phoneNumber city specialization experience isActive role createdAt accountStatus",
      )
      .sort({ updatedAt: -1, createdAt: -1 });

    const data = trainers.map((trainer) => {
      const enriched = enrichTrainerWithDocumentWorkflow(trainer);
      const normalizedAgreement = normalizeTrainerAgreementFields(enriched);
      return {
        ...enriched,
        ...normalizedAgreement,
        agreementAccepted: normalizedAgreement.agreementAccepted,
        agreemeNDAccepted: normalizedAgreement.agreementAccepted,
        agreementDate: trainer.agreementDate,
        ndaAgreementPdf: normalizedAgreement.ndaAgreementPdf,
        ntaAgreementPdf: normalizedAgreement.ndaAgreementPdf,
        NDAAgreementPdf: normalizedAgreement.ndaAgreementPdf,
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error("Error fetching NDA records:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// 3️⃣ Trainer Register (All Steps Submit)
router.post("/register", async (req, res) => {
  try {
    const data = req.body;
    const { email } = data;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const agreementAccepted =
      (data.agreementAccepted ?? data.agreemeNDAccepted) !== false;
    const registrationState = getPersistedRegistrationState(6, {
      ...data,
      agreementAccepted,
    });

    // Use findOneAndUpdate to support resuming/updating existing records
    const trainer = await Trainer.findOneAndUpdate(
      { email },
      {
        ...data,
        emailVerified: true,
        agreementAccepted,
        status: "PENDING",
        agreementDate: new Date(),
        registrationStep: registrationState.registrationStep,
        registrationStatus: registrationState.registrationStatus,
      },
      { new: true, upsert: true, runValidators: true },
    );

    // notify admin
    notifyAdminNewTrainer(trainer);

    res.json({ success: true, message: "Registration successful!", trainer });
  } catch (error) {
    console.error("Trainer Register Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 📡 BACKEND API – CREATE STEP-1 (As requested)
router.post("/create-step1", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const user = await User.findOne({ email }).select("_id");
    const existing = await Trainer.findOne({ email });
    if (existing) {
      existing.emailVerified = true;
      existing.registrationStep = Math.max(existing.registrationStep || 1, 2);
      if (!existing.userId && user?._id) {
        existing.userId = user._id;
      }
      await existing.save();
      await ensureTrainerDriveFolder(existing);

      return res.json({
        success: true,
        message: "Trainer already exists, continuing...",
        trainer: existing,
      });
    }

    const trainer = await Trainer.create({
      email,
      emailVerified: true,
      userId: user?._id || null,
      status: "PENDING",
      registrationStep: 2,
      registrationStatus: "pending",
    });
    await ensureTrainerDriveFolder(trainer);

    res.json({
      success: true,
      message: "Step 1 created successfully",
      trainer,
    });
  } catch (error) {
    console.error("create-step1 error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 📡 BACKEND API – UPDATE STEP-2
router.post("/update-step2", async (req, res) => {
  try {
    const {
      email,
      firstName,
      lastName,
      mobile,
      phone,
      cityId,
      qualification,
      specialization,
      experience,
      address,
    } = req.body;
    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });

    const normalizedMobile = String(mobile || phone || "")
      .trim()
      .replace(/\D/g, "");

    if (!firstName || !lastName || !normalizedMobile || !cityId) {
      return res.status(400).json({
        success: false,
        message: "First name, last name, phone, and city are required",
      });
    }

    if (!/^\d{10}$/.test(normalizedMobile)) {
      return res.status(400).json({
        success: false,
        message: "Phone number must be a valid 10-digit number",
      });
    }

    const cityRecord = await City.findById(cityId).select("name");
    if (!cityRecord) {
      return res.status(400).json({
        success: false,
        message: "Selected city is invalid",
      });
    }

    const parsedExperience =
      experience === "" || experience === null || experience === undefined
        ? null
        : Number(experience);

    if (parsedExperience !== null && !Number.isFinite(parsedExperience)) {
      return res.status(400).json({
        success: false,
        message: "Experience must be a valid number",
      });
    }

    const trainer = await Trainer.findOne({ email });

    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    const stepAccess = await ensureTrainerStepAccess(res, trainer, 2);
    if (!stepAccess) {
      return;
    }

    trainer.firstName = String(firstName || "").trim();
    trainer.lastName = String(lastName || "").trim();
    trainer.mobile = normalizedMobile;
    trainer.cityId = cityId;
    trainer.city = cityRecord.name;
    if (qualification !== undefined) {
      trainer.qualification = String(qualification || "").trim();
    }
    if (specialization !== undefined) {
      trainer.specialization = String(specialization || "").trim();
    }
    if (experience !== undefined) {
      trainer.experience = parsedExperience;
    }
    if (address !== undefined) {
      trainer.address = String(address || "").trim();
    }
    trainer.registrationStep = 3;
    trainer.registrationStatus = "pending";

    await trainer.save();

    if (trainer.userId) {
      await User.findByIdAndUpdate(trainer.userId, {
        $set: {
          firstName: trainer.firstName,
          lastName: trainer.lastName,
          name: `${trainer.firstName} ${trainer.lastName}`.trim(),
          phoneNumber: trainer.mobile,
          city: trainer.city || "",
          specialization: trainer.specialization || "",
          experience: trainer.experience,
        },
      });
    }

    res.json({
      success: true,
      message: "Step 2 updated successfully",
      data: {
        registrationStep: 3,
        registrationStatus: "pending",
        nextStepLabel: getRegistrationStepMeta(3).nextStepLabel,
      },
    });
  } catch (error) {
    console.error("update-step2 error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 📡 BACKEND API – UPDATE STEP-3
router.post("/update-step3", async (req, res) => {
  try {
    const { email, documents } = req.body;
    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });

    const trainer = await Trainer.findOne({ email });
    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    const stepAccess = await ensureTrainerStepAccess(res, trainer, 3);
    if (!stepAccess) {
      return;
    }

    trainer.documents = {
      ...(trainer.documents?.toObject ? trainer.documents.toObject() : trainer.documents || {}),
      ...(documents || {}),
    };

    const workflow = await buildTrainerRegistrationWorkflowState(trainer);
    trainer.documentStatus = workflow.workflow.documentStatus;
    trainer.registrationStatus = workflow.registrationStatus;
    trainer.registrationStep =
      workflow.registrationStatus === "pending" ? workflow.resumeStep : 6;
    await trainer.save();

    res.json({
      success: true,
      message: "Step 3 updated successfully",
      data: {
        registrationStep: trainer.registrationStep,
        registrationStatus: trainer.registrationStatus,
        documentStatus: workflow.workflow.documentStatus,
        documentSummary: {
          uploadedCount: workflow.workflow.uploadedCount,
          approvedCount: workflow.workflow.approvedCount,
          pendingReviewCount: workflow.workflow.pendingReviewCount,
          requiredCount: workflow.workflow.requiredCount,
        },
        documentProgress: workflow.workflow.documentProgress,
        documentChecklist: workflow.workflow.checklist,
        hasAllRequiredDocuments: workflow.workflow.hasAllRequiredDocuments,
        allRequiredDocumentsApproved:
          workflow.workflow.allRequiredDocumentsApproved,
        canProceedToAgreement: workflow.workflow.canProceedToAgreement,
      },
    });
  } catch (error) {
    console.error("update-step3 error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 📡 BACKEND API – SUBMIT (Final Step)
router.post("/submit", async (req, res) => {
  try {
    const {
      email,
      signature,
      agreementAccepted,
      agreemeNDAccepted,
      agreementDate,
      password,
    } = req.body;
    if (!email)
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    if (!password) {
      return res
        .status(400)
        .json({ success: false, message: "Password is required" });
    }
    if (!signature) {
      return res
        .status(400)
        .json({ success: false, message: "Signature is required" });
    }

    const hasAcceptedAgreement =
      (agreementAccepted ?? agreemeNDAccepted) !== false;
    if (!hasAcceptedAgreement) {
      return res.status(400).json({
        success: false,
        message: "Agreement acceptance is required",
      });
    }

    const pwRegex =
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!pwRegex.test(password)) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be 8+ characters with uppercase, lowercase, digit, and special character.",
      });
    }

    let trainer = await Trainer.findOne({ email }).populate("cityId");
    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    const stepAccess = await ensureTrainerStepAccess(res, trainer, 5);
    if (!stepAccess) {
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // 1. Update signature and agreement status
    trainer.passwordHash = passwordHash;
    trainer.signature = signature;
    trainer.agreementAccepted = hasAcceptedAgreement;
    trainer.agreementDate = agreementDate || new Date();
    trainer.emailVerified = true;
    trainer.status = "PENDING";

    const registrationState = getPersistedRegistrationState(6, {
      ...trainer.toObject(),
      passwordHash,
      signature,
      agreementAccepted: hasAcceptedAgreement,
    });
    trainer.registrationStep = registrationState.registrationStep;
    trainer.registrationStatus = registrationState.registrationStatus;

    await trainer.save();

    // 2. Generate the signed NDA PDF and store it in the trainer's Drive folder
    const ndaUpload = await syncTrainerNdaAgreementPdfToDrive(trainer);
    await trainer.save();

    // 3. Update associated user account status
    const user = await User.findOne({ email });
    if (user) {
      const fullName = [trainer.firstName, trainer.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();

      user.password = password;
      user.plainPassword = password;
      user.accountStatus = "pending";
      user.emailVerified = true;
      user.isEmailVerified = true;
      if (fullName) {
        user.name = fullName;
        user.firstName = trainer.firstName || user.firstName;
        user.lastName = trainer.lastName || user.lastName;
      }
      await user.save();
    }

    // 🔔 Notify Admins
    notifyAdminNewTrainer(trainer);

    // 🔥 Auto-create Chat Channel between new Trainer and available SuperAdmins
    try {
      const superAdmins = await User.find({ role: "SuperAdmin", isActive: true });
      const trUser = await User.findOne({ email });
      if (trUser && superAdmins.length > 0) {
        await autoCreateTrainerAdminChannels(trUser, superAdmins);
      }
    } catch (chatErr) {
      console.error("Failed to auto-create Stream Chat channel on registration:", chatErr);
    }


    res.json({
      success: true,
      message: "Registration submitted successfully",
      ndaAgreementPdf: ndaUpload.filePath,
      ntaAgreementPdf: ndaUpload.filePath,
      NDAAgreementPdf: ndaUpload.filePath,
    });
  } catch (error) {
    console.error("submit error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 📡 BACKEND API – SAVE STEP (As requested)
router.post("/save-step", async (req, res) => {
  try {
    const { email, step, data } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    const trainer = await Trainer.findOne({ email });
    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    const stepAccess = await ensureTrainerStepAccess(res, trainer, 4);
    if (!stepAccess) {
      return;
    }

    const requestedStep = Math.min(Math.max(Number(step) || 4, 1), 6);
    if (![4, 5].includes(requestedStep)) {
      return res.status(400).json({
        success: false,
        message: "Only the Agreement step can be saved through this endpoint.",
      });
    }

    const registrationState = getPersistedRegistrationState(requestedStep, {
      ...(trainer.toObject ? trainer.toObject() : trainer),
      ...(data || {}),
    });

    Object.assign(trainer, data || {}, {
      registrationStep: registrationState.registrationStep,
      registrationStatus: registrationState.registrationStatus,
    });
    await trainer.save();

    res.json({
      success: true,
      message: "Step saved successfully",
      data: {
        registrationStep: trainer.registrationStep,
        registrationStatus: trainer.registrationStatus,
        nextStepLabel: getRegistrationStepMeta(trainer.registrationStep).nextStepLabel,
      },
    });
  } catch (error) {
    console.error("save-step error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/trainers/profile/me - Get current trainer profile
router.get("/profile/me", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "Trainer") {
      return res.status(403).json({ message: "Access denied. Trainers only." });
    }

    let trainer = await Trainer.findOne({ userId: req.user.id }).populate(
      "userId",
      "name email role city phoneNumber profileCompletedOnce isActive",
    );

    if (!trainer) {
      // Self-healing: Create profile if missing
      console.log(
        `[INFO] Auto-creating missing Trainer profile for user: ${req.user.id}`,
      );
      const newTrainer = await Trainer.create({
        userId: req.user.id,
        verificationStatus: "NOT_SUBMITTED",
      });

      // Re-fetch with population
      trainer = await Trainer.findById(newTrainer._id).populate(
        "userId",
        "name email role city phoneNumber profileCompletedOnce createdAt profilePicture",
      );
    }

    // Get colleges where this trainer is assigned
    const colleges = await College.find({ trainers: trainer._id }).select(
      "id name",
    );

    const normalizedTrainer = normalizeTrainerAgreementFields(trainer);
    const workflow = evaluateTrainerDocumentWorkflow(trainer);
    const canGenerateIdCard =
      String(trainer.status || "").trim().toUpperCase() === "APPROVED" ||
      ["VERIFIED", "APPROVED"].includes(
        String(trainer.verificationStatus || "").trim().toUpperCase(),
      ) ||
      String(trainer.registrationStatus || "").trim().toLowerCase() ===
        "approved";

    const formattedTrainer = {
      id: trainer._id,
      userId: trainer.userId?._id || req.user.id,
      trainerId: trainer.trainerId,
      trainerCode: trainer.trainerId,
      name: trainer.userId.name,
      email: trainer.userId.email,
      phone: trainer.phone,
      address: trainer.address,
      city: trainer.city || trainer.userId.city,
      specialization: trainer.specialization,
      status: trainer.status,
      verificationStatus: trainer.verificationStatus,
      registrationStatus: trainer.registrationStatus,
      approvedAt: trainer.approvedAt,
      createdAt: trainer.createdAt,
      joiningDate: trainer.approvedAt || trainer.createdAt || trainer.userId?.createdAt || null,
      profilePicture: trainer.profilePicture,
      photo:
        workflow.documentProgress?.selfiePhoto ||
        normalizedTrainer.documents?.selfiePhoto ||
        trainer.profilePicture ||
        workflow.documentProgress?.passportPhoto ||
        normalizedTrainer.documents?.passportPhoto ||
        trainer.userId?.profilePicture ||
        null,
      documents: normalizedTrainer.documents,
      documentProgress: workflow.documentProgress,
      documentChecklist: workflow.checklist,
      agreementAccepted: normalizedTrainer.agreementAccepted,
      agreemeNDAccepted: normalizedTrainer.agreementAccepted,
      ndaAgreementPdf: normalizedTrainer.ndaAgreementPdf,
      ntaAgreementPdf: normalizedTrainer.ndaAgreementPdf,
      NDAAgreementPdf: normalizedTrainer.ndaAgreementPdf,
      colleges: colleges,
      profileCompletedOnce: trainer.userId.profileCompletedOnce,
      isActive: trainer.userId.isActive,
      canGenerateIdCard,
    };
    formattedTrainer.documentStatus = workflow.documentStatus;
    formattedTrainer.documentSummary = {
      uploadedCount: workflow.uploadedCount,
      approvedCount: workflow.approvedCount,
      requiredCount: workflow.requiredCount,
    };
    formattedTrainer.missingDocuments = workflow.missingDocuments;
    formattedTrainer.rejectedDocuments = workflow.rejectedDocuments;
    formattedTrainer.hasAllRequiredDocuments =
      workflow.hasAllRequiredDocuments;

    res.json({ data: formattedTrainer });
  } catch (error) {
    console.error("[ERROR] /trainers/profile/me failed:");
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);

    try {
      const fs = require("fs");
      const path = require("path");
      const logPath = path.join(__dirname, "../profile_error.log");
      fs.appendFileSync(
        logPath,
        `[${new Date().toISOString()}] /profile/me ERROR: ${error.message}\nSTACK: ${error.stack}\n\n`,
      );
    } catch (e) {}

    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Import upload middleware
const upload = require("../middleware/upload");
const scanFile = require("../middleware/virusScan");

// POST /api/trainers/submit-registration
// @desc Finalize registration after document upload
// @access Trainer
router.post("/submit-registration", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "Trainer") {
      return res.status(403).json({ message: "Access denied. Trainers only." });
    }

    const trainer = await Trainer.findOne({ userId: req.user.id });
    if (!trainer) {
      return res.status(404).json({ message: "Trainer profile not found" });
    }

    const { workflow } = await buildTrainerRegistrationWorkflowState(trainer);
    if (!workflow?.hasAllRequiredDocuments) {
      return res.status(400).json({
        message: "Complete all required document uploads before submitting for admin review.",
        data: { missingDocuments: workflow?.missingDocuments || [] },
      });
    }

    const registrationState = getPersistedRegistrationState(
      6,
      trainer.toObject ? trainer.toObject() : trainer,
    );
    if (registrationState.registrationStep < 6) {
      return res.status(400).json({
        message:
          registrationState.registrationStep === 4
            ? "Complete the agreement step before submitting for admin review."
            : "Complete the password step before submitting for admin review.",
        data: {
          nextStep: registrationState.registrationStep,
        },
      });
    }

    // Update status to review stage
    trainer.verificationStatus = "PENDING";
    trainer.documentStatus = "under_review";
    trainer.registrationStep = registrationState.registrationStep;
    trainer.registrationStatus = registrationState.registrationStatus;
    await trainer.save();

    // Notify Admins
    const superAdmins = await User.find({ role: "SuperAdmin" });
    if (superAdmins.length > 0) {
      const adminEmails = superAdmins
        .map((admin) => admin.email)
        .filter((email) => email);
      const {
        sendAdminSubmissionNotificationEmail,
      } = require("../utils/emailService");
      await sendAdminSubmissionNotificationEmail(
        adminEmails,
        req.user.name,
        req.user.email,
        trainer.trainerId || "Pending",
      );
    }

    res.json({
      success: true,
      message: "Registration submitted successfully. Pending Admin approval.",
      status: "PENDING",
    });
  } catch (error) {
    console.error("Error submitting registration:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// POST /api/trainers/upload-document
// @desc Upload a document for a trainer
// @access Trainer, Super Admin
router.post(
  "/upload-document",
  authenticate,
  upload.single("file"),
  scanFile,
  async (req, res) => {
    try {
      const { trainerId, documentType } = req.body;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      // Validate document type
      const validTypes = [
        "aadhar_front",
        "aadhar_back",
        "pan",
        "bank_passbook",
        "degree_certificate",
        "resume",
      ];
      if (!validTypes.includes(documentType)) {
        return res.status(400).json({ message: "Invalid document type" });
      }

      // Find trainer
      // If user is Trainer, ensure they are uploading for themselves
      let query = { _id: trainerId };
      if (req.user.role === "Trainer") {
        const trainerProfile = await Trainer.findOne({ userId: req.user.id });
        if (!trainerProfile || trainerProfile._id.toString() !== trainerId) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const trainer = await Trainer.findById(trainerId);
      if (!trainer) {
        return res.status(404).json({ message: "Trainer not found" });
      }

      // Update document path
      const filePath = `/uploads/trainer-documents/${file.filename}`;

      if (documentType === "aadhar_front") {
        trainer.documents.aadhar = trainer.documents.aadhar || {};
        trainer.documents.aadhar.front = filePath;
        trainer.documents.aadhar.verified = false;
      } else if (documentType === "aadhar_back") {
        trainer.documents.aadhar = trainer.documents.aadhar || {};
        trainer.documents.aadhar.back = filePath;
        trainer.documents.aadhar.verified = false;
      } else if (documentType === "pan") {
        trainer.documents.pan = trainer.documents.pan || {};
        trainer.documents.pan.file = filePath;
        trainer.documents.pan.verified = false;
      } else if (documentType === "bank_passbook") {
        trainer.documents.bank = trainer.documents.bank || {};
        trainer.documents.bank.passbook = filePath;
        trainer.documents.bank.verified = false;
      } else if (documentType === "degree_certificate") {
        trainer.documents.degreeCertificate =
          trainer.documents.degreeCertificate || {};
        trainer.documents.degreeCertificate.file = filePath;
        trainer.documents.degreeCertificate.verified = false;
      } else if (documentType === "resume") {
        trainer.documents.resume = trainer.documents.resume || {};
        trainer.documents.resume.file = filePath;
        trainer.documents.resume.verified = false;
      }

      // Only set to PENDING if not in initial registration flow (which uses submit-registration)
      // Or if it's already VERIFIED/REJECTED and they are re-uploading
      if (trainer.verificationStatus !== "NOT_SUBMITTED") {
        trainer.verificationStatus = "PENDING";
      }

      await trainer.save();

      res.json({
        success: true,
        message: "Document uploaded successfully",
        data: {
          filePath,
          documentType,
          verificationStatus: "Pending",
        },
      });
    } catch (error) {
      console.error("Error uploading document:", error);
      res.status(500).json({ message: "Server error", error: error.message });
    }
  },
);

// PUT /api/trainers/:id/verify-document
// @desc Verify or reject a document
// @access Super Admin
router.put("/:id/verify-document", authenticate, async (req, res) => {
  try {
    // Only Super Admin can verify
    if (req.user.role !== "SuperAdmin") {
      return res
        .status(403)
        .json({ message: "Access denied. Super Admin only." });
    }

    const { documentType, verified, rejectionReason } = req.body;
    const trainer = await Trainer.findById(req.params.id);

    if (!trainer) {
      return res.status(404).json({ message: "Trainer not found" });
    }

    const updateData = {
      verified,
      verifiedAt: new Date(),
      verifiedBy: req.user.id,
      rejectionReason: verified ? null : rejectionReason,
    };

    if (documentType === "aadhar") {
      Object.assign(trainer.documents.aadhar, updateData);
    } else if (documentType === "pan") {
      Object.assign(trainer.documents.pan, updateData);
    } else if (documentType === "bank") {
      Object.assign(trainer.documents.bank, updateData);
    } else if (documentType === "degree_certificate") {
      Object.assign(trainer.documents.degreeCertificate, updateData);
    } else {
      return res.status(400).json({ message: "Invalid document type" });
    }

    // Check overall status
    const allVerified =
      trainer.documents.aadhar.verified &&
      trainer.documents.pan.verified &&
      trainer.documents.bank.verified &&
      trainer.documents.degreeCertificate.verified;

    if (allVerified) {
      trainer.verificationStatus = "VERIFIED";
    } else if (!verified) {
      // If any doc is rejected, overall status is rejected (or pending retry)
      // For now, let's keep it simple
      // If explicitly rejected, we might want to set overall to rejected or pending
    }

    await trainer.save();

    res.json({ message: "Document verification status updated", trainer });
  } catch (error) {
    console.error("Error verifying document:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// PUT /api/trainers/:id/verify-doc-detail
// @desc Verify a specific document within the trainer profile
// @access Super Admin
router.put("/:id/verify-doc-detail", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "SuperAdmin") {
      return res
        .status(403)
        .json({ message: "Access denied. Super Admin only." });
    }

    const { documentType, verified, rejectionReason } = req.body;
    const trainer = await Trainer.findById(req.params.id).populate("userId");

    if (!trainer) {
      return res.status(404).json({ message: "Trainer not found" });
    }

    // Email Data
    const trainerEmail = trainer.userId.email;
    const trainerName = trainer.userId.name;

    // 1. REJECTION LOGIC
    if (!verified && rejectionReason) {
      const docReadable = documentType.replace(/([A-Z])/g, " $1").trim();
      await sendDocumentRejectionEmail(
        trainerEmail,
        trainerName,
        docReadable,
        rejectionReason,
      );
    }

    // Update the new granular verification fields
    const updateFields = {
      [`documents.verification.${documentType}.verified`]: verified,
      [`documents.verification.${documentType}.reason`]: verified
        ? null
        : rejectionReason,
    };

    const updatedTrainer = await Trainer.findByIdAndUpdate(
      trainer._id,
      { $set: updateFields },
      { new: true },
    );

    // Optional: Auto-update overall status if all verified
    const d = updatedTrainer.documents;
    const v = d.verification || {};
    const requiredDocs = [
      "aadharFront",
      "aadharBack",
      "pan",
      "degreePdf",
      "passbook",
      "resumePdf",
    ];

    const allVerified = requiredDocs.every((k) => v[k]?.verified === true);
    const anyRejected = requiredDocs.some(
      (k) => d[k] && v[k]?.verified === false && v[k]?.reason,
    );

    // 2. BELL NOTIFICATION LOGIC
    if (!verified && rejectionReason) {
      const docReadable = documentType.replace(/([A-Z])/g, " $1").trim();
      await Notification.create({
        userId: trainer.userId._id, // User ID from populated trainer
        title: "Document Rejected",
        message: `Your ${docReadable} has been rejected. Reason: ${rejectionReason}`,
        type: "error",
        link: "/trainer/profile",
      });
    }

    if (allVerified) {
      if (updatedTrainer.status !== "APPROVED") {
        updatedTrainer.status = "APPROVED";
        updatedTrainer.approvedAt = new Date();
        updatedTrainer.approvedBy = req.user.id;

        // Rule: Profile -> selfie
        if (updatedTrainer.documents.selfiePhoto) {
          updatedTrainer.profilePicture = updatedTrainer.documents.selfiePhoto;
        } else if (updatedTrainer.documents.passportPhoto) {
          updatedTrainer.profilePicture =
            updatedTrainer.documents.passportPhoto;
        }

        if (updatedTrainer.profilePicture && updatedTrainer.userId) {
          await User.findByIdAndUpdate(updatedTrainer.userId, {
            $set: { profilePicture: updatedTrainer.profilePicture },
          });
        }

        // Regenerate PDF with Approval Stamp
        try {
          await syncTrainerNdaAgreementPdfToDrive(updatedTrainer);
        } catch (err) {
          console.error("Error regenerating PDF on approval:", err);
        }

        await sendAccountVerificationSuccessEmail(trainerEmail, trainerName);
      }
    } else if (anyRejected) {
      updatedTrainer.status = "REJECTED";
    }

    updatedTrainer.registrationStatus =
      resolveTrainerRegistrationStatus(updatedTrainer);

    await updatedTrainer.save();

    res.json({
      success: true,
      message: "Document status updated",
      data: {
        status: updatedTrainer.status,
        verification: updatedTrainer.documents.verification,
      },
    });
  } catch (error) {
    console.error("Error verifying document detail:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

router.post(
  "/upload-profile-picture",
  authenticate,
  upload.single("file"),
  async (req, res) => {
    const fsSync = require("fs");
    const path = require("path");
    const logFile = path.join(__dirname, "../access_debug.log");
    const log = (msg) => {
      try {
        fsSync.appendFileSync(
          logFile,
          `[UPLOAD] ${new Date().toISOString()} ${msg}\n`,
        );
      } catch (e) {}
      console.log(`[UPLOAD] ${msg}`);
    };

    try {
      log("Profile picture upload initiated");
      log(`User: ${req.user.role} ${req.user.id}`);
      log(`File received: ${req.file ? "YES" : "NO"}`);

      const file = req.file;
      if (!file) {
        log("ERROR: No file in request");
        return res.status(400).json({ message: "No file uploaded" });
      }

      log(
        `File details: ${JSON.stringify({
          filename: file.filename,
          originalname: file.originalname,
          path: file.path,
          mimetype: file.mimetype,
          size: file.size,
        })}`,
      );

      const allowedProfilePictureMimeTypes = new Set([
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "image/gif",
      ]);
      if (!allowedProfilePictureMimeTypes.has(file.mimetype)) {
        log(`ERROR: Invalid profile picture mime type: ${file.mimetype}`);
        return res.status(400).json({
          message:
            "Invalid profile picture type. Only JPG, PNG, WEBP, and GIF are allowed.",
        });
      }

      // CRITICAL: Check if file exists immediately after multer processes it
      const fileExistsNow = fsSync.existsSync(file.path);
      log(`File exists on disk immediately after upload: ${fileExistsNow}`);

      if (!fileExistsNow) {
        log("CRITICAL ERROR: File was not written to disk by multer!");
        log(`Expected path: ${file.path}`);
        log(`CWD: ${process.cwd()}`);
        return res.status(500).json({
          message: "File upload failed - file not written to disk",
          debug: {
            expectedPath: file.path,
            cwd: process.cwd(),
          },
        });
      }

      // Find trainer linked to this user
      let trainer;
      if (req.user.role === "Trainer") {
        trainer = await Trainer.findOne({ userId: req.user.id });
      } else if (
        req.user.role === "SPOCAdmin" ||
        req.user.role === "SuperAdmin"
      ) {
        if (req.body.trainerId) {
          trainer = await Trainer.findById(req.body.trainerId);
        }
      }

      if (!trainer) {
        log("ERROR: Trainer not found");
        if (req.user.role === "Trainer")
          return res.status(404).json({ message: "Trainer profile not found" });
        return res
          .status(400)
          .json({ message: "Trainer ID required for Admins" });
      }

      log(`Trainer found: ${trainer._id}`);

      const hierarchy = await ensureTrainerDocumentHierarchy({
        trainer,
        persistTrainer: true,
      });
      const fileBuffer = await fs.readFile(file.path);
      const profilePictureDriveFileName = buildProfilePictureDriveFileName(file);
      const driveUpload = await uploadToDrive({
        fileBuffer,
        mimeType: file.mimetype,
        originalName: file.originalname,
        folderId: hierarchy.documentsFolder.id,
        fileName: profilePictureDriveFileName,
        replaceExistingFile: false,
        cleanupDuplicateFiles: false,
      });

      trainer.profilePicture = driveUpload.fileUrl;
      await trainer.save();

      if (trainer.userId) {
        await User.findByIdAndUpdate(trainer.userId, {
          $set: { profilePicture: driveUpload.fileUrl },
        });
      }

      log("SUCCESS: Profile picture saved to database");
      log(`Drive file id: ${driveUpload.fileId}`);

      try {
        await cleanupDuplicateDriveFilesByName({
          folderId: hierarchy.documentsFolder.id,
          fileName: profilePictureDriveFileName,
          keepFileId: driveUpload.fileId,
        });
      } catch (duplicateCleanupError) {
        console.warn(
          "[UPLOAD] Failed to clean up older profile picture Drive files:",
          duplicateCleanupError.message,
        );
      }

      res.json({
        success: true,
        message: "Profile picture uploaded successfully",
        data: {
          profilePicture: driveUpload.fileUrl,
          driveFileId: driveUpload.fileId,
          driveViewLink: driveUpload.webViewLink,
          driveDownloadLink: driveUpload.downloadLink,
        },
      });
    } catch (error) {
      console.error("[UPLOAD] ERROR:", error);
      res.status(500).json({ message: "Server error", error: error.message });
    } finally {
      if (req.file?.path) {
        try {
          await fs.unlink(req.file.path);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") {
            console.warn(
              "[UPLOAD] Failed to clean up local profile picture temp file:",
              cleanupError.message,
            );
          }
        }
      }
    }
  },
);

// GET /api/trainers/export/data
// Returns trainer data with document details filtered by date
router.get("/export/data", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "SuperAdmin") {
      return res
        .status(403)
        .json({ message: "Access denied. Super Admin only." });
    }

    const { startDate, endDate } = req.query;
    let query = {};

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const trainers = await Trainer.find(query)
      .populate("userId", "name email phoneNumber city createdAt isActive")
      .sort({ createdAt: -1 });

    const exportData = trainers.map((t) => ({
      "Trainer ID": t.trainerId || "N/A",
      Name: t.userId?.name || "N/A",
      Email: t.userId?.email || "N/A",
      Phone: t.phone || t.userId?.phoneNumber || "N/A",
      City: t.userId?.city || "N/A",
      "Registration Date": t.createdAt
        ? t.createdAt.toISOString().split("T")[0]
        : "N/A",
      "Verification Status": t.verificationStatus,
      "Aadhaar Status": t.documents?.verification?.aadhaarFront?.verified
        ? "Verified"
        : "Pending/Rejected",
      "PAN Status": t.documents?.verification?.pan?.verified
        ? "Verified"
        : "Pending/Rejected",
      "Degree Status": t.documents?.verification?.degree?.verified
        ? "Verified"
        : "Pending/Rejected",
      "Resume Status": t.documents?.verification?.resume?.verified
        ? "Verified"
        : "Pending/Rejected",
    }));

    res.json({ success: true, data: exportData });
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/trainers/:id
router.put("/:id", authenticate, async (req, res) => {
  try {
    const allowedRoles = ["SuperAdmin", "SPOCAdmin", "AccouNDAnt"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const trainer = await Trainer.findById(req.params.id).populate(
      "userId",
      "name firstName lastName email phoneNumber city specialization experience isActive role createdAt",
    );

    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    const {
      trainerCode,
      firstName,
      lastName,
      name,
      email,
      phone,
      mobile,
      cityId,
      city,
      qualification,
      specialization,
      experience,
      address,
      status,
      verificationStatus,
    } = req.body || {};

    const normalizedTrainerCode = String(
      trainerCode || trainer.trainerId || "",
    )
      .trim()
      .toUpperCase();
    if (
      normalizedTrainerCode &&
      normalizedTrainerCode !== trainer.trainerId
    ) {
      const existingTrainerCode = await Trainer.findOne({
        trainerId: normalizedTrainerCode,
        _id: { $ne: trainer._id },
      }).select("_id");

      if (existingTrainerCode) {
        return res.status(400).json({
          success: false,
          message: "Trainer ID already exists",
        });
      }
      trainer.trainerId = normalizedTrainerCode;
    }

    const normalizedEmail = String(email || trainer.email || "")
      .trim()
      .toLowerCase();
    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    if (normalizedEmail !== trainer.email) {
      const duplicateTrainer = await Trainer.findOne({
        email: normalizedEmail,
        _id: { $ne: trainer._id },
      }).select("_id");
      if (duplicateTrainer) {
        return res.status(400).json({
          success: false,
          message: "Another trainer is already using this email",
        });
      }

      const duplicateUser = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: trainer.userId?._id || trainer.userId || null },
      }).select("_id");
      if (duplicateUser) {
        return res.status(400).json({
          success: false,
          message: "Another user is already using this email",
        });
      }
    }

    const splitName = String(name || "").trim().split(/\s+/).filter(Boolean);
    const normalizedFirstName = String(
      firstName || trainer.firstName || splitName[0] || "",
    ).trim();
    const normalizedLastName = String(
      lastName ||
        trainer.lastName ||
        (splitName.length > 1 ? splitName.slice(1).join(" ") : ""),
    ).trim();
    const normalizedPhone = String(mobile || phone || trainer.mobile || "")
      .trim()
      .replace(/\D/g, "");

    if (normalizedPhone && !/^\d{10}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message: "Phone number must be a valid 10-digit number",
      });
    }

    let nextCityId = trainer.cityId || null;
    let nextCityName = String(trainer.city || "").trim();

    if (cityId) {
      const cityRecord = await City.findById(cityId).select("name");
      if (!cityRecord) {
        return res.status(400).json({
          success: false,
          message: "Selected city is invalid",
        });
      }
      nextCityId = cityRecord._id;
      nextCityName = cityRecord.name;
    } else if (typeof city === "string") {
      const normalizedCityName = city.trim();
      if (!normalizedCityName) {
        nextCityId = null;
        nextCityName = "";
      } else {
        const cityRecord = await City.findOne({
          name: new RegExp(`^${escapeRegex(normalizedCityName)}$`, "i"),
        }).select("name");
        if (!cityRecord) {
          return res.status(400).json({
            success: false,
            message: "Selected city is invalid",
          });
        }
        nextCityId = cityRecord._id;
        nextCityName = cityRecord.name;
      }
    }

    const parsedExperience =
      experience === "" || experience === null || experience === undefined
        ? null
        : Number(experience);

    if (parsedExperience !== null && !Number.isFinite(parsedExperience)) {
      return res.status(400).json({
        success: false,
        message: "Experience must be a valid number",
      });
    }

    trainer.email = normalizedEmail;
    trainer.firstName = normalizedFirstName;
    trainer.lastName = normalizedLastName;
    trainer.mobile = normalizedPhone || "";
    trainer.cityId = nextCityId || null;
    trainer.city = nextCityName;
    if (qualification !== undefined) {
      trainer.qualification = String(qualification || "").trim();
    }
    if (specialization !== undefined) {
      trainer.specialization = String(specialization || "").trim();
    }
    if (experience !== undefined) {
      trainer.experience = parsedExperience;
    }
    if (address !== undefined) {
      trainer.address = String(address || "").trim();
    }

    const normalizedOverallStatus = String(
      status || verificationStatus || trainer.status || "",
    )
      .trim()
      .toUpperCase();
    if (["PENDING", "APPROVED", "REJECTED"].includes(normalizedOverallStatus)) {
      trainer.status = normalizedOverallStatus;
      if (normalizedOverallStatus === "APPROVED") {
        trainer.verificationStatus = "VERIFIED";
        trainer.registrationStatus = "approved";
        trainer.registrationStep = 6;
      } else if (normalizedOverallStatus === "REJECTED") {
        trainer.verificationStatus = "REJECTED";
      } else if (trainer.verificationStatus === "VERIFIED") {
        trainer.verificationStatus = "PENDING";
      }
    }

    if (
      trainer.registrationStatus === "pending" &&
      hasCompletedTrainerDetails(trainer) &&
      Number(trainer.registrationStep || 1) < 3
    ) {
      trainer.registrationStep = 3;
    }

    await trainer.save();

    if (trainer.userId) {
      const fullName = [trainer.firstName, trainer.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();

      await User.findByIdAndUpdate(trainer.userId._id || trainer.userId, {
        $set: {
          name: fullName || trainer.userId?.name || "Pending Trainer",
          firstName: trainer.firstName || "",
          lastName: trainer.lastName || "",
          email: normalizedEmail,
          phoneNumber: trainer.mobile || "",
          city: trainer.city || "",
          specialization: trainer.specialization || "",
          experience: trainer.experience,
        },
      });
    }

    const refreshedTrainer = await Trainer.findById(trainer._id).populate(
      "userId",
      "name firstName lastName email phoneNumber city specialization experience isActive role createdAt",
    );

    res.json({
      success: true,
      message: "Trainer updated successfully",
      data: enrichTrainerWithDocumentWorkflow(refreshedTrainer),
    });
  } catch (error) {
    console.error("Error updating trainer:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/trainers/:id
router.get("/:id", authenticate, async (req, res) => {
  try {
    const allowedRoles = ["SuperAdmin", "SPOCAdmin", "AccouNDAnt"];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied." });
    }

    const trainer = await Trainer.findById(req.params.id).populate(
      "userId",
      "name firstName lastName email phoneNumber city specialization experience isActive role createdAt",
    );

    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    res.json({ success: true, data: enrichTrainerWithDocumentWorkflow(trainer) });
  } catch (error) {
    console.error("Error fetching trainer:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// DELETE /api/trainers/:id
router.delete("/:id", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "SuperAdmin") {
      return res.status(403).json({ message: "Access denied." });
    }

    const trainer = await Trainer.findById(req.params.id).populate(
      "userId",
      "_id name email role profilePicture",
    );
    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    if (trainer.userId?._id || trainer.userId) {
      try {
        await cleanupDeletedUserChatArtifacts(trainer.userId);
      } catch (chatCleanupError) {
        console.warn(
          "Trainer chat cleanup failed during delete:",
          chatCleanupError.message,
        );
      }

      await User.findByIdAndDelete(trainer.userId?._id || trainer.userId);
    }

    await Trainer.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Trainer deleted successfully" });
  } catch (error) {
    console.error("Error deleting trainer:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
