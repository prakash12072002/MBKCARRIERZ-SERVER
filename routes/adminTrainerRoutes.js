const express = require("express");
const router = express.Router();
const { Trainer, User } = require("../models");
const { authenticate } = require("../middleware/auth");
const { sendTrainerLogin } = require("../utils/emailService");
const { autoCreateTrainerAdminChannels } = require("../services/streamChatService");

// Middleware to check if user is SuperAdmin
const isSuperAdmin = (req, res, next) => {
  if (req.user.role !== "SuperAdmin") {
    return res
      .status(403)
      .json({ message: "Access denied. Super Admin only." });
  }
  next();
};

/**
 * 4️⃣ Admin Approve API
 * POST /api/admin/trainers/approve/:id
 */
router.post("/approve/:id", authenticate, isSuperAdmin, async (req, res) => {
  try {
    const trainer = await Trainer.findById(req.params.id);

    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    trainer.status = "APPROVED";
    trainer.verificationStatus = "VERIFIED";
    trainer.registrationStatus = "approved";
    trainer.registrationStep = 6;
    trainer.approvedAt = new Date();
    trainer.approvedBy = req.user.id;

    await trainer.save();

    // send login details (Phase 8 snipppet)
    await sendTrainerLogin(trainer);

    // 🔥 Auto-create Chat Channel between Approving Admin and Trainer
    try {
      const adminUser = await User.findById(req.user.id);
      const trUser = await User.findById(trainer.userId);
      if (adminUser && trUser) {
        await autoCreateTrainerAdminChannels(trUser, [adminUser]);
      }
    } catch (chatErr) {
      console.error("Failed to auto-create Stream Chat channel on approval:", chatErr);
    }

    res.json({ success: true, message: "Trainer approved successfully" });
  } catch (error) {
    console.error("Admin Approve Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Admin Reject API
 * POST /api/admin/trainers/reject/:id
 */
router.post("/reject/:id", authenticate, isSuperAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const trainer = await Trainer.findById(req.params.id);

    if (!trainer) {
      return res
        .status(404)
        .json({ success: false, message: "Trainer not found" });
    }

    trainer.status = "REJECTED";
    // Optional: We could store rejection reason in a field if required,
    // but the final schema didn't explicitly show a top-level rejectionReason.
    // Using existing fields if they exist or just updating status.

    await trainer.save();

    res.json({ success: true, message: "Trainer rejected successfully" });
  } catch (error) {
    console.error("Admin Reject Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
