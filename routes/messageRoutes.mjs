import express from "express";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { auth } = require("../middleware/auth.js");
const User = require("../models/User");
const {
  RealtimeMessageError,
  deleteMessageForEveryone,
  deleteMessageForMe,
} = require("../services/realtimeMessageService");
const {
  sendMessage,
  getMessagesByChat,
  searchMessages,
  getChatInfo,
  markMessagesDelivered,
} = require("../services/customChatService");

const router = express.Router();

router.post("/send", auth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id || req.user._id).select("_id name role blockedUsers isActive");
    if (!currentUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const savedMessage = await sendMessage({
      io: req.io,
      currentUser,
      payload: req.body || {},
    });

    res.status(201).json({
      success: true,
      message: "Message sent",
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

router.post("/delivered", auth, async (req, res) => {
  try {
    const currentUserId = String(req.user.id || req.user._id || "").trim();
    const payload = req.body || {};
    const messageIds = Array.isArray(payload.messageIds) ? payload.messageIds : [];
    const chatId = payload.chatId ? String(payload.chatId) : null;

    const result = await markMessagesDelivered({
      io: req.io,
      currentUserId,
      messageIds,
      chatId,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    const status = err instanceof RealtimeMessageError ? err.statusCode : 500;
    res.status(status).json({
      success: false,
      message: err.message || "Failed to update delivery status",
    });
  }
});

router.get("/search", auth, async (req, res) => {
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

    const result = await searchMessages({
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

router.get("/:chatId/info", auth, async (req, res) => {
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

router.get("/:chatId", auth, async (req, res) => {
  try {
    const currentUserId = String(req.user.id || req.user._id || "").trim();
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const result = await getMessagesByChat({
      io: req.io,
      currentUserId,
      chatId,
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
      message: err.message || "Failed to fetch messages",
    });
  }
});

router.put("/:messageId/delete-for-me", auth, async (req, res) => {
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

router.put("/:messageId/delete-for-everyone", auth, async (req, res) => {
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

export default router;
