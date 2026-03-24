const REQUIRED_TRAINER_DOCUMENTS = [
  { key: "selfiePhoto", label: "Live Selfie" },
  { key: "passportPhoto", label: "Passport Photo" },
  { key: "aadharFront", label: "Aadhaar Front" },
  { key: "aadharBack", label: "Aadhaar Back" },
  { key: "pan", label: "PAN Card" },
  { key: "passbook", label: "Bank Proof" },
  { key: "degreePdf", label: "Degree Certificate" },
  { key: "resumePdf", label: "Resume" },
];

const APPROVED_PROFILE_STATUSES = new Set(["APPROVED", "VERIFIED"]);

const normalizeDocReviewState = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "VERIFIED") return "APPROVED";
  if (["APPROVED", "REJECTED", "PENDING"].includes(normalized)) {
    return normalized;
  }
  return null;
};

const hasCompletedTrainerDetails = (trainer = {}) => {
  const firstName = String(trainer?.firstName || "").trim();
  const lastName = String(trainer?.lastName || "").trim();
  const mobile = String(trainer?.mobile || trainer?.phone || "").trim();

  return Boolean(firstName && lastName && mobile);
};

const buildDocumentProgressMap = (
  checklist = [],
  docs = {},
  trainerDocuments = [],
) => {
  const trainerDocumentMap = trainerDocuments.reduce((accumulator, document) => {
    if (document?.documentType) {
      accumulator[document.documentType] = document;
    }

    return accumulator;
  }, {});

  return checklist.reduce((accumulator, item) => {
    const uploaded = Boolean(item?.uploaded);
    const trainerDocument = trainerDocumentMap[item.key] || null;
    const storedUrl =
      trainerDocument?.filePath || docs?.[item.key] || null;

    accumulator[item.key] = {
      key: item.key,
      label: item.label,
      url: uploaded ? storedUrl : null,
      filePath: uploaded ? storedUrl : null,
      driveViewLink: uploaded ? trainerDocument?.driveViewLink || null : null,
      driveDownloadLink:
        uploaded ? trainerDocument?.driveDownloadLink || null : null,
      driveFileId: uploaded ? trainerDocument?.driveFileId || null : null,
      verificationStatus: uploaded
        ? trainerDocument?.verificationStatus || item.reviewState || null
        : null,
      status: uploaded
        ? item.isApproved
          ? "approved"
          : item.isRejected
            ? "rejected"
            : "pending"
        : "missing",
      rejectionReason: item.rejectionReason || null,
      uploaded,
    };
    return accumulator;
  }, {});
};

const getDocumentVerificationMap = (trainer = {}, trainerDocuments = []) => {
  const reviewMap = new Map();

  trainerDocuments.forEach((doc) => {
    if (doc?.documentType) {
      reviewMap.set(
        doc.documentType,
        {
          reviewState: normalizeDocReviewState(doc.verificationStatus),
          reason: doc?.verificationComment || null,
        },
      );
    }
  });

  const verificationEntries = trainer?.documents?.verification;
  if (verificationEntries) {
    const entries =
      verificationEntries instanceof Map
        ? Array.from(verificationEntries.entries())
        : Object.entries(verificationEntries);

    entries.forEach(([key, value]) => {
      if (reviewMap.has(key)) return;

      if (value?.reason) {
        reviewMap.set(key, {
          reviewState: "REJECTED",
          reason: value.reason,
        });
      } else if (value?.verified === true) {
        reviewMap.set(key, {
          reviewState: "APPROVED",
          reason: null,
        });
      } else if (value?.verified === false) {
        reviewMap.set(key, {
          reviewState: "PENDING",
          reason: null,
        });
      }
    });
  }

  return reviewMap;
};

