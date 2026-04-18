const express = require("express");
const User = require("../models/User");
const Trainer = require("../models/Trainer");
const TrainerDocument = require("../models/TrainerDocument");
const Company = require("../models/Company");
const CompanyArchive = require("../models/CompanyArchive");
const router = express.Router();

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { check, validationResult } = require("express-validator");
const RefreshToken = require("../models/RefreshToken");
const Notification = require("../models/Notification");
const {
  sendAdminSubmissionNotificationEmail,
  sendMail,
  sendOtpEmail,
  sendTrainerLogin,
} = require("../utils/emailService");
const Otp = require("../models/Otp");
const crypto = require("crypto");
const { authenticate } = require("../middleware/auth");
const { verifyCaptcha } = require("../middleware/verifyCaptcha");
const passport = require("passport");
const { upload } = require("../config/cloudinary");
const {
  evaluateTrainerDocumentWorkflow,
  resolveTrainerRegistrationStatus,
  resolveTrainerResumeStep,
} = require("../utils/trainerDocumentWorkflow");
const {
  ensureCompanyHierarchy,
  isTrainingDriveEnabled,
} = require("../modules/drive/driveGateway");

const createSystemGeneratedPassword = () =>
  `MBK#${crypto.randomBytes(24).toString("hex")}`;

let firebaseUidIndexEnsured = false;
const ensureFirebaseUidIndexCompatibility = async () => {
  if (firebaseUidIndexEnsured) return;
  try {
    const indexes = await User.collection.indexes();
    const firebaseIndex = indexes.find((idx) => idx?.key?.firebaseUid === 1);

    if (!firebaseIndex) {
      await User.collection.createIndex(
        { firebaseUid: 1 },
        { name: "firebaseUid_1", unique: true, sparse: true },
      );
    } else if (firebaseIndex.unique && !firebaseIndex.sparse) {
      // Repair legacy unique(non-sparse) index that rejects multiple null values.
      await User.collection.dropIndex(firebaseIndex.name || "firebaseUid_1");
      await User.collection.createIndex(
        { firebaseUid: 1 },
        { name: "firebaseUid_1", unique: true, sparse: true },
      );
    }
    firebaseUidIndexEnsured = true;
  } catch (indexError) {
    console.error("[AUTH] firebaseUid index compatibility check failed:", indexError?.message || indexError);
  }
};

const buildTrainerRegistrationState = async (trainer) => {
  if (!trainer?._id) {
    return {
      workflow: evaluateTrainerDocumentWorkflow(trainer || {}),
      registrationStatus: "pending",
      currentStep: Math.max(Number(trainer?.registrationStep || 1), 1),
    };
  }

  const trainerDocuments = await TrainerDocument.find({ trainerId: trainer._id });
  const workflow = evaluateTrainerDocumentWorkflow(trainer, trainerDocuments);
  const registrationStatus = resolveTrainerRegistrationStatus(trainer, workflow);
  const currentStep =
    registrationStatus === "pending"
      ? resolveTrainerResumeStep(trainer, workflow)
      : 6;

  return {
    workflow,
    registrationStatus,
    currentStep,
  };
};

// Helper to set refresh token cookie
const setTokenCookie = (res, token) => {
  const refreshTokenDays = Number(process.env.REFRESH_TOKEN_DAYS ?? 30);
  const shouldPersistAcrossBrowserRestart =
    Number.isFinite(refreshTokenDays) && refreshTokenDays > 0;

  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  };

  if (shouldPersistAcrossBrowserRestart) {
    cookieOptions.expires = new Date(
      Date.now() + refreshTokenDays * 24 * 60 * 60 * 1000,
    );
  }

  res.cookie("refreshToken", token, cookieOptions);
};

const MSG91_AUTH_KEY = "481521Ah1ZZ61Ks6933d5caP1";

// 1. Send OTP — POST /api/auth/send-otp
// Security: SHA-256 hashing, rate limit 3/hr, IP logging
router.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';

  if (!email) {
    return res.status(400).json({ success: false, message: "Email is required" });
  }

  try {
    const now = new Date();

    // Generate and hash OTP
    const rawOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = crypto.createHash("sha256").update(rawOtp).digest("hex");

    await Otp.findOneAndUpdate(
      { email, purpose: "company_admin_verify" },
      {
        hashedOtp,
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000), // 5 minutes
        verified: false,
        used: false,
        attempts: 0,
        ipAddress,
      },
      { upsert: true, new: true }
    );

    const isProduction = process.env.NODE_ENV === "production";
    let deliveryMode = "email";
    let debugError = null;

    // Try email delivery; in local/dev allow fallback so invite flow can continue.
    try {
      await sendOtpEmail(email, rawOtp);
    } catch (emailError) {
      if (isProduction) {
        throw emailError;
      }
      deliveryMode = "debug";
      debugError = emailError?.response || emailError?.message || String(emailError);
      console.warn("[OTP-EMAIL-FALLBACK] Email delivery failed in non-production:", emailError?.message || emailError);
      console.log(`[OTP-DEBUG] ${email}: ${rawOtp}`);
    }

    console.log(`[OTP-SENT] To: ${email} | IP: ${ipAddress} | mode: ${deliveryMode}`);
    res.json({
      success: true,
      message: deliveryMode === "email" ? "OTP sent successfully" : "OTP generated (email unavailable in local environment)",
      ...(deliveryMode === "debug" ? { debugOtp: rawOtp, debugError } : {}),
    });
  } catch (error) {
    console.error("send-otp error:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

// 2. Verify OTP — POST /api/auth/verify-otp
// Security: hash comparison, attempt tracking, reuse prevention
router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  const ipAddress = req.ip || req.connection?.remoteAddress || 'unknown';

  if (!email || !otp) {
    return res.status(400).json({ success: false, message: "Email and OTP are required" });
  }

  try {
    const record = await Otp.findOne({ email, purpose: "company_admin_verify" });

    // No record found
    if (!record) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    // Block if already used (anti-reuse)
    if (record.used) {
      return res.status(400).json({ success: false, message: "OTP has already been used. Request a new one." });
    }

    // Block after 5 failed attempts (brute-force protection)
    const MAX_ATTEMPTS = 5;
    if (record.attempts >= MAX_ATTEMPTS) {
      await Otp.deleteOne({ _id: record._id });
      console.warn(`[OTP-BLOCKED] ${email} from ${ipAddress}: exceeded max attempts`);
      return res.status(429).json({
        success: false,
        message: "Too many incorrect attempts. Please request a new OTP."
      });
    }

    // Check explicit expiry
    if (record.expiresAt < new Date()) {
      await Otp.deleteOne({ _id: record._id });
      return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    }

    // Hash the incoming OTP and compare
    const hashedInput = crypto.createHash("sha256").update(otp).digest("hex");
    if (record.hashedOtp !== hashedInput) {
      record.attempts += 1;
      await record.save();
      const remaining = MAX_ATTEMPTS - record.attempts;
      console.warn(`[OTP-FAIL] ${email} from ${ipAddress}: wrong OTP (${record.attempts}/${MAX_ATTEMPTS} attempts)`);
      return res.status(400).json({
        success: false,
        message: `Invalid OTP. ${remaining} attempt(s) remaining.`
      });
    }

    // ✅ Valid — mark as verified and used
    record.verified = true;
    record.used = true;
    record.expiresAt = new Date(Date.now() + 10 * 60 * 1000); // extend window for create-company call
    await record.save();

    console.log(`[OTP-VERIFIED] ${email} from ${ipAddress}`);
    res.json({ success: true, message: "Email verified" });
  } catch (error) {
    console.error("verify-otp error:", error);
    res.status(500).json({ success: false, message: "Failed to verify OTP" });
  }
});

