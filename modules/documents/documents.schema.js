const parseMyDocumentsContext = (user = null) => ({
  userId: user?.id || user?._id || null,
});

const parseTrainerDocumentsParams = (params = {}) => ({
  trainerId: String(params?.trainerId || "").trim(),
});

const parseVerifyDocumentParams = (params = {}) => ({
  documentId: String(params?.id || "").trim(),
});

const parseVerifyDocumentBody = (body = {}) => ({
  verificationStatus: body?.verificationStatus,
  verificationComment: body?.verificationComment,
});

const parseTrainerStatusParams = (params = {}) => ({
  trainerId: String(params?.trainerId || "").trim(),
});

const parseTrainerStatusBody = (body = {}) => ({
  status: body?.status,
  reason: body?.reason,
});

const parseTrainerApproachParams = (params = {}) => ({
  trainerId: String(params?.trainerId || "").trim(),
});

const parseTrainerApproachContext = (user = null) => ({
  actorUserId: user?.id || user?._id || null,
  actorRole: String(user?.role || "").trim(),
});

const parseTrainerMoveToReviewParams = (params = {}) => ({
  trainerId: String(params?.trainerId || "").trim(),
});

const parseTrainerMoveToReviewContext = (user = null) => ({
  actorRole: String(user?.role || "").trim(),
});

const parseSubmitVerificationContext = (user = null) => ({
  actorUserId: user?.id || user?._id || null,
  actorRole: String(user?.role || "").trim(),
});

const parseUploadDocumentBody = (body = {}) => ({
  documentType: body?.documentType,
  accountNumber: body?.accountNumber,
  bankName: body?.bankName,
  ifscCode: body?.ifscCode,
  email: body?.email,
  targetTrainerId: body?.targetTrainerId,
});

const parseUploadDocumentContext = (user = null) => ({
  actorUser: user || null,
});

module.exports = {
  parseMyDocumentsContext,
  parseTrainerApproachContext,
  parseTrainerApproachParams,
  parseSubmitVerificationContext,
  parseUploadDocumentBody,
  parseUploadDocumentContext,
  parseTrainerMoveToReviewContext,
  parseTrainerMoveToReviewParams,
  parseTrainerStatusBody,
  parseTrainerStatusParams,
  parseTrainerDocumentsParams,
  parseVerifyDocumentBody,
  parseVerifyDocumentParams,
};
