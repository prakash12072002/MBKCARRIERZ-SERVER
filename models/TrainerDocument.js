const mongoose = require("mongoose");

const trainerDocumentSchema = new mongoose.Schema(
  {
    trainerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Trainer",
      required: true,
    },
    documentType: {
      type: String,
      enum: [
        "profilePhoto",
        "aadharFront",
        "aadharBack",
        "pan",
        "passbook",
        "degreePdf",
        "resumePdf",
        "photo",
        "selfiePhoto",
        "passportPhoto",
        "ndaAgreement",
        "ntaAgreement",
        "NDAAgreement",
      ],
      required: true,
    },
    fileName: {
      type: String,
      required: true,
    },
    filePath: {
      type: String,
      required: true,
    },
    driveFileId: {
      type: String,
      default: null,
    },
    driveViewLink: {
      type: String,
      default: null,
    },
    driveDownloadLink: {
      type: String,
      default: null,
    },
    driveFolderId: {
      type: String,
      default: null,
    },
    driveFolderName: {
      type: String,
      default: null,
    },
    fileSize: {
      type: Number,
      default: null,
    },
    mimeType: {
      type: String,
      default: null,
    },
    verificationStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },
    verificationComment: {
      type: String,
      default: null,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    // Bank details stored with bank document
    accountNumber: {
      type: String,
      default: null,
    },
    bankName: {
      type: String,
      default: null,
    },
    ifscCode: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

const TrainerDocument = mongoose.model(
  "TrainerDocument",
  trainerDocumentSchema,
);

module.exports = TrainerDocument;
