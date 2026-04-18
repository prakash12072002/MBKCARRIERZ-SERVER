const express = require("express");
const { authenticate, checkRole } = require("../../middleware/auth");
const {
  chatBootstrapController,
  chatBroadcastController,
  chatChannelClearMessagesController,
  chatChannelDeleteController,
  chatChannelLeaveController,
  chatChannelRemoveUserController,
  chatGroupAddMembersController,
  chatGroupCreateController,
  chatGroupRemoveMemberController,
  chatCreateController,
  chatDeleteMessageController,
  chatDeleteForEveryoneController,
  chatDeleteForMeController,
  chatMessageSendController,
  chatDirectController,
  chatFullBootstrapController,
  chatQuickBootstrapController,
  chatChannelAuditLogController,
  chatInfoController,
  chatListController,
  chatMessageHistoryController,
  chatMessageSearchController,
  chatSearchController,
  chatValidationLogsController,
} = require("./chat.controller");

const router = express.Router();

router.post("/create", authenticate, chatCreateController);
router.post(
  "/broadcast",
  authenticate,
  checkRole(["SuperAdmin", "Admin"]),
  chatBroadcastController,
);
router.post("/message/send", authenticate, chatMessageSendController);
router.delete("/channel/:channelId/leave", authenticate, chatChannelLeaveController);
router.delete(
  "/channel/:channelId",
  authenticate,
  checkRole(["SuperAdmin", "superadmin", "Super Admin", "super admin", "Admin", "admin"]),
  chatChannelDeleteController,
);
router.delete(
  "/channel/:channelId/messages",
  authenticate,
  checkRole(["SuperAdmin", "SPOCAdmin"]),
  chatChannelClearMessagesController,
);
router.delete(
  "/channel/:channelId/remove-user/:memberId",
  authenticate,
  checkRole(["SuperAdmin", "SPOCAdmin"]),
  chatChannelRemoveUserController,
);
router.delete(
  "/group/:id/remove-member/:userId",
  authenticate,
  checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]),
  chatGroupRemoveMemberController,
);
router.post(
  "/group/create",
  authenticate,
  checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]),
  chatGroupCreateController,
);
router.post(
  "/group/:id/add-members",
  authenticate,
  checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]),
  chatGroupAddMembersController,
);
router.put(
  "/message/:messageId/delete-for-everyone",
  authenticate,
  chatDeleteForEveryoneController,
);
router.put(
  "/message/:messageId/delete-for-me",
  authenticate,
  chatDeleteForMeController,
);
router.delete(
  "/message/:messageId",
  authenticate,
  checkRole(["SuperAdmin", "SPOCAdmin"]),
  chatDeleteMessageController,
);
router.post(
  "/direct",
  authenticate,
  checkRole(["Trainer", "SPOCAdmin", "SuperAdmin", "admin", "Admin", "superadmin"]),
  chatDirectController,
);
router.get("/channel/:channelId/audit-log", authenticate, chatChannelAuditLogController);
router.get("/bootstrap", authenticate, chatBootstrapController);
router.get("/full-bootstrap", authenticate, chatFullBootstrapController);
router.get("/quick-bootstrap", authenticate, chatQuickBootstrapController);
router.get("/", authenticate, chatListController);
router.get("/info/:chatId", authenticate, chatInfoController);
router.get("/message/history/:otherUserId", authenticate, chatMessageHistoryController);
router.get("/message/search", authenticate, chatMessageSearchController);
router.get("/search", authenticate, chatSearchController);
router.get("/validation-logs", authenticate, chatValidationLogsController);

module.exports = router;
