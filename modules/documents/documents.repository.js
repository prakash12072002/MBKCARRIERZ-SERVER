const mongoose = require("mongoose");
const { Notification, Trainer, TrainerDocument, User } = require("../../models");

const findTrainerByUserId = async ({ userId } = {}) =>
  Trainer.findOne({ userId });

const findTrainerByEmail = async ({ email } = {}) =>
  Trainer.findOne({ email });

const findTrainerForNdaBackfill = async ({ trainerId } = {}) =>
  Trainer.findById(trainerId).select(
    "ndaAgreementPdf ntaAgreementPdf NDAAgreementPdf documents.ndaAgreement documents.ntaAgreement documents.NDAAgreement",
  );

const listTrainerDocumentsByTrainerId = async ({ trainerId } = {}) =>
  TrainerDocument.find({ trainerId }).sort({ createdAt: -1 });

const upsertLegacyNdaDocument = async ({
  trainerId,
  documentTypeCandidates = [],
  setOnInsert = {},
} = {}) =>
  TrainerDocument.findOneAndUpdate(
    {
      trainerId,
      documentType: { $in: documentTypeCandidates },
    },
    {
      $set: {
        documentType: "ndaAgreement",
      },
      $setOnInsert: setOnInsert,
    },
    {
      upsert: true,
      new: true,
    },
  );

const findDocumentByIdWithTrainerUser = async ({ documentId } = {}) =>
  TrainerDocument.findById(documentId).populate({
    path: "trainerId",
    populate: { path: "userId" },
  });

const findTrainerById = async ({ trainerId } = {}) =>
  Trainer.findById(trainerId);

const findTrainerByIdWithUser = async ({ trainerId } = {}) =>
  Trainer.findById(trainerId).populate("userId");

const findUserByIdWithPlainPassword = async ({ userId } = {}) =>
  User.findById(userId).select("+plainPassword");

const findUserById = async ({ userId } = {}) =>
  User.findById(userId);

const findUsersByRole = async ({ role, select = null } = {}) => {
  const query = User.find({ role });
  return select ? query.select(select) : query;
};

const updateUserPasswordById = async ({
  userId,
  password,
  plainPassword,
} = {}) =>
  User.findByIdAndUpdate(userId, {
    password,
    plainPassword,
  });

const activateUserById = async ({ userId } = {}) =>
  User.findByIdAndUpdate(userId, {
    isActive: true,
    accountStatus: "active",
  });

const listTrainerDocumentsByTrainerIdExcluding = async ({
  trainerId,
  excludedDocumentId,
} = {}) =>
  TrainerDocument.find({
    trainerId,
    _id: { $ne: excludedDocumentId },
  });

const saveTrainerDocument = async ({ document } = {}) =>
  document.save();

const deleteTrainerDocumentRecord = async ({ document } = {}) =>
  document.deleteOne();

const saveTrainerRecord = async ({ trainer } = {}) =>
  trainer.save();

const updateUserProfilePictureById = async ({
  userId,
  profilePicture = null,
} = {}) =>
  User.findByIdAndUpdate(userId, {
    $set: { profilePicture },
  });

const resetUserForTrainerSubmission = async ({ userId } = {}) =>
  User.findByIdAndUpdate(userId, {
    $set: {
      accountStatus: "pending",
    },
    $unset: {
      password: 1,
      plainPassword: 1,
    },
  });

const findNdaDocumentsForTrainer = async ({
  trainerId,
  documentTypeCandidates = [],
  preserveDocumentId = null,
} = {}) => {
  const filter = {
    trainerId,
    documentType: { $in: documentTypeCandidates },
  };

  if (preserveDocumentId && mongoose.Types.ObjectId.isValid(preserveDocumentId)) {
    filter._id = { $ne: preserveDocumentId };
  }

  return TrainerDocument.find(filter);
};

const findTrainerDocumentByTypeCandidates = async ({
  trainerId,
  documentTypeCandidates = [],
} = {}) =>
  TrainerDocument.findOne({
    trainerId,
    documentType: { $in: documentTypeCandidates },
  });

const createTrainerDocument = async ({ payload } = {}) =>
  TrainerDocument.create(payload);

const createNotificationRecord = async ({ payload = {} } = {}) =>
  Notification.create(payload);

module.exports = {
  createTrainerDocument,
  createNotificationRecord,
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
  activateUserById,
  updateUserPasswordById,
  updateUserProfilePictureById,
  upsertLegacyNdaDocument,
};
