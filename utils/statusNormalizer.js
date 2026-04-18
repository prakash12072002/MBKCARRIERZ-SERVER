const toNormalizedToken = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const pickCanonicalStatus = (value, mapping, fallback) => {
  const token = toNormalizedToken(value);

  if (!token) {
    return fallback;
  }

  if (Object.prototype.hasOwnProperty.call(mapping, token)) {
    return mapping[token];
  }

  return fallback;
};

const normalizeAttendanceVerificationStatus = (value, fallback = "pending") =>
  pickCanonicalStatus(
    value,
    {
      approved: "approved",
      approve: "approved",
      verified: "approved",
      rejected: "rejected",
      reject: "rejected",
      pending: "pending",
      in_progress: "pending",
      inprogress: "pending",
      under_review: "pending",
      review: "pending",
    },
    fallback,
  );

const normalizeAttendancePresenceStatus = (value, fallback = "Pending") =>
  pickCanonicalStatus(
    value,
    {
      present: "Present",
      approved: "Present",
      verified: "Present",
      absent: "Absent",
      rejected: "Absent",
      pending: "Pending",
      in_progress: "Pending",
      inprogress: "Pending",
      under_review: "Pending",
      review: "Pending",
      leave: "Leave",
      late: "Late",
    },
    fallback,
  );

const normalizeAttendanceFinalStatus = (value, fallback = "PENDING") =>
  pickCanonicalStatus(
    value,
    {
      completed: "COMPLETED",
      complete: "COMPLETED",
      approved: "COMPLETED",
      verified: "COMPLETED",
      pending: "PENDING",
      in_progress: "PENDING",
      inprogress: "PENDING",
      under_review: "PENDING",
      review: "PENDING",
      rejected: "PENDING",
    },
    fallback,
  );

const normalizeCheckOutVerificationStatus = (
  value,
  fallback = "PENDING_CHECKOUT",
) =>
  pickCanonicalStatus(
    value,
    {
      pending: "PENDING_CHECKOUT",
      pending_checkout: "PENDING_CHECKOUT",
      awaiting_checkout: "PENDING_CHECKOUT",
      auto_verified: "AUTO_VERIFIED",
      autoverified: "AUTO_VERIFIED",
      approved: "AUTO_VERIFIED",
      verified: "AUTO_VERIFIED",
      completed: "AUTO_VERIFIED",
      manual_review_required: "MANUAL_REVIEW_REQUIRED",
      manual_review: "MANUAL_REVIEW_REQUIRED",
      review_required: "MANUAL_REVIEW_REQUIRED",
      under_review: "MANUAL_REVIEW_REQUIRED",
      rejected: "REJECTED",
      reject: "REJECTED",
    },
    fallback,
  );

const normalizeTrainerDocumentVerificationStatus = (
  value,
  fallback = "PENDING",
) =>
  pickCanonicalStatus(
    value,
    {
      approved: "APPROVED",
      approve: "APPROVED",
      verified: "APPROVED",
      rejected: "REJECTED",
      reject: "REJECTED",
      pending: "PENDING",
      in_progress: "PENDING",
      inprogress: "PENDING",
      under_review: "PENDING",
      review: "PENDING",
    },
    fallback,
  );

const normalizeTrainerOverallStatus = (value, fallback = "PENDING") =>
  pickCanonicalStatus(
    value,
    {
      approved: "APPROVED",
      approve: "APPROVED",
      verified: "APPROVED",
      rejected: "REJECTED",
      reject: "REJECTED",
      pending: "PENDING",
      in_progress: "PENDING",
      inprogress: "PENDING",
      under_review: "PENDING",
      review: "PENDING",
    },
    fallback,
  );

module.exports = {
  normalizeAttendanceVerificationStatus,
  normalizeAttendancePresenceStatus,
  normalizeAttendanceFinalStatus,
  normalizeCheckOutVerificationStatus,
  normalizeTrainerDocumentVerificationStatus,
  normalizeTrainerOverallStatus,
};