const evaluateTrainerDocumentWorkflow = (trainer = {}, trainerDocuments = []) => {
  const docs = trainer?.documents || {};
  const reviewMap = getDocumentVerificationMap(trainer, trainerDocuments);
  const existingDocumentStatus = String(trainer?.documentStatus || "")
    .trim()
    .toLowerCase();
  const profileStatus = String(
    trainer?.verificationStatus || trainer?.status || "",
  )
    .trim()
    .toUpperCase();

  const checklist = REQUIRED_TRAINER_DOCUMENTS.map(({ key, label }) => {
    const uploaded = Boolean(docs[key]);
    const reviewEntry = reviewMap.get(key) || {};
    const rawReviewState = reviewEntry.reviewState || null;
    const isApproved = rawReviewState === "APPROVED";
    const isRejected = rawReviewState === "REJECTED";
    const isPendingReview = uploaded && !isApproved && !isRejected;
    const reviewState =
      rawReviewState || (isPendingReview ? "PENDING" : null);

    return {
      key,
      label,
      uploaded,
      reviewState,
      rejectionReason: reviewEntry.reason || null,
      isRejected,
      isApproved,
      isPendingReview,
    };
  });

  const missingDocuments = checklist
    .filter((item) => !item.uploaded)
    .map(({ key, label }) => ({ key, label }));
  const rejectedDocuments = checklist
    .filter((item) => item.isRejected)
    .map(({ key, label, rejectionReason }) => ({
      key,
      label,
      rejectionReason: rejectionReason || null,
    }));
  const uploadedCount = checklist.filter((item) => item.uploaded).length;
  const approvedCount = checklist.filter((item) => item.isApproved).length;
  const pendingReviewCount = checklist.filter(
    (item) => item.isPendingReview,
  ).length;
  const requiredCount = checklist.length;
  const hasAllRequiredDocuments = missingDocuments.length === 0;
  const hasRejectedDocuments = rejectedDocuments.length > 0;
  const allRequiredDocumentsApproved =
    hasAllRequiredDocuments && approvedCount === requiredCount;
  const hasPendingVerification = pendingReviewCount > 0;

  let documentStatus = "pending";

  if (
    APPROVED_PROFILE_STATUSES.has(profileStatus) ||
    existingDocumentStatus === "approved" ||
    allRequiredDocumentsApproved
  ) {
    documentStatus = "approved";
  } else if (hasRejectedDocuments) {
    documentStatus = "rejected";
  } else if (hasAllRequiredDocuments) {
    documentStatus = "under_review";
  } else if (existingDocumentStatus === "uploaded") {
    documentStatus = "uploaded";
  }

  return {
    documentStatus,
    checklist,
    documentProgress: buildDocumentProgressMap(checklist, docs, trainerDocuments),
    missingDocuments,
    rejectedDocuments,
    uploadedCount,
    approvedCount,
    pendingReviewCount,
    requiredCount,
    hasAllRequiredDocuments,
    allRequiredDocumentsApproved,
    hasRejectedDocuments,
    hasPendingVerification,
    canProceedToAgreement: allRequiredDocumentsApproved,
  };
};

const resolveTrainerRegistrationStatus = (trainer = {}, summary = null) => {
  const existingRegistrationStatus = String(trainer?.registrationStatus || "")
    .trim()
    .toLowerCase();
  const profileStatus = String(trainer?.status || "").trim().toUpperCase();
  const workflowSummary = summary || evaluateTrainerDocumentWorkflow(trainer);
  const registrationStep = Number(trainer?.registrationStep || 1);
  const hasAgreementSubmission = Boolean(
    (trainer?.agreementAccepted ?? trainer?.agreemeNDAccepted) &&
      trainer?.signature,
  );
  const hasFinalRegistrationSubmission =
    registrationStep >= 6 ||
    (Boolean(trainer?.passwordHash) && hasAgreementSubmission);

  if (
    existingRegistrationStatus === "approved" ||
    profileStatus === "APPROVED"
  ) {
    return "approved";
  }

  if (
    hasFinalRegistrationSubmission &&
    profileStatus !== "REJECTED" &&
    workflowSummary.documentStatus !== "rejected" &&
    (existingRegistrationStatus === "under_review" || registrationStep >= 6)
  ) {
    return "under_review";
  }

  return "pending";
};

const resolveTrainerResumeStep = (trainer = {}, summary = null) => {
  const workflowSummary = summary || evaluateTrainerDocumentWorkflow(trainer);
  const currentStep = Math.max(Number(trainer?.registrationStep || 1), 1);
  const hasPersonalDetails = hasCompletedTrainerDetails(trainer);
  const hasAgreementSubmission = Boolean(
    (trainer?.agreementAccepted ?? trainer?.agreemeNDAccepted) &&
      trainer?.signature,
  );
  const hasPassword = Boolean(trainer?.passwordHash);

  if (currentStep <= 2) {
    return hasPersonalDetails ? 3 : 2;
  }

  if (
    workflowSummary.hasRejectedDocuments ||
    !workflowSummary.hasAllRequiredDocuments ||
    !workflowSummary.allRequiredDocumentsApproved
  ) {
    return 3;
  }

  if (!hasAgreementSubmission) {
    return 4;
  }

  if (!hasPassword) {
    return 5;
  }

  return 6;
};

const syncTrainerDocumentWorkflow = (trainer, trainerDocuments = []) => {
  const summary = evaluateTrainerDocumentWorkflow(trainer, trainerDocuments);

  if (trainer) {
    trainer.documentStatus = summary.documentStatus;

    if (String(trainer.status || "").trim().toUpperCase() === "APPROVED") {
      trainer.verificationStatus = "VERIFIED";
    } else if (summary.documentStatus === "rejected") {
      trainer.verificationStatus = "REJECTED";
    } else if (summary.hasAllRequiredDocuments) {
      trainer.verificationStatus = "PENDING";
    } else {
      trainer.verificationStatus = "NOT_SUBMITTED";
    }

    trainer.registrationStatus = resolveTrainerRegistrationStatus(
      trainer,
      summary,
    );
    trainer.registrationStep =
      trainer.registrationStatus === "pending"
        ? resolveTrainerResumeStep(trainer, summary)
        : 6;
  }

  return summary;
};

module.exports = {
  REQUIRED_TRAINER_DOCUMENTS,
  buildDocumentProgressMap,
  evaluateTrainerDocumentWorkflow,
  hasCompletedTrainerDetails,
  resolveTrainerRegistrationStatus,
  resolveTrainerResumeStep,
  syncTrainerDocumentWorkflow,
};
