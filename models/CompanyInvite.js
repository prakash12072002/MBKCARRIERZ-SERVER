const mongoose = require("mongoose");

const CompanyInviteSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },
    verifiedBySuperAdmin: { type: Boolean, default: false },
    used: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Auto-delete invite after expiry time
CompanyInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
CompanyInviteSchema.index({ email: 1, used: 1 });

module.exports = mongoose.model("CompanyInvite", CompanyInviteSchema);