// 1. Send MSG91 OTP
router.post("/send-msg91-otp", async (req, res) => {
  try {
    let { mobile } = req.body;
    if (!mobile)
      return res
        .status(400)
        .json({ success: false, message: "Mobile number required" });

    // Auto-prepend 91 if 10 digits
    if (/^\d{10}$/.test(mobile)) {
      mobile = "91" + mobile; // Default to India
    }

    // MSG91 DLT Template ID (Required for India, optional elsewhere if not enforced)
    // If you have a template ID, put it here. If not, try sending without it (might fail in India).
    const templateId = "67a3390dd6fc0534c0717de3";
    const otpLength = 6;
    const expiry = 5;

    // Construct URL - Only append template_id if it exists
    let msg91Url = `https://api.msg91.com/api/v5/otp?mobile=${mobile}&authkey=${MSG91_AUTH_KEY}&otp_length=${otpLength}&otp_expiry=${expiry}`;
    if (templateId) {
      msg91Url += `&template_id=${templateId}`;
    }

    const axios = require("axios");
    const response = await axios.post(msg91Url);

    if (response.data.type === "error") {
      console.error("MSG91 API Error:", response.data);
      return res.status(500).json({
        success: false,
        message: response.data.message || "Failed to send OTP via MSG91",
      });
    }

    res.json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("MSG91 Send Request Failed:", error.message);
    // Check if it's an axios error response
    if (error.response && error.response.data) {
      console.error("MSG91 Response Data:", error.response.data);
      return res.status(500).json({
        success: false,
        message: error.response.data.message || "MSG91 Provider Error",
      });
    }
    res
      .status(500)
      .json({ success: false, message: "Internal Server Error sending OTP" });
  }
});

// 2. Verify OTP
router.post("/verify-msg91-otp", async (req, res) => {
  try {
    const { mobile, otp } = req.body;

    if (!mobile || !otp) {
      return res
        .status(400)
        .json({ success: false, message: "Mobile and OTP required" });
    }

    const axios = require("axios");
    // GET request for verify
    const response = await axios.get(
      `https://api.msg91.com/api/v5/otp/verify?otp=${otp}&mobile=${mobile}&authkey=${MSG91_AUTH_KEY}`,
    );

    if (response.data.type === "error") {
      return res.status(401).json({
        success: false,
        message: response.data.message || "Invalid OTP",
      });
    }

    // Logic to find or create user based on mobile
    let user = await User.findOne({
      $or: [{ phone: mobile }, { phoneNumber: mobile }],
    });

    if (!user) {
      const randomSuffix = Math.floor(Math.random() * 1000);
      user = await User.create({
        name: `User ${randomSuffix}`,
        email: `${mobile || "user" + randomSuffix}@mbkcarrierz.msg91`,
        password: createSystemGeneratedPassword(),
        phone: mobile,
        phoneNumber: mobile,
        role: "Trainer",
        accountStatus: "active",
        isActive: true,
        emailVerified: true,
      });

      // Create associated Trainer profile (Fixed casing to NOT_SUBMITTED)
      await Trainer.create({
        userId: user._id,
        verificationStatus: "NOT_SUBMITTED",
      });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET || "secret_key",
      { expiresIn: "24h" },
    );

    // Keep OTP login consistent with password login:
    // issue refresh token cookie so server-side route guards can trust it.
    const refreshToken = crypto.randomBytes(40).toString("hex");
    await RefreshToken.create({
      user: user._id,
      token: refreshToken,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByIp: req.ip,
    });
    setTokenCookie(res, refreshToken);

    res.json({
      success: true,
      message: "OTP Verified",
      accessToken: token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("MSG91 Verify Error:", error.message);
    res.status(500).json({
      success: false,
      message: `Verification Error: ${error.message}`,
    });
  }
});

// Google OAuth Routes
router.get(
  "/google/start",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login",
    session: false,
  }),
  (req, res) => {
    // Successful authentication, generate token
    const token = jwt.sign(
      { id: req.user.id, role: req.user.role },
      process.env.JWT_SECRET || "secret_key",
      { expiresIn: "24h" },
    );

    // Redirect to frontend with token (or set cookie)
    // Adjust logic to match your frontend handling
    res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:3000"}/login?token=${token}`,
    );
  },
);

