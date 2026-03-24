const mongoose = require("mongoose");

const OtpSchema = new mongoose.Schema({
  email: { type: String, required: true },
  hashedOtp: { type: String, required: true },     // SHA-256 hash of OTP (never stored plain)
  purpose: { type: String, default: "company_admin_verify" },
  expiresAt: { type: Date, required: true },
  verified: { type: Boolean, default: false },
  used: { type: Boolean, default: false },          // Block reuse
  attempts: { type: Number, default: 0 },           // Failed verification attempts
  requestCount: { type: Number, default: 1 },       // OTP sends in current hour window
  hourWindowStart: { type: Date, default: Date.now }, // Start of rate-limit window
  ipAddress: { type: String, default: null },       // IP of requester
}, { timestamps: true });

// TTL Index: auto-delete once expiresAt is reached
OtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for fast lookups
OtpSchema.index({ email: 1, purpose: 1 });

module.exports = mongoose.model("Otp", OtpSchema);
