import { createRequire } from "module";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const Notification = require("../models/Notification.js");
const User = require("../models/User.js");
const {
  RealtimeMessageError,
  deleteMessageForEveryone,
  deleteMessageForMe,
} = require("./realtimeMessageService.js");
const {
  sendMessage: sendCustomMessage,
  markMessagesDelivered,
} = require("./customChatService.js");
const {
  detectLane,
  logChatValidationSafe,
} = require("./chatValidationLogService.js");

const normalizeRoomIds = (rooms = []) => {
  if (!Array.isArray(rooms)) return [];
  return Array.from(
    new Set(
      rooms
        .map((room) => String(room || "").trim())
        .filter(Boolean),
    ),
  );
};

const resolveJoinableRoom = (payload = {}) => {
  if (typeof payload === "string") {
    const direct = String(payload).trim();
    return direct || null;
  }

  if (!payload || typeof payload !== "object") return null;

  const directRoom =
    payload.roomId ||
    payload.room ||
    payload.channel ||
    payload.channelId ||
    null;
  if (directRoom) {
    return String(directRoom).trim() || null;
  }

  const chatId = payload.chatId || payload.id || null;
  if (chatId) {
    return `chat:${String(chatId).trim()}`;
  }

  return null;
};

const parseRegisterPayload = (payload) => {
  if (typeof payload === "string") {
    return { userId: payload, token: null };
  }

  if (payload && typeof payload === "object") {
    return {
      userId: payload.userId || payload.id || payload.uid || null,
      token: payload.token || null,
    };
  }

  return { userId: null, token: null };
};

/**
 * SocketManager: Handles real-time presence and unified notifications.
 * Tracks online users and broadcasts status changes to relevant roles.
 */
class SocketManager {
  constructor() {
    this.io = null;
    this.onlineUsers = new Map(); // userId -> Set(socketId)
    this.socketUsers = new Map(); // socketId -> userId
    this.userRoles = new Map(); // userId -> role
  }

  getOnlineUsersSnapshot() {
    return Array.from(this.onlineUsers.entries()).map(([userId]) => ({
      userId,
      role: this.userRoles.get(userId) || null,
      online: true,
    }));
  }

  emitOnlineUsers(targetSocket = null) {
    const payload = {
      users: this.getOnlineUsersSnapshot(),
      ids: Array.from(this.onlineUsers.keys()),
      count: this.onlineUsers.size,
    };

    if (targetSocket) {
      targetSocket.emit("online_users", payload);
      return;
    }

    this.io?.emit("online_users", payload);
  }