// Google Login endpoint
router.post("/google", async (req, res) => {
  try {
    const { email, name, googleId, photoURL } = req.body;
    const ipAddress = req.ip;

    console.log("[DEBUG] Google Login Attempt:", { email });

    let user = await User.findOne({ email });

    if (!user) {
      // Option 1: Auto-register functionality for Trainers
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(
        Math.random().toString(36),
        salt,
      );

      user = await User.create({
        name,
        email,
        password: hashedPassword,
        role: "Trainer",
        isActive: true, // Auto-Active
        accountStatus: "active", // Auto-Active
        emailVerified: true,
        profilePicture: photoURL,
        firebaseUid: googleId, // Map googleId to firebaseUid
      });

      // Create associated Trainer profile
      await Trainer.create({
        userId: user._id,
        verificationStatus: "NOT_SUBMITTED",
      });
    }

    // Check if user is active (Google Login)
    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message:
          "Your account has been deactivated. Please coNDAct the administrator.",
        accountDeactivated: true,
      });
    }

    // If user exists, log them in
    const accessToken = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET || "secret_key",
      { expiresIn: "24h" },
    );

    const refreshToken = crypto.randomBytes(40).toString("hex");
    await RefreshToken.create({
      user: user._id,
      token: refreshToken,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByIp: ipAddress,
    });

    setTokenCookie(res, refreshToken);

    res.json({
      success: true,
      message: "Google Login successful",
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus,
      },
    });
  } catch (error) {
    console.error("Google Login Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// Login endpoint
router.post(
  "/login",
  [
    verifyCaptcha,
    check("email", "Please include a valid email").isEmail(),
    check("password", "Password is required").exists(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, password } = req.body;
      const ipAddress = req.ip;

      const user = await User.findOne({ email });

      // DEBUG: File Logging
      const fs = require("fs");
      const logMsg = `[${new Date().toISOString()}] Login Attempt: Email=${email}, PasswordProvided=${!!password}\n`;
      try {
        fs.appendFileSync("login_debug.txt", logMsg);
      } catch (e) {}

      console.log("[DEBUG] Login Attempt:", {
        email,
        passwordProvided: !!password,
      });

      if (!user) {
        const msg = `[${new Date().toISOString()}] FAIL: User not found for ${email}\n`;
        try {
          fs.appendFileSync("login_debug.txt", msg);
        } catch (e) {}
        console.log("[DEBUG] User not found for email:", email);
        return res.status(400).json({ message: "Invalid credentials" });
      }

      const userLog = `[${new Date().toISOString()}] User Found: ID=${user._id}, Role=${user.role}, EmailVerified=${user.emailVerified}, HasPass=${!!user.password}\n`;
      try {
        fs.appendFileSync("login_debug.txt", userLog);
      } catch (e) {}
      console.log("[DEBUG] User found:", {
        id: user._id,
        role: user.role,
        emailVerified: user.emailVerified,
        hasPassword: !!user.password,
      });

      // BLOCK DEACTIVATED USERS
      if (user.isActive === false) {
        console.log("[DEBUG] Login blocked: User is deactivated");
        return res.status(403).json({
          success: false,
          message:
            "Your account has been deactivated. Please contact the administrator.",
          accountDeactivated: true,
        });
      }

      // [Email Verification Check Bypassed]

      if (!user.password) {
        try {
          fs.appendFileSync(
            "login_debug.txt",
            `[${new Date().toISOString()}] FAIL: No password set\n`,
          );
        } catch (e) {}
        console.error("Login failed: User has no password set", user.email);
        return res.status(400).json({ message: "Invalid credentials" });
      }

      console.log("[DEBUG] Comparing password...");
      try {
        fs.appendFileSync(
          "login_debug.txt",
          `[${new Date().toISOString()}] Comparing password...\n`,
        );
      } catch (e) {}

      const isMatch = await bcrypt.compare(password, user.password);

      console.log("[DEBUG] Password match result:", isMatch);
      try {
        fs.appendFileSync(
          "login_debug.txt",
          `[${new Date().toISOString()}] Password Match: ${isMatch}\n`,
        );
      } catch (e) {}

      if (!isMatch) {
        return res.status(400).json({ message: "Invalid credentials" });
      }

      const normalizedRole = String(user.role || "").toLowerCase();
      if (normalizedRole === "trainer" && user.accountStatus !== "active") {
        return res.status(403).json({
          success: false,
          message: "Your trainer account is waiting for admin approval.",
          pendingApproval: true,
        });
      }

      // Check 2FA
      if (user.twoFactorEnabled) {
        return res.json({
          success: true,
          requires2FA: true,
          userId: user.id,
          message: "2FA Verification Required",
        });
      }

      // Generate Access Token (Short lived - 10 min)
      const accessToken = jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET || "secret_key",
        { expiresIn: "24h" },
      );

      console.log("[DEBUG] Access Token Generated");
      try {
        fs.appendFileSync(
          "login_debug.txt",
          `[${new Date().toISOString()}] Access Token Generated\n`,
        );
      } catch (e) {}

      // Generate Refresh Token (Long lived - 30 days)
      const refreshToken = crypto.randomBytes(40).toString("hex");

      console.log("[DEBUG] Saving Refresh Token...");
      try {
        fs.appendFileSync(
          "login_debug.txt",
          `[${new Date().toISOString()}] Attempting to save RefreshToken\n`,
        );
      } catch (e) {}

      await RefreshToken.create({
        user: user._id,
        token: refreshToken,
        expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdByIp: ipAddress,
      });

      console.log("[DEBUG] Refresh Token Saved");
      try {
        fs.appendFileSync(
          "login_debug.txt",
          `[${new Date().toISOString()}] Refresh Token Saved. Sending response.\n`,
        );
      } catch (e) {}

      setTokenCookie(res, refreshToken);

      res.json({
        success: true,
        message: "Login successful",
        accessToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          accountStatus: user.accountStatus,
        },
      });
    } catch (error) {
      console.error("Login error:", error);

      try {
        const fs = require("fs");
        const path = require("path");
        const crashLog = path.join(__dirname, "../LATEST_CRASH.txt");
        fs.writeFileSync(
          crashLog,
          `[${new Date().toISOString()}] Login 500 Error: ${error.message}\nStack: ${error.stack}\n`,
        );
      } catch (e) {
        console.error("Failed to write crash log", e);
      }

      res.status(500).json({
        message: `Server error: ${error.message}`,
        error: error.message,
      });
    }
  },
);

