import express from "express";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { 
  auth, 
  checkRole 
} = require("../middleware/auth.js");

const { 
  createWorkspaceBootstrap,
  createWorkspaceQuickBootstrap,
  createWorkspaceFullBootstrap,
  createDirectChannel,
  createGroupChannel,
  addMembersToGroup,
  removeMemberFromGroup,
  createBroadcastChannel,
  sendAnnouncementMessage,
  deleteMessage,
  clearChannelMessages,
  removeChannelMember,
  deleteChannelForEveryone,
} = require("../services/streamChatService.js");
const {
  ALLOWED_MESSAGE_TYPES,
  RealtimeMessageError,
  deleteMessageForEveryone,
  deleteMessageForMe,
  getDirectConversationHistory,
} = require("../services/realtimeMessageService");
const {
  createChat,
  listChats,
  sendMessage: sendCustomMessage,
  searchMessages: searchCustomMessages,
  getChatInfo,
} = require("../services/customChatService");
const {
  listChatValidationLogs,
  logChatValidationSafe,
} = require("../services/chatValidationLogService");
const User = require("../models/User");
const Notification = require("../models/Notification");

const router = express.Router();
const BROADCAST_RECIPIENT_ROLES = ["Trainer", "SPOCAdmin", "CollegeAdmin"];

const normalizeRoleToken = (value = "") =>
  String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");

const normalizeAnnouncementInput = (payload) => {
  if (typeof payload === "string") {
    return { text: payload.trim(), attachments: [] };
  }

  if (!payload || typeof payload !== "object") {
    return { text: "", attachments: [] };
  }

  const text =
    payload.text ||
    payload.message ||
    payload.content ||
    payload.body ||
    "";

  return {
    text: String(text || "").trim(),
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
  };
};

router.post("/create", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id).select("_id name role blockedUsers isActive");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const chat = await createChat({
      currentUser: user,
      payload: req.body || {},
    });

    res.status(201).json({
      success: true,
      message: "Chat created",
      data: chat,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({ success: false, message: err.message || "Failed to create chat" });
  }
});

