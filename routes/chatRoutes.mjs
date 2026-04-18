import express from "express";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { 
  auth, 
  checkRole 
} = require("../middleware/auth.js");

const {
  chatBootstrapController,
  chatBroadcastController,
  chatChannelAuditLogController,
  chatChannelClearMessagesController,
  chatChannelDeleteController,
  chatChannelLeaveController,
  chatChannelRemoveUserController,
  chatGroupCreateController,
  chatGroupAddMembersController,
  chatGroupRemoveMemberController,
  chatCreateController,
  chatDeleteMessageController,
  chatDeleteForEveryoneController,
  chatDeleteForMeController,
  chatMessageSendController,
  chatDirectController,
  chatFullBootstrapController,
  chatInfoController,
  chatListController,
  chatMessageHistoryController,
  chatMessageSearchController,
  chatQuickBootstrapController,
  chatSearchController,
  chatValidationLogsController,
} = require("../modules/chat/chat.controller.js");

const router = express.Router();

router.post("/create", auth, chatCreateController);

router.get("/", auth, chatListController);

// ─── BOOTSTRAP ────────────────────────────────────────────────
router.get("/bootstrap", auth, chatBootstrapController);

router.get("/quick-bootstrap", auth, chatQuickBootstrapController);

router.get("/full-bootstrap", auth, chatFullBootstrapController);

// ─── CLEAN MESSAGE ROOT ───────────────────────────────────────

// 1. DIRECT CHAT (Trainer/SPOC/SuperAdmin)
router.post(
  "/direct",
  auth,
  checkRole(["Trainer", "SPOCAdmin", "SuperAdmin", "admin", "Admin", "superadmin"]),
  chatDirectController,
);

// 2. GROUP MANAGEMENT (Admin/SPOC only)
router.post(
  "/group/create",
  auth,
  checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]),
  chatGroupCreateController,
);

router.post(
  "/group/:id/add-members",
  auth,
  checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]),
  chatGroupAddMembersController,
);

router.delete(
  "/group/:id/remove-member/:userId",
  auth,
  checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]),
  chatGroupRemoveMemberController,
);

// 3. BROADCAST (Admin only) - send announcement to Trainers + SPOCs
router.post(
  "/broadcast",
  auth,
  checkRole(["SuperAdmin", "Admin"]),
  chatBroadcastController,
);

// ─── MESSAGE & CHANNEL MANAGEMENT ───────────────────────────

// Message Proxy/Audit (Optional but requested)
router.post("/message/send", auth, chatMessageSendController);

router.get("/message/history/:otherUserId", auth, chatMessageHistoryController);

router.get("/message/search", auth, chatMessageSearchController);

router.get("/info/:chatId", auth, chatInfoController);

router.put("/message/:messageId/delete-for-me", auth, chatDeleteForMeController);

router.put("/message/:messageId/delete-for-everyone", auth, chatDeleteForEveryoneController);

// Delete Message (Admin/SPOC only)
router.delete("/message/:messageId", auth, checkRole(["SuperAdmin", "SPOCAdmin"]), chatDeleteMessageController);

// Clear Full History (Admin/SPOC only)
router.delete(
  "/channel/:channelId/messages",
  auth,
  checkRole(["SuperAdmin", "SPOCAdmin"]),
  chatChannelClearMessagesController,
);

// Super Admin: delete full channel (group/broadcast) for everyone
router.delete(
  "/channel/:channelId",
  auth,
  checkRole(["SuperAdmin", "superadmin", "Super Admin", "super admin", "Admin", "admin"]),
  chatChannelDeleteController,
);

// Member Management
router.delete("/channel/:channelId/leave", auth, chatChannelLeaveController);

router.delete(
  "/channel/:channelId/remove-user/:memberId",
  auth,
  checkRole(["SuperAdmin", "SPOCAdmin"]),
  chatChannelRemoveUserController,
);

// ─── UTILITIES ───────────────────────────────────────────────

router.get("/validation-logs", auth, chatValidationLogsController);

router.get("/search", auth, chatSearchController);

router.get("/channel/:channelId/audit-log", auth, chatChannelAuditLogController);

export default router;