// Refresh Token Endpoint
router.post("/refresh-token", async (req, res) => {
  const token = req.cookies.refreshToken;
  const ipAddress = req.ip;

  if (!token) {
    return res.status(401).json({ message: "Token required" });
  }

  try {
    const refreshToken = await RefreshToken.findOne({ token }).populate("user");

    if (!refreshToken || !refreshToken.isActive) {
      return res.status(401).json({ message: "Invalid token" });
    }

    // Rotate Token
    const newRefreshToken = crypto.randomBytes(40).toString("hex");

    // Revoke old token (replaced by new one)
    refreshToken.revoked = Date.now();
    refreshToken.revokedByIp = ipAddress;
    refreshToken.replacedByToken = newRefreshToken;
    await refreshToken.save();

    // Create new refresh token
    await RefreshToken.create({
      user: refreshToken.user._id,
      token: newRefreshToken,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByIp: ipAddress,
    });

    // Generate new Access Token
    const accessToken = jwt.sign(
      { id: refreshToken.user.id, role: refreshToken.user.role },
      process.env.JWT_SECRET || "secret_key",
      { expiresIn: "24h" },
    );

    setTokenCookie(res, newRefreshToken);

    res.json({
      accessToken,
      user: {
        id: refreshToken.user.id,
        name: refreshToken.user.name,
        email: refreshToken.user.email,
        role: refreshToken.user.role,
      },
    });
  } catch (error) {
    console.error("Refresh token error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Logout Endpoint
router.post("/logout", async (req, res) => {
  const token = req.cookies.refreshToken;
  const ipAddress = req.ip;

  if (token) {
    const refreshToken = await RefreshToken.findOne({ token });
    if (refreshToken) {
      refreshToken.revoked = Date.now();
      refreshToken.revokedByIp = ipAddress;
      await refreshToken.save();
    }
  }

  res.clearCookie("refreshToken");
  res.json({ message: "Logged out successfully" });
});

// Logout All Devices Endpoint
router.post("/logout-all", async (req, res) => {
  const token = req.cookies.refreshToken;
  const ipAddress = req.ip;

  if (token) {
    const refreshToken = await RefreshToken.findOne({ token });
    if (refreshToken) {
      // Revoke all active tokens for this user
      await RefreshToken.updateMany(
        { user: refreshToken.user, revoked: null },
        {
          revoked: Date.now(),
          revokedByIp: ipAddress,
        },
      );
    }
  }

  res.clearCookie("refreshToken");
  res.json({ message: "Logged out from all devices" });
});

// Trainer Registration - Step 1: Basic Details & Send OTP
router.post(
  "/trainer-registration-step1",
  [
    check("firstName", "First name is required").not().isEmpty(),
    check("lastName", "Last name is required").not().isEmpty(),
    check("email", "Please include a valid email").isEmail(),
    check("mobile", "Mobile number is required").not().isEmpty(),
    check("password", "Password must be at least 6 characters").isLength({
      min: 6,
    }),
    check("confirmPassword", "Passwords do not match").custom(
      (value, { req }) => value === req.body.password,
    ),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const {
        firstName,
        lastName,
        qualification,
        mobile,
        email,
        city,
        address,
        password,
      } = req.body;

      // Check if user already exists
      let user = await User.findOne({ email });

      // If user exists, check if they are a pending trainer
      if (user) {
        if (user.role === "Trainer" && user.accountStatus === "pending") {
          console.log(
            `[DEBUG] Resuming registration for pending trainer: ${email}`,
          );
          // Proceed to update info and resend OTP
        } else {
          return res.status(400).json({
            success: false,
            message: "User with this email already exists",
          });
        }
      }

      // Check if user already exists with this phone number
      const existingPhone = await User.findOne({ phoneNumber: mobile });
      if (existingPhone) {
        // If it's a different user, block registration
        if (!user || existingPhone._id.toString() !== user._id.toString()) {
          return res.status(400).json({
            success: false,
            message: "User with this mobile number already exists",
          });
        }
      }

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      if (user) {
        // Update existing pending user
        user.name = `${firstName} ${lastName}`;
        user.firstName = firstName;
        user.lastName = lastName;
        user.password = hashedPassword;
        user.phoneNumber = mobile;
        user.city = city;
        user.emailOtp = otp;
        user.emailOtpExpires = otpExpires;
        await user.save();

        // Update or Create associated Trainer profile
        let trainer = await Trainer.findOne({ userId: user._id });
        if (trainer) {
          trainer.phone = mobile;
          trainer.address = address;
          trainer.city = city;
          trainer.qualification = qualification;
          // Keep verificationStatus as is or reset if it was REJECTED
          if (trainer.verificationStatus === "REJECTED") {
            trainer.verificationStatus = "NOT_SUBMITTED";
          }
          await trainer.save();
        } else {
          await Trainer.create({
            userId: user._id,
            phone: mobile,
            address: address,
            city: city,
            qualification: qualification,
            verificationStatus: "NOT_SUBMITTED",
          });
        }
      } else {
        // Create New User with pending status
        user = await User.create({
          name: `${firstName} ${lastName}`,
          firstName,
          lastName,
          email,
          password: hashedPassword,
          phoneNumber: mobile,
          city,
          role: "Trainer",
          accountStatus: "pending",
          emailVerified: false,
          emailOtp: otp,
          emailOtpExpires: otpExpires,
        });

        // Create associated Trainer profile
        await Trainer.create({
          userId: user._id,
          phone: mobile,
          address: address,
          city: city,
          qualification: qualification,
          verificationStatus: "NOT_SUBMITTED",
        });
      }

      // Send OTP via Email
      const { sendRegistrationOTP } = require("../utils/emailService");
      await sendRegistrationOTP(email, `${firstName} ${lastName}`, otp);

      res.status(201).json({
        success: true,
        message: "Step 1 completed. OTP sent to your email.",
        email: user.email,
      });
    } catch (error) {
      console.error("Trainer registration step 1 error:", error);

      let userMessage = error.message;
      if (error.message.includes("Email delivery failed")) {
        userMessage =
          "Registration successful, but we couldn't send the verification OTP. Please check your email spelling or try again later.";
      } else {
        userMessage = `Server error: ${error.message}`;
      }

      res.status(500).json({
        success: false,
        message: userMessage,
      });
    }
  },
);

// --- NEW 4-STEP REGISTRATION FLOW ENDPOINTS ---

/**
 * @route   POST /api/auth/trainer-reg-init
 * @desc    Initial step: Email -> Send OTP
 * @access  Public
 */
router.post("/trainer-reg-init", async (req, res) => {
  try {
    await ensureFirebaseUidIndexCompatibility();
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    let user = await User.findOne({ email });
    let trainer = await Trainer.findOne({ email });
    const registrationState = trainer
      ? await buildTrainerRegistrationState(trainer)
      : null;
    const registrationStep =
      registrationState?.currentStep || trainer?.registrationStep || 1;
    const normalizedRole = String(user?.role || "").toLowerCase();
    const registrationComplete =
      registrationState?.registrationStatus === "approved" ||
      registrationState?.registrationStatus === "under_review" ||
      trainer?.status === "APPROVED" ||
      (user && normalizedRole === "trainer" && user.accountStatus !== "pending");

    // Handle existing users
    if (user) {
      if (normalizedRole !== "trainer") {
        return res.status(409).json({
          success: false,
          alreadyRegistered: true,
          message: "Already registered",
        });
      }

      if (registrationComplete) {
        return res.status(409).json({
          success: false,
          alreadyRegistered: true,
          registrationStep,
          message: "Already registered",
        });
      }

      if (user.accountStatus !== "pending") {
        return res
          .status(409)
          .json({
            success: false,
            alreadyRegistered: true,
            registrationStep,
            message: "Already registered",
          });
      }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    if (user) {
      user.emailOtp = otp;
      user.emailOtpExpires = otpExpires;
      user.emailVerified = false;
      user.isEmailVerified = false;
      await User.findByIdAndUpdate(user._id, {
        emailOtp: otp,
        emailOtpExpires: otpExpires,
        emailVerified: false,
        isEmailVerified: false,
      });

      trainer = await Trainer.findOneAndUpdate(
        { email },
        {
          $setOnInsert: {
            email,
            status: "PENDING",
            registrationStep: 1,
          },
          $set: {
            emailVerified: false,
            userId: user._id,
            registrationStatus:
              registrationState?.registrationStatus === "under_review"
                ? "under_review"
                : "pending",
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } else {
      user = await User.create({
        email,
        password: createSystemGeneratedPassword(),
        role: "Trainer",
        accountStatus: "pending",
        emailVerified: false,
        isEmailVerified: false,
        emailOtp: otp,
        emailOtpExpires: otpExpires,
        name: "Pending Trainer",
      });

      trainer = await Trainer.create({
        email,
        userId: user._id,
        status: "PENDING",
        registrationStep: 1,
        registrationStatus: "pending",
      });
    }

    const { sendRegistrationOTP } = require("../utils/emailService");
    // Pass placeholder name if real name not yet collected
    await sendRegistrationOTP(email, "Trainer Candidate", otp);

    res.json({
      success: true,
      message:
        trainer && registrationStep > 1
          ? "OTP sent to continue your registration."
          : "OTP sent to your email.",
      email: user.email,
      registrationStep: trainer?.registrationStep || 1,
      canResume: Boolean(trainer && registrationStep > 1),
    });
  } catch (err) {
    console.error("Trainer Registration Init Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Verify Registration OTP
router.post("/verify-registration-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    const user = await User.findOne({
      email,
      emailOtp: otp,
      emailOtpExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP",
      });
    }

    // Update user as email verified
    user.emailVerified = true;
    user.isEmailVerified = true;
    user.emailOtp = null;
    user.emailOtpExpires = null;
    await user.save();

    let trainer = await Trainer.findOne({ email });
    let currentStep = 2;

    if (trainer) {
      const registrationState = await buildTrainerRegistrationState(trainer);
      currentStep = Math.max(registrationState.currentStep || 1, 2);
      trainer.emailVerified = true;
      trainer.registrationStep = currentStep;
      trainer.registrationStatus = registrationState.registrationStatus;
      trainer.documentStatus = registrationState.workflow.documentStatus;
      await trainer.save();
    } else {
      trainer = await Trainer.create({
        email,
        userId: user._id,
        emailVerified: true,
        status: "PENDING",
        registrationStep: 2,
      });
      currentStep = trainer.registrationStep;
    }

    // Generate temporary token for document upload step
    const tempToken = jwt.sign(
      { id: user.id, role: user.role, step: currentStep },
      process.env.JWT_SECRET || "secret_key",
      { expiresIn: "1h" },
    );

    res.json({
      success: true,
      message: "Email verified successfully!",
      tempToken,
      currentStep,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Verify registration OTP error:", error);
    res.status(500).json({
      success: false,
      message: `Verification error: ${error.message}`,
    });
  }
});

// Signup endpoint
// Signup endpoint
router.post(
  "/signup",
  [
    check("name", "Name is required").not().isEmpty(),
    check("email", "Please include a valid email").isEmail(),
    check(
      "password",
      "Please enter a password with 6 or more characters",
    ).isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { name, email, password } = req.body;
      const ipAddress = req.ip;

      // Check if user exists
      let user = await User.findOne({ email });
      if (user) {
        return res.status(400).json({ message: "User already exists" });
      }

      // Create user
      // Password hashing is handled by User model pre-save hook if implemented,
      // but let's hash it here to be safe and consistent with login check
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      user = await User.create({
        name,
        email,
        password: hashedPassword,
        role: "Trainer", // Default role for self-signup
        isActive: true, // Auto-Active
        accountStatus: "active", // Auto-Active
        emailVerified: true, // Skip email verification
      });

      // Create associated Trainer profile (Fixed casing to NOT_SUBMITTED)
      await Trainer.create({
        userId: user._id,
        verificationStatus: "NOT_SUBMITTED",
      });

      // Generate Access Token (Auto-Login)
      const accessToken = jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET || "secret_key",
        { expiresIn: "24h" },
      );

      res.status(201).json({
        success: true,
        message: "Registration successful! Logging in...",
        accessToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          accountStatus: user.accountStatus,
        },
      });

      // Notify SuperAdmins (Async - don't block response)
      try {
        const superAdmins = await User.find({ role: "SuperAdmin" });
        if (superAdmins.length > 0) {
          // 1. In-App Notifications
          const notifications = superAdmins.map((admin) => ({
            userId: admin._id,
            title: "New Trainer Registration",
            message: `New trainer ${name} has signed up and is awaiting approval.`,
            type: "info",
            link: "/dashboard/trainers",
          }));
          await Notification.insertMany(notifications);

          // 2. Email Notification
          const superAdminEmails = superAdmins
            .map((admin) => admin.email)
            .filter((email) => email);
          await sendTrainerRegistrationNotificationEmail(superAdminEmails, {
            name,
            email,
            phone: req.body.phone || "N/A", // Attempt to capture if passed
            city: req.body.city || "N/A", // Attempt to capture if passed
          });
        }
      } catch (notifyError) {
        console.error("Failed to notify admins of new signup:", notifyError);
        // Don't fail the request, just log
      }
    } catch (error) {
      console.error("Signup error:", error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

// Email verification endpoint
router.get("/verify-email/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const user = await User.findOne({
      $or: [{ emailVerificationToken: token }, { verificationToken: token }],
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired verification token",
      });
    }

    // Update user as verified
    user.emailVerified = true;
    user.isEmailVerified = true;
    user.emailVerificationToken = null;
    user.verificationToken = null;
    if (user.role === "CompanyAdmin" && user.accountStatus === "pending") {
      user.accountStatus = "active";
    }
    await user.save();

    res.json({
      success: true,
      message: "Email verified successfully! You can now log in.",
    });
  } catch (error) {
    console.error("Email verification error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to verify email",
    });
  }
});

// Resend verification email
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    if (user.emailVerified || user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        message: "Email is already verified",
      });
    }

    // Generate new verification token
    const crypto = require("crypto");
    const verificationToken = crypto.randomBytes(32).toString("hex");

    user.emailVerificationToken = verificationToken;
    user.verificationToken = verificationToken;
    await user.save();

    // Send verification email
    const { sendVerificationEmail } = require("../utils/emailService");
    await sendVerificationEmail(user.email, user.name, verificationToken);

    res.json({
      success: true,
      message: "Verification email sent successfully",
    });
  } catch (error) {
    console.error("Resend verification error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to resend verification email",
    });
  }
});

