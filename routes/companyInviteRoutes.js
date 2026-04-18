const express = require("express");
const crypto = require("crypto");
const { authenticate } = require("../middleware/auth");
const { upload } = require("../config/cloudinary");
const { CompanyInvite, Otp, Company, User, CompanyArchive } = require("../models");
const { sendMail } = require("../utils/emailService");
const inviteEmailTemplate = require("../utils/inviteEmailTemplate");
const companyActivatedEmail = require("../utils/companyActivatedEmail");
const { uploadCompanyLogoToDrive } = require("../utils/companyLogoUpload");
const {
  ensureCompanyHierarchy,
  isTrainingDriveEnabled,
} = require("../modules/drive/driveGateway");

const router = express.Router();

const isSuperAdmin = (user) =>
  String(user?.role || "").toLowerCase() === "superadmin";
const isCompanyAdminRole = (role) =>
  ["companyadmin", "CompanyAdmin"].includes(String(role || ""));

const createSystemGeneratedPassword = () =>
  `MBK#${crypto.randomBytes(24).toString("hex")}`;

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

const processOptionalLogoUpload = (req, res) =>
  new Promise((resolve) => {
    upload.single("logo")(req, res, (error) => {
      if (error) {
        req.logoUploadError = error;
        req.file = null;
      }
      resolve();
    });
  });

// STEP 1: Super Admin sends invite after OTP verification
router.post("/", authenticate, async (req, res) => {
  try {
    if (!isSuperAdmin(req.user)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // OTP must be verified before invite creation
    const otpRecord = await Otp.findOne({
      purpose: "company_admin_verify",
      verified: true,
      used: true,
      expiresAt: { $gt: new Date() },
      $or: [{ email: normalizedEmail }, { email }],
    });
    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: "Email not OTP-verified. Please verify OTP first.",
      });
    }

    // Email is unique globally. If user exists, allow only company-admin profiles for multi-company linking.
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser && !isCompanyAdminRole(existingUser.role)) {
      return res.status(400).json({
        success: false,
        message: "Email is already used by a non-company-admin account",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Invalidate any previous unused invite(s) for same email
    await CompanyInvite.updateMany(
      { email: normalizedEmail, used: false },
      { $set: { used: true } },
    );

    await CompanyInvite.create({
      email: normalizedEmail,
      token,
      expiresAt,
      verifiedBySuperAdmin: true,
    });

    // Consume OTP window
    await Otp.deleteOne({ _id: otpRecord._id });

    const link = `${process.env.FRONTEND_URL || "http://localhost:5174"}/company-onboarding/${token}`;
    await sendMail(
      normalizedEmail,
      "MBK Company Setup Invitation",
      `Complete company setup: ${link}\n\nThis link is valid for 24 hours.`,
      inviteEmailTemplate(link),
    );

    return res.json({ success: true, inviteLink: link });
  } catch (error) {
    console.error("company-invite create error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create company invite",
    });
  }
});

// Token validation for onboarding page
router.get("/validate/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const invite = await CompanyInvite.findOne({
      token,
      used: false,
      verifiedBySuperAdmin: true,
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired invite link",
      });
    }

    return res.json({
      success: true,
      email: invite.email,
    });
  } catch (error) {
    console.error("company-invite validate error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to validate invite link",
    });
  }
});

// Backward-compatible token validation for onboarding page
router.get("/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const invite = await CompanyInvite.findOne({
      token,
      used: false,
      verifiedBySuperAdmin: true,
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired invite link",
      });
    }

    return res.json({
      success: true,
      email: invite.email,
    });
  } catch (error) {
    console.error("company-invite token verify error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify invite link",
    });
  }
});

