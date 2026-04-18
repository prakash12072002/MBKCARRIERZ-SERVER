const FETCH_DOCUMENTS_FAILED_MESSAGE = "Failed to fetch documents";
const TRAINER_PROFILE_NOT_FOUND_MESSAGE = "Trainer profile not found";
const INVALID_TRAINER_ID_MESSAGE = "Invalid trainer ID";
const NDA_DEFAULT_FILE_NAME = "NDA-Form.pdf";
const INVALID_DOCUMENT_ID_MESSAGE = "Invalid document ID";
const INVALID_VERIFICATION_STATUS_MESSAGE = "Invalid verification status";
const DOCUMENT_NOT_FOUND_MESSAGE = "Document not found";
const VERIFY_DOCUMENT_FAILED_MESSAGE = "Failed to verify document";
const VERIFY_DOCUMENT_SUCCESS_MESSAGE = "Document verification updated";
const VERIFY_DOCUMENT_REJECTED_SUCCESS_MESSAGE =
  "Document rejected and removed. Trainer can re-upload a replacement.";
const VERIFY_DOCUMENT_REJECTED_CLEANUP_WARNING_MESSAGE =
  "Document rejected. Trainer can re-upload, but the previous Drive file could not be deleted automatically.";
const TRAINER_SIGNUP_RESUME_LINK = `${
  process.env.FRONTEND_URL || "http://localhost:3000"
}/trainer-signup`;
const TRAINER_LOGIN_ROUTE = "/login";
const TRAINER_PROFILE_ROUTE = "/trainer/profile";
const NOTIFICATION_TYPE_APPROVAL = "Approval";
const INVALID_STATUS_MESSAGE = "Invalid status";
const TRAINER_NOT_FOUND_MESSAGE = "Trainer not found";
const UPDATE_TRAINER_STATUS_FAILED_MESSAGE = "Failed to update trainer status";
const ACCESS_DENIED_MESSAGE = "Access denied";
const TRAINER_REMINDER_SUCCESS_MESSAGE =
  "Reminder email sent to trainer successfully";
const TRAINER_REMINDER_FAILED_MESSAGE = "Failed to send trainer reminder";
const TRAINER_NO_OUTSTANDING_DOCUMENTS_MESSAGE =
  "This trainer has no missing or rejected documents.";
const MOVE_TO_REVIEW_SUCCESS_MESSAGE = "Trainer moved to Review Docs successfully";
const MOVE_TO_REVIEW_FAILED_MESSAGE = "Failed to move trainer to review";
const TRAINER_MISSING_REQUIRED_DOCUMENTS_MESSAGE =
  "Trainer is still missing required documents";
const TRAINER_HAS_REJECTED_DOCUMENTS_MESSAGE =
  "Trainer has rejected documents and cannot move to review";
const SUBMIT_VERIFICATION_SUCCESS_MESSAGE =
  "Profile submitted for verification successfully";
const SUBMIT_VERIFICATION_FAILED_MESSAGE =
  "Failed to submit for verification";
const SUBMISSION_RECEIVED_TITLE = "Submission Received";
const SUBMISSION_RECEIVED_MESSAGE =
  "Your documents have been submitted securely. An admin will review them shortly.";
const DOCUMENT_UPLOAD_SUCCESS_MESSAGE = "Document uploaded successfully";
const DOCUMENT_UPLOAD_FAILED_MESSAGE = "Failed to upload document";
const INVALID_DOCUMENT_TYPE_MESSAGE = "Invalid document type";
const NO_FILE_UPLOADED_MESSAGE = "No file uploaded";
const VALID_NOTIFICATION_ROLES = Object.freeze([
  "SuperAdmin",
  "CompanyAdmin",
  "CollegeAdmin",
  "SPOCAdmin",
  "Trainer",
  "AccouNDAnt",
  "Student",
]);

module.exports = {
  DOCUMENT_NOT_FOUND_MESSAGE,
  FETCH_DOCUMENTS_FAILED_MESSAGE,
  ACCESS_DENIED_MESSAGE,
  INVALID_DOCUMENT_ID_MESSAGE,
  INVALID_TRAINER_ID_MESSAGE,
  INVALID_STATUS_MESSAGE,
  INVALID_VERIFICATION_STATUS_MESSAGE,
  NDA_DEFAULT_FILE_NAME,
  NOTIFICATION_TYPE_APPROVAL,
  SUBMISSION_RECEIVED_MESSAGE,
  SUBMISSION_RECEIVED_TITLE,
  DOCUMENT_UPLOAD_SUCCESS_MESSAGE,
  DOCUMENT_UPLOAD_FAILED_MESSAGE,
  INVALID_DOCUMENT_TYPE_MESSAGE,
  NO_FILE_UPLOADED_MESSAGE,
  SUBMIT_VERIFICATION_FAILED_MESSAGE,
  SUBMIT_VERIFICATION_SUCCESS_MESSAGE,
  TRAINER_LOGIN_ROUTE,
  TRAINER_PROFILE_ROUTE,
  TRAINER_NO_OUTSTANDING_DOCUMENTS_MESSAGE,
  TRAINER_NOT_FOUND_MESSAGE,
  TRAINER_PROFILE_NOT_FOUND_MESSAGE,
  TRAINER_MISSING_REQUIRED_DOCUMENTS_MESSAGE,
  TRAINER_HAS_REJECTED_DOCUMENTS_MESSAGE,
  TRAINER_REMINDER_FAILED_MESSAGE,
  TRAINER_REMINDER_SUCCESS_MESSAGE,
  TRAINER_SIGNUP_RESUME_LINK,
  MOVE_TO_REVIEW_FAILED_MESSAGE,
  MOVE_TO_REVIEW_SUCCESS_MESSAGE,
  UPDATE_TRAINER_STATUS_FAILED_MESSAGE,
  VALID_NOTIFICATION_ROLES,
  VERIFY_DOCUMENT_FAILED_MESSAGE,
  VERIFY_DOCUMENT_REJECTED_CLEANUP_WARNING_MESSAGE,
  VERIFY_DOCUMENT_REJECTED_SUCCESS_MESSAGE,
  VERIFY_DOCUMENT_SUCCESS_MESSAGE,
};