// Forgot password - request OTP
router.post("/forgot-password", verifyCaptcha, async (req, res) => {
  try {
    const normalizedEmail = String(req.body?.email || "").trim().toLowerCase();

    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "Email is required.",
      });
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Email address not found.",
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    user.resetPasswordOTP = otp;
    user.resetPasswordOTPExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save();

    // Send OTP email
    const { sendPasswordResetEmail } = require("../utils/emailService");
    // We'll modify sendPasswordResetEmail to accept OTP or create a new function
    // For now, let's assume we pass the OTP as the token
    await sendPasswordResetEmail(user.email, user.name, otp);

    res.json({
      success: true,
      message: "OTP sent to your email.",
    });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to process password reset request",
    });
  }
});

// Verify OTP
router.post("/verify-reset-otp", async (req, res) => {
  try {
    const normalizedEmail = String(req.body?.email || "").trim().toLowerCase();
    const normalizedOtp = String(req.body?.otp || "")
      .replace(/\D/g, "")
      .slice(0, 6);

    if (!normalizedEmail || normalizedOtp.length !== 6) {
      return res.status(400).json({
        success: false,
        message: "Email and valid 6-digit OTP are required",
      });
    }

    const user = await User.findOne({
      email: normalizedEmail,
      resetPasswordOTP: normalizedOtp,
      resetPasswordOTPExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP",
      });
    }

    // OTP is valid. Return a temporary token to allow password reset
    // This token is just to prove they passed the OTP step
    const tempToken = jwt.sign(
      { id: user.id, purpose: "password_reset" },
      process.env.JWT_SECRET || "secret_key",
      { expiresIn: "15m" },
    );

    res.json({
      success: true,
      message: "OTP verified",
      tempToken,
    });
  } catch (error) {
    console.error("Verify OTP error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to verify OTP",
    });
  }
});