  init(io) {
    this.io = io;
    console.log("SocketManager Initialized");

    const emitValidationLog = (payload = {}) => {
      logChatValidationSafe({
        source: "socket",
        ...payload,
      });
    };

    this.io.on("connection", (socket) => {
      emitValidationLog({
        action: "connect",
        event: "socket_connected",
        status: "info",
        lane: "system",
        actorId: "anonymous",
        senderId: "anonymous",
        details: {
          socketId: socket.id,
        },
      });

      socket.on("register", async (payload) => {
        const { userId, token } = parseRegisterPayload(payload);
        let resolvedUserId = userId ? String(userId) : null;

        if (!resolvedUserId && !token) return;

        if (token) {
          try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret_key");
            const tokenUserId = decoded?.id || decoded?._id || decoded?.userId;
            if (tokenUserId && resolvedUserId && String(tokenUserId) !== resolvedUserId) {
              socket.emit("auth_error", { message: "Socket token user mismatch" });
              socket.disconnect(true);
              return;
            }
            resolvedUserId = String(tokenUserId || resolvedUserId || "");
          } catch (err) {
            socket.emit("auth_error", { message: "Invalid socket token" });
            socket.disconnect(true);
            return;
          }
        }

        if (!resolvedUserId) return;

        const existingSockets = this.onlineUsers.get(resolvedUserId) || new Set();
        const isAlreadyOnline = existingSockets.size > 0;
        existingSockets.add(socket.id);
        this.onlineUsers.set(resolvedUserId, existingSockets);
        this.socketUsers.set(socket.id, resolvedUserId);
        socket.userId = resolvedUserId;
        socket.join(`user:${resolvedUserId}`);
        socket.emit("registered", { userId: resolvedUserId });

        try {
          const user = await User.findById(resolvedUserId);
          if (user) {
            socket.role = user.role;
            this.userRoles.set(resolvedUserId, user.role || null);
            emitValidationLog({
              action: "register",
              event: "socket_registered",
              status: "success",
              lane: "system",
              actorId: resolvedUserId,
              actorRole: user.role || null,
              senderId: resolvedUserId,
              senderRole: user.role || null,
              targetUserIds: [resolvedUserId],
              uiEvent: "online_users",
              details: {
                socketId: socket.id,
              },
            });

            if (!isAlreadyOnline) {
              this.io.emit("user_online", { userId: resolvedUserId, role: user.role });
              this.io.emit("online", { userId: resolvedUserId, role: user.role, online: true });

              if (user.role === "Trainer") {
                await this.sendRoleNotification({
                  title: "Trainer Online",
                  message: `${user.name} is now available in the workspace.`,
                  type: "System",
                  roles: ["SuperAdmin", "SPOCAdmin", "CollegeAdmin"],
                  link: "/workspace",
                });
              }
            }
          }

          socket.emit("online", {
            userId: resolvedUserId,
            role: socket.role || null,
            online: true,
          });
          this.emitOnlineUsers(socket);
          this.emitOnlineUsers();
        } catch (err) {
          console.error("Socket Registration Error:", err);
        }
      });

      socket.on("online_users", (ack) => {
        this.emitOnlineUsers(socket);
        emitValidationLog({
          action: "online_users",
          event: "snapshot_requested",
          status: "info",
          lane: "system",
          actorId: socket.userId || "anonymous",
          actorRole: socket.role || null,
          senderId: socket.userId || "anonymous",
          senderRole: socket.role || null,
          targetUserIds: [socket.userId].filter(Boolean),
          uiEvent: "online_users",
        });
        if (typeof ack === "function") {
          ack({
            success: true,
            users: this.getOnlineUsersSnapshot(),
          });
        }
      });

      socket.on("join_rooms", (payload = {}) => {
        if (!socket.userId) return;

        const roomIds = normalizeRoomIds(
          Array.isArray(payload)
            ? payload
            : payload.rooms || payload.roomIds || payload.channels || [],
        );
        if (!roomIds.length) return;

        roomIds.forEach((roomId) => socket.join(roomId));
        socket.emit("rooms_joined", { rooms: roomIds });
      });

      socket.on("join_room", (roomId) => {
        if (!socket.userId) return;
        const normalized = normalizeRoomIds([roomId]);
        if (!normalized.length) return;
        socket.join(normalized[0]);
        socket.emit("room_joined", { room: normalized[0] });
      });

      // Canonical chat-join event for: connect -> join_chat -> send_message flow.
      socket.on("join_chat", (payload = {}, ack) => {
        if (!socket.userId) {
          emitValidationLog({
            action: "join_chat",
            event: "join_denied_unregistered",
            status: "failed",
            lane: "system",
            actorId: "anonymous",
            senderId: "anonymous",
            errorMessage: "Socket user is not registered",
          });
          if (typeof ack === "function") {
            ack({ success: false, message: "Socket user is not registered" });
          }
          return;
        }

        const roomId = resolveJoinableRoom(payload);
        if (!roomId) {
          emitValidationLog({
            action: "join_chat",
            event: "join_failed_missing_room",
            status: "failed",
            lane: "unknown",
            actorId: String(socket.userId),
            actorRole: socket.role || null,
            senderId: String(socket.userId),
            senderRole: socket.role || null,
            errorMessage: "chatId/roomId is required",
          });
          if (typeof ack === "function") {
            ack({ success: false, message: "chatId/roomId is required" });
          }
          return;
        }

        socket.join(roomId);
        socket.emit("chat_joined", { roomId });
        emitValidationLog({
          action: "join_chat",
          event: "chat_joined",
          status: "success",
          lane: detectLane({ roomId, action: "join_chat" }),
          roomId,
          actorId: String(socket.userId),
          actorRole: socket.role || null,
          senderId: String(socket.userId),
          senderRole: socket.role || null,
          targetUserIds: [String(socket.userId)],
          uiEvent: "chat_joined",
        });
        if (typeof ack === "function") {
          ack({ success: true, roomId });
        }
      });

      socket.on("send_message", async (payload = {}, ack) => {
        if (!socket.userId) {
          emitValidationLog({
            action: "send_message",
            event: "socket_send_denied_unregistered",
            status: "failed",
            lane: "system",
            actorId: "anonymous",
            senderId: "anonymous",
            errorMessage: "Socket user is not registered",
          });
          if (typeof ack === "function") {
            ack({ success: false, message: "Socket user is not registered" });
          }
          return;
        }

        try {
          const message = await sendCustomMessage({
            io: this.io,
            currentUser: {
              _id: socket.userId,
              id: socket.userId,
              role: socket.role || null,
            },
            payload,
          });

          if (typeof ack === "function") {
            ack({ success: true, data: message });
          }
          emitValidationLog({
            action: "send_message",
            event: "socket_send_ack_success",
            status: "success",
            lane: detectLane({
              roomId: payload?.roomId || (payload?.chatId ? `chat:${String(payload.chatId)}` : null),
              action: "send_message",
            }),
            chatId: payload?.chatId ? String(payload.chatId) : null,
            roomId: payload?.roomId || null,
            messageId: message?.id || message?._id || null,
            actorId: String(socket.userId),
            actorRole: socket.role || null,
            senderId: String(socket.userId),
            senderRole: socket.role || null,
            targetUserIds: [payload?.receiverId].filter(Boolean).map(String),
            uiEvent: "receive_message",
            details: {
              type: payload?.type || "text",
            },
          });
        } catch (err) {
          const message = err?.message || "Failed to send message";
          emitValidationLog({
            action: "send_message",
            event: "socket_send_ack_failed",
            status: "failed",
            lane: detectLane({
              roomId: payload?.roomId || (payload?.chatId ? `chat:${String(payload.chatId)}` : null),
              action: "send_message",
            }),
            chatId: payload?.chatId ? String(payload.chatId) : null,
            roomId: payload?.roomId || null,
            actorId: String(socket.userId),
            actorRole: socket.role || null,
            senderId: String(socket.userId),
            senderRole: socket.role || null,
            targetUserIds: [payload?.receiverId].filter(Boolean).map(String),
            uiEvent: "none",
            errorMessage: message,
          });
          if (typeof ack === "function") {
            ack({
              success: false,
              message,
              statusCode: err instanceof RealtimeMessageError ? err.statusCode : 500,
            });
          }
        }
      });

      socket.on("message_delivered", async (payload = {}, ack) => {
        if (!socket.userId) {
          if (typeof ack === "function") {
            ack({ success: false, message: "Socket user is not registered" });
          }
          return;
        }

        try {
          const normalizedPayload = payload && typeof payload === "object" ? payload : {};
          const messageIds = Array.isArray(normalizedPayload.messageIds)
            ? normalizedPayload.messageIds
            : [normalizedPayload.messageId].filter(Boolean);

          const result = await markMessagesDelivered({
            io: this.io,
            currentUserId: socket.userId,
            messageIds,
            chatId: normalizedPayload.chatId || null,
          });

          if (typeof ack === "function") {
            ack({ success: true, data: result });
          }
        } catch (err) {
          if (typeof ack === "function") {
            ack({
              success: false,
              message: err?.message || "Failed to mark delivered",
              statusCode: err instanceof RealtimeMessageError ? err.statusCode : 500,
            });
          }
        }
      });

      socket.on("typing", (payload = {}, ack) => {
        if (!socket.userId) {
          if (typeof ack === "function") {
            ack({ success: false, message: "Socket user is not registered" });
          }
          return;
        }

        const normalizedPayload = payload && typeof payload === "object" ? payload : {};
        const roomId = resolveJoinableRoom(normalizedPayload);
        const receiverId = normalizedPayload?.receiverId
          ? String(normalizedPayload.receiverId).trim()
          : null;
        const isTyping = Boolean(normalizedPayload?.isTyping);

        const typingEvent = {
          from: String(socket.userId),
          roomId: roomId || null,
          receiverId,
          chatId: normalizedPayload?.chatId ? String(normalizedPayload.chatId) : null,
          isTyping,
          at: new Date().toISOString(),
        };

        if (roomId) {
          socket.to(roomId).emit("typing", typingEvent);
        }

        if (receiverId) {
          this.io.to(`user:${receiverId}`).emit("typing", typingEvent);
        }

        if (String(process.env.CHAT_VALIDATION_LOG_TYPING || "false").toLowerCase() === "true") {
          emitValidationLog({
            action: "typing",
            event: isTyping ? "typing_started" : "typing_stopped",
            status: "info",
            lane: detectLane({ roomId, action: "typing" }),
            chatId: typingEvent.chatId || null,
            roomId: roomId || null,
            actorId: String(socket.userId),
            actorRole: socket.role || null,
            senderId: String(socket.userId),
            senderRole: socket.role || null,
            targetUserIds: [receiverId].filter(Boolean),
            uiEvent: "typing",
          });
        }

        if (typeof ack === "function") {
          ack({ success: true });
        }
      });

      socket.on("delete_message_for_me", async (payload = {}, ack) => {
        if (!socket.userId) {
          if (typeof ack === "function") {
            ack({ success: false, message: "Socket user is not registered" });
          }
          return;
        }

        try {
          const result = await deleteMessageForMe({
            io: this.io,
            actorId: socket.userId,
            messageId: payload?.messageId,
          });

          if (typeof ack === "function") {
            ack({ success: true, data: result });
          }
        } catch (err) {
          if (typeof ack === "function") {
            ack({
              success: false,
              message: err?.message || "Failed to delete message for me",
              statusCode: err instanceof RealtimeMessageError ? err.statusCode : 500,
            });
          }
        }
      });

      socket.on("delete_message_for_everyone", async (payload = {}, ack) => {
        if (!socket.userId) {
          if (typeof ack === "function") {
            ack({ success: false, message: "Socket user is not registered" });
          }
          return;
        }

        try {
          const result = await deleteMessageForEveryone({
            io: this.io,
            actorId: socket.userId,
            messageId: payload?.messageId,
          });

          if (typeof ack === "function") {
            ack({ success: true, data: result });
          }
        } catch (err) {
          if (typeof ack === "function") {
            ack({
              success: false,
              message: err?.message || "Failed to delete message for everyone",
              statusCode: err instanceof RealtimeMessageError ? err.statusCode : 500,
            });
          }
        }
      });

      socket.on("disconnect", () => {
        const userId = socket.userId || this.socketUsers.get(socket.id);
        emitValidationLog({
          action: "disconnect",
          event: "socket_disconnected",
          status: "info",
          lane: "system",
          actorId: userId ? String(userId) : "anonymous",
          actorRole: socket.role || null,
          senderId: userId ? String(userId) : "anonymous",
          senderRole: socket.role || null,
          details: {
            socketId: socket.id,
          },
        });
        if (userId) {
          const userSockets = this.onlineUsers.get(userId);
          if (userSockets) {
            userSockets.delete(socket.id);
            if (userSockets.size === 0) {
              this.onlineUsers.delete(userId);
              this.userRoles.delete(userId);
              this.io.emit("user_offline", { userId });
              this.io.emit("online", { userId, online: false });
              this.emitOnlineUsers();
            } else {
              this.onlineUsers.set(userId, userSockets);
            }
          }
        }
        this.socketUsers.delete(socket.id);
      });
    });
  }

  /**
   * Send a notification to specific users and persist in DB.
   */
  async sendNotification({ userId, title, message, type = "System", link = null }) {
    try {
      const notification = await Notification.create({
        userId,
        title,
        message,
        type,
        link,
        role: "Trainer",
      });

      if (this.onlineUsers.get(String(userId))?.size) {
        this.io.to(`user:${userId}`).emit(`notification_${userId}`, notification);
      }

      return notification;
    } catch (err) {
      console.error("Send Notification Error:", err);
      return null;
    }
  }

  /**
   * Broadcast a notification to all users of specific roles.
   */
  async sendRoleNotification({ title, message, type = "System", roles = [], link = null }) {
    try {
      const users = await User.find({ role: { $in: roles } });
      const notificationPromises = users.map((user) =>
        this.sendNotification({
          userId: user._id,
          title,
          message,
          type,
          link,
        }),
      );
      await Promise.all(notificationPromises);
    } catch (err) {
      console.error("Role Notification Error:", err);
    }
  }

  isUserOnline(userId) {
    return Boolean(this.onlineUsers.get(String(userId))?.size);
  }
}

export default new SocketManager();