router.get("/", auth, async (req, res) => {
  try {
    const currentUserId = String(req.user.id || req.user._id || "").trim();
    const search = req.query.search || req.query.q || "";
    const { page = 1, limit = 30 } = req.query;

    const chats = await listChats({
      currentUserId,
      search,
      page,
      limit,
    });

    res.json({
      success: true,
      ...chats,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({ success: false, message: err.message || "Failed to fetch chats" });
  }
});

// ─── BOOTSTRAP ────────────────────────────────────────────────
router.get("/bootstrap", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const bootstrap = await createWorkspaceBootstrap(user);
    res.json({ success: true, ...bootstrap, bootstrap, user: bootstrap.currentUser, token: bootstrap.token });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/quick-bootstrap", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const bootstrap = await createWorkspaceQuickBootstrap(user);
    res.json({ success: true, ...bootstrap, bootstrap, user: bootstrap.currentUser, token: bootstrap.token });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/full-bootstrap", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const bootstrap = await createWorkspaceFullBootstrap(user);
    res.json({ success: true, ...bootstrap });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── CLEAN MESSAGE ROOT ───────────────────────────────────────

// 1. DIRECT CHAT (Trainer/SPOC/SuperAdmin)
router.post("/direct", auth, checkRole(["Trainer", "SPOCAdmin", "SuperAdmin", "admin", "Admin", "superadmin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await createDirectChannel(user, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// 2. GROUP MANAGEMENT (Admin/SPOC only)
router.post("/group/create", auth, checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await createGroupChannel(user, req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

router.post("/group/:id/add-members", auth, checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await addMembersToGroup(user, req.params.id, req.body.memberIds);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

router.delete("/group/:id/remove-member/:userId", auth, checkRole(["SuperAdmin", "Admin", "SPOCAdmin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await removeMemberFromGroup(user, req.params.id, req.params.userId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// 3. BROADCAST (Admin only) - send announcement to Trainers + SPOCs
router.post("/broadcast", auth, checkRole(["SuperAdmin", "Admin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const { text, attachments } = normalizeAnnouncementInput(req.body);

    // Primary flow: Admin announcement broadcast.
    if (text) {
      const recipients = await User.find({
        role: { $in: BROADCAST_RECIPIENT_ROLES },
        isActive: { $ne: false },
        _id: { $ne: user._id },
      }).select("_id role");

      if (!recipients.length) {
        return res.status(400).json({ message: "No Trainers/SPOCs available for broadcast" });
      }

      await Notification.insertMany(
        recipients.map((recipient) => ({
          userId: recipient._id,
          role: recipient.role,
          title: "Admin Broadcast",
          message: text,
          type: "Announcement",
          link: "/chat",
          isRead: false,
        })),
      );

      let streamMessageId = null;
      try {
        const streamResult = await sendAnnouncementMessage(user, { text, attachments });
        streamMessageId = streamResult?.messageId || null;
      } catch (streamError) {
        console.warn("Announcement persisted, but Stream channel publish failed:", streamError?.message || streamError);
      }

      const sentAt = new Date().toISOString();
      const realtimePayload = {
        kind: "admin_broadcast",
        broadcastId: streamMessageId || `broadcast-${Date.now()}`,
        title: "Admin Broadcast",
        message: text,
        type: "Announcement",
        link: "/chat",
        sentAt,
        sender: {
          id: (user._id || user.id).toString(),
          name: user.name || user.email || "Admin",
          role: user.role,
        },
        targetRoles: BROADCAST_RECIPIENT_ROLES,
      };

      req.io?.emit("receive_message", realtimePayload);
      await logChatValidationSafe({
        source: "api",
        action: "broadcast",
        event: "announcement_sent",
        status: "success",
        lane: "broadcast",
        actorId: String(user._id || user.id || ""),
        actorName: user.name || user.email || "Admin",
        actorRole: user.role || "SuperAdmin",
        senderId: String(user._id || user.id || ""),
        senderRole: user.role || "SuperAdmin",
        targetUserIds: recipients.map((recipient) => String(recipient._id)),
        uiEvent: "receive_message",
        details: {
          message: text,
          streamMessageId,
          recipientsResolved: recipients.length,
        },
      });

      return res.json({
        success: true,
        mode: "announcement",
        recipientsResolved: recipients.length,
        streamMessageId,
        socketEvent: "receive_message",
      });
    }

    // Backward compatibility: old "create broadcast channel" modal flow.
    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim();
    if (!name) {
      return res.status(400).json({ message: "Announcement text or broadcast name is required" });
    }

    const result = await createBroadcastChannel(user, { name, description });
    await logChatValidationSafe({
      source: "api",
      action: "broadcast",
      event: "broadcast_channel_created",
      status: "success",
      lane: "broadcast",
      channelId: result?.channelId || null,
      actorId: String(user._id || user.id || ""),
      actorName: user.name || user.email || "Admin",
      actorRole: user.role || "SuperAdmin",
      senderId: String(user._id || user.id || ""),
      senderRole: user.role || "SuperAdmin",
      targetUserIds: Array.isArray(result?.members) ? result.members.map(String) : [],
      uiEvent: "sidebar_refresh",
      details: {
        name,
        description,
      },
    });
    res.json({ success: true, mode: "channel", ...result });
  } catch (err) {
    await logChatValidationSafe({
      source: "api",
      action: "broadcast",
      event: "broadcast_failed",
      status: "failed",
      lane: "broadcast",
      actorId: String(req.user?.id || req.user?._id || ""),
      senderId: String(req.user?.id || req.user?._id || ""),
      uiEvent: "none",
      errorMessage: err?.message || "Broadcast failed",
    });
    res.status(500).json({ message: err.message });
  }
});

// ─── MESSAGE & CHANNEL MANAGEMENT ───────────────────────────

// Message Proxy/Audit (Optional but requested)
router.post("/message/send", auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id || req.user._id).select("_id name role blockedUsers isActive");
    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const payload = req.body || {};
    const savedMessage = await sendCustomMessage({
      io: req.io,
      currentUser,
      payload,
    });

    res.status(201).json({
      success: true,
      message: "Message sent",
      allowedTypes: Array.from(ALLOWED_MESSAGE_TYPES),
      data: savedMessage,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: err.message || "Failed to send message",
    });
  }
});

router.get("/message/history/:otherUserId", auth, async (req, res) => {
  try {
    const currentUserId = String(req.user.id || req.user._id || "").trim();
    const { otherUserId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const history = await getDirectConversationHistory({
      currentUserId,
      otherUserId,
      page,
      limit,
    });

    res.json({
      success: true,
      ...history,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: err.message || "Failed to fetch message history",
    });
  }
});

router.get("/message/search", auth, async (req, res) => {
  try {
    const currentUserId = String(req.user.id || req.user._id || "").trim();
    const search = req.query.search || req.query.q || "";
    const { page = 1, limit = 20 } = req.query;

    if (!String(search || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Search text is required",
      });
    }

    const result = await searchCustomMessages({
      currentUserId,
      search,
      page,
      limit,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: err.message || "Failed to search messages",
    });
  }
});

router.get("/info/:chatId", auth, async (req, res) => {
  try {
    const currentUserId = String(req.user.id || req.user._id || "").trim();
    const { chatId } = req.params;

    const result = await getChatInfo({
      currentUserId,
      chatId,
      mediaLimit: Number(req.query.mediaLimit) || 100,
      fileLimit: Number(req.query.fileLimit) || 100,
      linkLimit: Number(req.query.linkLimit) || 100,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: err.message || "Failed to load chat info",
    });
  }
});

router.put("/message/:messageId/delete-for-me", auth, async (req, res) => {
  try {
    const actorId = String(req.user.id || req.user._id || "").trim();
    const { messageId } = req.params;

    const result = await deleteMessageForMe({
      io: req.io,
      actorId,
      messageId,
    });

    res.json({
      success: true,
      message: "Message deleted for you",
      data: result,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: err.message || "Failed to delete message for you",
    });
  }
});

router.put("/message/:messageId/delete-for-everyone", auth, async (req, res) => {
  try {
    const actorId = String(req.user.id || req.user._id || "").trim();
    const { messageId } = req.params;

    const result = await deleteMessageForEveryone({
      io: req.io,
      actorId,
      messageId,
    });

    res.json({
      success: true,
      message: "Message deleted for everyone",
      data: result,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: err.message || "Failed to delete message for everyone",
    });
  }
});

// Delete Message (Admin/SPOC only)
router.delete("/message/:messageId", auth, checkRole(["SuperAdmin", "SPOCAdmin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await deleteMessage(user, req.params.messageId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// Clear Full History (Admin/SPOC only)
router.delete("/channel/:channelId/messages", auth, checkRole(["SuperAdmin", "SPOCAdmin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await clearChannelMessages(user, req.params.channelId, req.query.type);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// Super Admin: delete full channel (group/broadcast) for everyone
router.delete("/channel/:channelId", auth, checkRole(["SuperAdmin", "superadmin", "Super Admin", "super admin", "Admin", "admin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await deleteChannelForEveryone(user, req.params.channelId, req.query.type || "messaging");
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// Member Management
router.delete("/channel/:channelId/leave", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await removeChannelMember(user, req.params.channelId, user._id.toString(), req.query.type);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

router.delete("/channel/:channelId/remove-user/:memberId", auth, checkRole(["SuperAdmin", "SPOCAdmin"]), async (req, res) => {
  try {
    const user = await User.findById(req.user.id || req.user._id);
    const result = await removeChannelMember(user, req.params.channelId, req.params.memberId, req.query.type);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// ─── UTILITIES ───────────────────────────────────────────────

router.get("/validation-logs", auth, async (req, res) => {
  try {
    const requesterId = String(req.user?.id || req.user?._id || "").trim();
    const requester = await User.findById(requesterId).select("_id role");
    if (!requester) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const roleToken = normalizeRoleToken(requester.role);
    const canViewAll =
      roleToken.includes("superadmin") || roleToken === "admin" || roleToken.includes("spoc");

    const result = await listChatValidationLogs({
      page: req.query.page,
      limit: req.query.limit,
      action: req.query.action,
      lane: req.query.lane,
      status: req.query.status,
      source: req.query.source,
      chatId: req.query.chatId,
      roomId: req.query.roomId,
      channelId: req.query.channelId,
      senderId: req.query.senderId,
      role: req.query.role,
      from: req.query.from,
      to: req.query.to,
      userId: canViewAll ? req.query.userId : requesterId,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch validation logs" });
  }
});

router.get("/search", auth, async (req, res) => {
  try {
    const currentUserId = String(req.user.id || req.user._id || "").trim();
    const search = req.query.q || req.query.search || "";
    const { page = 1, limit = 20 } = req.query;

    if (!String(search || "").trim()) {
      return res.status(400).json({ success: false, message: "Search query is required" });
    }

    const result = await searchCustomMessages({
      currentUserId,
      search,
      page,
      limit,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({ success: false, message: err.message });
  }
});

router.get("/channel/:channelId/audit-log", auth, async (req, res) => {
  try {
    const result = await listChatValidationLogs({
      channelId: req.params.channelId,
      limit: req.query.limit || 100,
      page: req.query.page || 1,
    });

    res.json({
      success: true,
      logs: result.data || [],
      total: result.total || 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