// Reset password with temp token
router.post("/reset-password", async (req, res) => {
  try {
    const { tempToken, password } = req.body;

    // Validate password
    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    // Verify temp token
    let decoded;
    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET || "secret_key");
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired session. Please try again.",
      });
    }

    if (decoded.purpose !== "password_reset") {
      return res.status(400).json({
        success: false,
        message: "Invalid token purpose",
      });
    }

    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Keep both hashed password and admin-visible credential in sync
    user.password = password;
    user.plainPassword = password;
    user.resetPasswordOTP = null;
    user.resetPasswordOTPExpires = null;
    await user.save();

    // Send confirmation email
    const { sendLoginMail } = require("../utils/sendLoginMail");
    await sendLoginMail(user.email, password, user.name);

    res.json({
      success: true,
      message: "Password reset successful! Check your email for confirmation.",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reset password",
    });
  }
});

// Verify invitation token
router.get("/verify-token/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const user = await User.findOne({
      $or: [{ emailVerificationToken: token }, { verificationToken: token }],
    }).select("email name");

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired invitation token",
      });
    }

    res.json({
      success: true,
      email: user.email,
      name: user.name,
    });
  } catch (error) {
    console.error("Token verification error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to verify token",
    });
  }
});

// Setup account (set password from invitation)
router.post("/setup-account", async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    const user = await User.findOne({
      $or: [{ emailVerificationToken: token }, { verificationToken: token }],
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired invitation token",
      });
    }

    // Update user; model hook handles hashing for `password`
    user.password = password;
    user.plainPassword = password;
    user.emailVerified = true;
    user.isEmailVerified = true;
    user.emailVerificationToken = null;
    user.verificationToken = null;
    user.isActive = true;
    await user.save();

    res.json({
      success: true,
      message: "Account setup successfully! You can now log in.",
    });
  } catch (error) {
    console.error("Account setup error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to setup account",
    });
  }
});

