const mongoose = require("mongoose");

const companyArchiveSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    companyCode: {
      type: String,
      required: true,
      index: true,
      uppercase: true,
      trim: true,
    },
    name: {
      type: String,
      default: null,
    },
    phone: {
      type: String,
      default: null,
    },
    address: {
      type: String,
      default: null,
    },
    logo: {
      type: String,
      default: null,
    },
    adminEmail: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    // Legacy field retained for compatibility
    email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    changeType: {
      type: String,
      enum: ["CREATE", "UPDATE", "DELETE"],
      default: "UPDATE",
    },
    previousData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("CompanyArchive", companyArchiveSchema);