// STEP 2: Company onboarding completion by mail holder
router.post("/complete", async (req, res) => {
  try {
    await processOptionalLogoUpload(req, res);
    const { token, companyName, phone, address, adminName } = req.body;

    if (!token || !companyName || !phone || !address || !adminName) {
      return res.status(400).json({
        success: false,
        message: "token, companyName, phone, address, and adminName are required",
      });
    }

    const invite = await CompanyInvite.findOne({
      token,
      used: false,
      verifiedBySuperAdmin: true,
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired invite link",
      });
    }

    const existingUser = await User.findOne({ email: invite.email });
    if (existingUser && !isCompanyAdminRole(existingUser.role)) {
      return res.status(400).json({
        success: false,
        message: "Email is already used by a non-company-admin account",
      });
    }

    const existingCompany = await Company.findOne({ email: invite.email });
    if (existingCompany) {
      return res.status(400).json({
        success: false,
        message: "Company with this email already exists",
      });
    }

    const logoUploadWarning = req.logoUploadError
      ? "Company was created without logo because logo upload failed."
      : null;
    if (req.logoUploadError) {
      console.error("company-invite logo upload warning:", req.logoUploadError);
    }
    const storedLogoPath = getStoredLogoPath(req.file);

    const company = await Company.create({
      name: companyName,
      adminName,
      email: invite.email,
      phone,
      address,
      status: "active",
      ...(storedLogoPath ? { logo: storedLogoPath } : {}),
    });
    let companyHierarchy = null;
    if (isTrainingDriveEnabled()) {
      try {
        companyHierarchy = await ensureCompanyHierarchy({ company });
        if (companyHierarchy?.companyFolder?.id) {
          company.driveFolderId = companyHierarchy.companyFolder.id;
          company.driveFolderName = companyHierarchy.companyFolder.name;
          company.driveFolderLink = companyHierarchy.companyFolder.link;
        }
      } catch (driveError) {
        console.error(
          "[GOOGLE-DRIVE] Failed to create company folder during invite completion:",
          driveError.message,
        );
      }
    }

    if (req.file && isTrainingDriveEnabled()) {
      try {
        const logoDriveUpload = await uploadCompanyLogoToDrive({
          file: req.file,
          company,
          hierarchy: companyHierarchy,
        });
        if (logoDriveUpload?.logoUrl) {
          company.logo = logoDriveUpload.logoUrl;
        }
      } catch (driveLogoError) {
        console.error(
          "[GOOGLE-DRIVE] Failed to upload company logo during invite completion:",
          driveLogoError.message,
        );
      }
    }

    let user = existingUser;

    if (!user) {
      user = await User.create({
        name: adminName,
        email: invite.email,
        password: createSystemGeneratedPassword(),
        role: "CompanyAdmin",
        companyId: company._id, // primary company for existing code paths
        companyIds: [company._id],
        companyCode: company.companyCode,
        companyCodes: [company.companyCode],
        emailVerified: true,
        isEmailVerified: true,
        accountStatus: "active",
        isActive: true,
      });
    } else {
      user.name = adminName || user.name;
      if (!user.companyId) user.companyId = company._id;
      if (!user.companyCode) user.companyCode = company.companyCode;
      user.companyIds = [...new Set([...(user.companyIds || []).map(String), String(company._id)])];
      user.companyCodes = [...new Set([...(user.companyCodes || []), String(company.companyCode).toUpperCase()])];
      user.emailVerified = true;
      user.isEmailVerified = true;
      user.accountStatus = "active";
      user.isActive = true;
      if (!String(user.password || "").trim()) {
        user.password = createSystemGeneratedPassword();
      }

      await user.save();
    }

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

    invite.used = true;
    await invite.save();

    await sendMail(
      invite.email,
      "MBK Company Admin Account Activated",
      `Hello ${adminName},\n\nThank you for joining MBK Carriez.\nYour company ${companyName} has been successfully activated.\nAll trainer activities, schedules, and daily updates will be shared to your registered mailbox.\nCompany CoNDAct Email: ${invite.email}\n\nThanks & Regards,\nMBK Carriez Team`,
      companyActivatedEmail({
        companyName,
        adminName,
        coNDActEmail: invite.email,
      }),
    );

    return res.json({
      success: true,
      message: "Company created successfully",
      ...(logoUploadWarning ? { warning: logoUploadWarning } : {}),
      company: {
        id: company._id,
        name: company.name,
        companyCode: company.companyCode,
      },
    });
  } catch (error) {
    console.error("company-invite complete error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to complete onboarding",
    });
  }
});

module.exports = router;