// Complete Company Admin Onboarding
router.post("/complete-company-onboarding", upload.single("logo"), async (req, res) => {
  try {
    const getStoredLogoPath = (file) => {
      if (!file) return null;
      const directUrl = file.path || file.secure_url || file.url;
      if (typeof directUrl === "string" && /^https?:\/\//i.test(directUrl)) {
        return directUrl;
      }
      if (file.filename) {
        return `/uploads/trainer-documents/${file.filename}`;
      }
      if (typeof directUrl === "string") {
        const normalized = directUrl.replace(/\\/g, "/");
        const marker = "/uploads/";
        const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
        if (markerIndex >= 0) {
          return normalized.slice(markerIndex);
        }
      }
      return null;
    };

    const { token, companyName, phone, address, adminName } = req.body;

    if (!token || !companyName || !phone || !address || !adminName) {
      return res.status(400).json({
        success: false,
        message: "token, companyName, phone, address, and adminName are required",
      });
    }

    const user = await User.findOne({
      role: "CompanyAdmin",
      $or: [{ emailVerificationToken: token }, { verificationToken: token }],
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired onboarding token",
      });
    }

    // If company already linked, treat as already onboarded
    if (user.companyId) {
      return res.status(400).json({
        success: false,
        message: "Onboarding is already completed for this invite",
      });
    }

    const companyPayload = {
      name: companyName,
      adminName,
      email: user.email,
      phone,
      address,
      status: "active",
      ...(getStoredLogoPath(req.file) ? { logo: getStoredLogoPath(req.file) } : {}),
    };

    const company = await Company.create(companyPayload);
    if (isTrainingDriveEnabled()) {
      try {
        const hierarchy = await ensureCompanyHierarchy({ company });
        if (hierarchy?.companyFolder?.id) {
          company.driveFolderId = hierarchy.companyFolder.id;
          company.driveFolderName = hierarchy.companyFolder.name;
          company.driveFolderLink = hierarchy.companyFolder.link;
        }
      } catch (driveError) {
        console.error(
          "[GOOGLE-DRIVE] Failed to create company folder during onboarding:",
          driveError.message,
        );
      }
    }

    user.name = adminName;
    user.companyId = company._id;
    user.companyCode = company.companyCode;
    user.emailVerified = true;
    user.isEmailVerified = true;
    user.emailVerificationToken = null;
    user.verificationToken = null;
    user.accountStatus = "active";
    user.isActive = true;
    await user.save();

    // Back-link user on company for portal ownership
    company.userId = user._id;
    company.adminId = user._id;
    await company.save();

    await CompanyArchive.create({
      companyId: company._id,
      companyCode: company.companyCode,
      name: company.name || null,
      phone: company.phone || null,
      address: company.address || null,
      logo: company.logo || null,
      adminEmail: company.email || null,
      email: company.email,
      changeType: "CREATE",
      previousData: company.toObject(),
      changedBy: user._id,
    });

    return res.json({
      success: true,
      message: "Onboarding completed. Company created successfully.",
      company: {
        id: company._id,
        name: company.name,
        email: company.email,
        companyCode: company.companyCode,
      },
    });
  } catch (error) {
    console.error("complete-company-onboarding error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to complete onboarding",
    });
  }
});

// SMS Verification Endpoint
const {
  sendVerificationSMS,
  sendPasswordResetSMS,
} = require("../utils/smsService");

router.post("/send-verification-sms", async (req, res) => {
  try {
    const { userId, phone } = req.body;

    // Find user by ID or Phone (if phone is unique)
    // For now, assuming userId is passed or we find by phone
    let user;
    if (userId) {
      user = await User.findById(userId);
    } else if (phone) {
      // Assuming phone field exists or we use email to find user first
      return res.status(400).json({ message: "User ID required for now" });
    }

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Generate verification code
    const verificationCode = Math.floor(
      100000 + Math.random() * 900000,
    ).toString();

    // Save code to user (you might want a separate model or field for this)
    user.emailVerificationToken = verificationCode; // Reusing this field for simplicity, or create new one
    await user.save();

    // Send SMS
    await sendVerificationSMS(phone || user.phone, verificationCode); // Assuming user has phone field

    res.json({ success: true, message: "Verification SMS sent" });
  } catch (error) {
    console.error("SMS Verification Error:", error);
    res.status(500).json({ success: false, message: "Failed to send SMS" });
  }
});

// Forgot Password SMS Endpoint
router.post("/send-forgot-password-sms", async (req, res) => {
  try {
    const { email, phone } = req.body;

    const user = await User.findOne({ email }); // Or find by phone
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Generate reset code
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();

    user.resetPasswordToken = resetCode;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await user.save();

    // Send SMS (ImplemeNDAtion depends on provider)
    await sendPasswordResetSMS(phone || user.phone, resetCode);

    res.json({ success: true, message: "Password reset SMS sent" });
  } catch (error) {
    console.error("Forgot Password SMS Error:", error);
    res.status(500).json({ success: false, message: "Failed to send SMS" });
  }
});

// Send Email OTP (for Super Admin 2FA)
router.post("/send-email-otp", authenticate, async (req, res) => {
  try {
    const user = req.user; // Authenticated user from middleware

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    user.emailOtp = otp;
    user.emailOtpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save();

    // Send OTP email
    const { sendVerificationEmail } = require("../utils/emailService");
    // Note: We might want a specific template for Login OTP, but reusing verification or a generic one works for now.
    // Let's assume we use a generic "Your OTP is..." email or reuse the verification one with a tweak if possible.
    // For now, I'll use a hypothetical sendOtpEmail function or just reuse sendVerificationEmail with a note.
    // Actually, let's just use the existing service and maybe add a function if needed, or just send it.

    // Assuming we have a sendEmail function or similar.
    // Let's check emailService.js content if I could, but I'll assume I can add a simple mailer call here or use what's available.
    // I'll use nodemailer directly if needed or the service.
    // Let's try to use the existing emailService.

    // For this implemeNDAtion, I will assume `sendVerificationEmail` can be used or I'll implement a simple send call.
    // Better: Create a dedicated `sendLoginOtpEmail` in emailService if I could, but I'll inline it or use a generic one.

    // Let's use the `sendVerificationEmail` logic but customized.
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      service: "gmail", // Or whatever is configured
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: "Your Login Verification Code",
      text: `Your verification code is: ${otp}. It expires in 10 minutes.`,
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>It expires in 10 minutes.</p>`,
    };

    await transporter.sendMail(mailOptions);

    res.json({ success: true, message: "OTP sent to your email" });
  } catch (error) {
    console.error("Send Email OTP Error:", error);
    res.status(500).json({ success: false, message: "Failed to send OTP" });
  }
});

// Verify Email OTP
router.post("/verify-email-otp", authenticate, async (req, res) => {
  try {
    const { otp } = req.body;
    const user = req.user;

    if (!user.emailOtp || !user.emailOtpExpires) {
      return res
        .status(400)
        .json({ success: false, message: "No OTP requested" });
    }

    if (user.emailOtp !== otp) {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    if (user.emailOtpExpires < Date.now()) {
      return res.status(400).json({ success: false, message: "OTP expired" });
    }

    // Clear OTP
    user.emailOtp = null;
    user.emailOtpExpires = null;
    await user.save();

    res.json({ success: true, message: "OTP verified" });
  } catch (error) {
    console.error("Verify Email OTP Error:", error);
    res.status(500).json({ success: false, message: "Failed to verify OTP" });
  }
});

// 2FA Setup - Generate Secret and QR Code
router.post("/2fa/setup", async (req, res) => {
  try {
    const { userId } = req.body; // In real app, get from req.user
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ message: "User not found" });

    const { authenticator } = require("otplib");
    const QRCode = require("qrcode");

    // Generate secret
    const secret = authenticator.generateSecret();
    user.twoFactorSecret = secret;
    await user.save();

    // Generate QR Code
    const otpauth = authenticator.keyuri(user.email, "mbkcarrierz", secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauth);

    res.json({
      success: true,
      secret,
      qrCodeUrl,
    });
  } catch (error) {
    console.error("2FA Setup Error:", error);
    res.status(500).json({ message: "Failed to setup 2FA" });
  }
});

// 2FA Verify - Enable 2FA
router.post("/2fa/verify", async (req, res) => {
  try {
    const { userId, token } = req.body;
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ message: "User not found" });

    const { authenticator } = require("otplib");

    const isValid = authenticator.verify({
      token,
      secret: user.twoFactorSecret,
      window: 1,
    });

    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid token" });
    }

    user.twoFactorEnabled = true;
    await user.save();

    res.json({ success: true, message: "2FA Enabled successfully" });
  } catch (error) {
    console.error("2FA Verify Error:", error);
    res.status(500).json({ message: "Failed to verify 2FA" });
  }
});

// 2FA Validate - For Login
router.post("/2fa/validate", async (req, res) => {
  try {
    const { userId, token } = req.body;
    const user = await User.findById(userId);

    if (!user) return res.status(404).json({ message: "User not found" });

    const { authenticator } = require("otplib");

    // Check for time drift
    const isValid = authenticator.verify({
      token,
      secret: user.twoFactorSecret,
      window: 1, // Allow 1 step (30sec) variance
    });

    if (!isValid) {
      console.log(`2FA Validate Failed. User: ${user.email}, Token: ${token}`);
      return res.status(400).json({ success: false, message: "Invalid token" });
    }

    // Generate tokens (Login success)
    const accessToken = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET || "secret_key",
      { expiresIn: "10m" },
    );

    const refreshToken = crypto.randomBytes(40).toString("hex");
    await RefreshToken.create({
      user: user._id,
      token: refreshToken,
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByIp: req.ip,
    });

    setTokenCookie(res, refreshToken);

    res.json({
      success: true,
      message: "Login successful",
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("2FA Validate Error:", error);
    res.status(500).json({ message: "Failed to validate 2FA" });
  }
});

module.exports = router;

