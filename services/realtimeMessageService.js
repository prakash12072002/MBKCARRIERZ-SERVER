const ChatMessage = require("../models/ChatMessage");
const User = require("../models/User");
const {
  detectLane,
  logChatValidationSafe,
} = require("./chatValidationLogService");

const ALLOWED_MESSAGE_TYPES = new Set([
  "text",
  "image",
  "video",
  "pdf",
  "audio",
  "voice",
]);

class RealtimeMessageError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "RealtimeMessageError";
    this.statusCode = statusCode;
  }
}

const normalizeType = (value) => String(value || "text").trim().toLowerCase();

const buildDirectRoomId = (a, b) => `direct:${[String(a), String(b)].sort().join(":")}`;

const toSocketPayload = (messageDoc) => {
  const message = messageDoc.toObject ? messageDoc.toObject() : messageDoc;
  const isDeleted = Boolean(message.isDeleted);
  const messageText = isDeleted
    ? "This message was deleted"
    : message.content || message.text || "";
  const messageFileUrl = isDeleted ? null : message.fileUrl || message.mediaUrl || null;

  return {
    kind: "chat_message",
    id: String(message._id),
    _id: String(message._id),
    senderId: String(message.senderId),
    receiverId: message.receiverId ? String(message.receiverId) : null,
    roomId: message.roomId || null,
    chatId: message.chatId ? String(message.chatId) : null,
    type: message.type,
    text: messageText,
    content: messageText,
    mediaUrl: messageFileUrl,
    fileUrl: messageFileUrl,
    mimeType: isDeleted ? null : message.mimeType || null,
    fileName: isDeleted ? null : message.fileName || null,
    fileSize: isDeleted ? null : message.fileSize ?? null,
    duration: isDeleted ? null : message.duration ?? null,
    metadata: isDeleted ? {} : message.metadata || {},
    status: message.status || "sent",
    isDeleted,
    hiddenFor: Array.isArray(message.hiddenFor)
      ? message.hiddenFor.map((value) => String(value))
      : [],
    deletedForEveryoneAt: message.deletedForEveryoneAt || null,
    deletedForEveryoneBy: message.deletedForEveryoneBy
      ? String(message.deletedForEveryoneBy)
      : null,
    tempId: message.tempId ? String(message.tempId) : null,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
};

const validatePayload = ({ senderId, receiverId, roomId, chatId, type, text, content, mediaUrl, fileUrl }) => {
  if (!senderId) {
    throw new RealtimeMessageError("senderId is required", 400);
  }

  if (!receiverId && !roomId && !chatId) {
    throw new RealtimeMessageError("receiverId, roomId or chatId is required", 400);
  }

  if (!ALLOWED_MESSAGE_TYPES.has(type)) {
    throw new RealtimeMessageError(
      `Unsupported message type: "${type}". Allowed: ${Array.from(ALLOWED_MESSAGE_TYPES).join(", ")}`,
      400,
    );
  }

  const normalizedContent = String(content || text || "").trim();
  const normalizedFileUrl = String(fileUrl || mediaUrl || "").trim();

  if (type === "text" && !normalizedContent) {
    throw new RealtimeMessageError("content/text is required for text messages", 400);
  }

  if (type !== "text" && !normalizedFileUrl) {
    throw new RealtimeMessageError(`fileUrl/mediaUrl is required for ${type} messages`, 400);
  }
};

const createAndDispatchMessage = async ({ io, senderId, payload = {} }) => {
  const normalizedSenderId = String(senderId || "").trim();
  const receiverId = payload.receiverId ? String(payload.receiverId).trim() : null;
  let roomId = payload.roomId ? String(payload.roomId).trim() : null;
  const chatId = payload.chatId ? String(payload.chatId).trim() : null;
  const type = normalizeType(payload.type);
  const text = String(payload.text || payload.content || "").trim();
  const content = String(payload.content || payload.text || "").trim();
  const mediaUrl = payload.mediaUrl ? String(payload.mediaUrl).trim() : null;
  const fileUrl = payload.fileUrl ? String(payload.fileUrl).trim() : mediaUrl;
  const mimeType = payload.mimeType ? String(payload.mimeType).trim() : null;
  const fileName = payload.fileName ? String(payload.fileName).trim() : null;
  const fileSize = Number.isFinite(payload.fileSize) ? Number(payload.fileSize) : null;
  const duration = Number.isFinite(payload.duration) ? Number(payload.duration) : null;
  const tempId = payload.tempId ? String(payload.tempId).trim() : null;
  const metadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};

  try {
    validatePayload({
      senderId: normalizedSenderId,
      receiverId,
      roomId,
      chatId,
      type,
      text,
      content,
      mediaUrl,
      fileUrl,
    });

    if (receiverId === normalizedSenderId) {
      throw new RealtimeMessageError("Cannot send message to yourself", 400);
    }

    if (receiverId) {
      const receiver = await User.findById(receiverId).select("_id");
      if (!receiver) {
        throw new RealtimeMessageError("Receiver not found", 404);
      }
    }

    if (!roomId && receiverId) {
      roomId = buildDirectRoomId(normalizedSenderId, receiverId);
    }

    const saved = await ChatMessage.create({
      senderId: normalizedSenderId,
      receiverId,
      roomId,
      chatId,
      type,
      text: content,
      content,
      mediaUrl: fileUrl,
      fileUrl,
      mimeType,
      fileName,
      fileSize,
      duration,
      tempId,
      metadata,
      status: "sent",
    });

    const realtimePayload = toSocketPayload(saved);

    if (io) {
      io.to(`user:${normalizedSenderId}`).emit("receive_message", realtimePayload);
      if (receiverId) {
        io.to(`user:${receiverId}`).emit("receive_message", realtimePayload);
      }
      if (roomId) {
        io.to(roomId).emit("receive_message", realtimePayload);
      }
      if (chatId) {
        io.to(`chat:${chatId}`).emit("receive_message", realtimePayload);
      }
    }

    await logChatValidationSafe({
      source: "socket",
      action: "receive_message",
      event: "emitted",
      status: "success",
      lane: detectLane({
        lane: payload?.lane,
        roomId,
        action: "receive_message",
      }),
      chatId,
      roomId,
      messageId: String(saved?._id || ""),
      actorId: normalizedSenderId,
      senderId: normalizedSenderId,
      targetUserIds: [receiverId, normalizedSenderId].filter(Boolean),
      uiEvent: "receive_message",
      details: {
        type,
        hasFile: Boolean(fileUrl),
        hasText: Boolean(content),
      },
    });

    return realtimePayload;
  } catch (error) {
    await logChatValidationSafe({
      source: "socket",
      action: "receive_message",
      event: "emit_failed",
      status: "failed",
      lane: detectLane({
        lane: payload?.lane,
        roomId,
        action: "receive_message",
      }),
      chatId,
      roomId,
      actorId: normalizedSenderId || "system",
      senderId: normalizedSenderId || "system",
      targetUserIds: [receiverId].filter(Boolean),
      uiEvent: "none",
      errorMessage: error?.message || "Failed to dispatch message",
      details: {
        type,
        hasFile: Boolean(fileUrl),
      },
    });
    throw error;
  }
};

const assertMessageParticipant = (message, actorId) => {
  const senderId = String(message.senderId || "");
  const receiverId = message.receiverId ? String(message.receiverId) : null;
  const normalizedActorId = String(actorId || "").trim();

  const isParticipant =
    normalizedActorId &&
    (normalizedActorId === senderId || normalizedActorId === receiverId);

  if (!isParticipant) {
    throw new RealtimeMessageError("You are not allowed to modify this message", 403);
  }

  return { senderId, receiverId };
};

const deleteMessageForMe = async ({ io, actorId, messageId }) => {
  const normalizedActorId = String(actorId || "").trim();
  const normalizedMessageId = String(messageId || "").trim();

  if (!normalizedMessageId) {
    throw new RealtimeMessageError("messageId is required", 400);
  }

  const message = await ChatMessage.findById(normalizedMessageId);
  if (!message) {
    throw new RealtimeMessageError("Message not found", 404);
  }

  assertMessageParticipant(message, normalizedActorId);

  await ChatMessage.updateOne(
    { _id: normalizedMessageId },
    { $addToSet: { hiddenFor: normalizedActorId } },
  );

  const payload = {
    success: true,
    scope: "me",
    messageId: normalizedMessageId,
    userId: normalizedActorId,
    roomId: message.roomId || null,
    chatId: message.chatId ? String(message.chatId) : null,
  };

  if (io) {
    io.to(`user:${normalizedActorId}`).emit("message_deleted", payload);
  }
  await logChatValidationSafe({
    source: "socket",
    action: "delete_for_me",
    event: "message_hidden",
    status: "success",
    lane: detectLane({ roomId: payload.roomId }),
    chatId: payload.chatId,
    roomId: payload.roomId,
    messageId: normalizedMessageId,
    actorId: normalizedActorId,
    senderId: normalizedActorId,
    targetUserIds: [normalizedActorId],
    uiEvent: "message_deleted",
    details: {
      scope: "me",
    },
  });

  return payload;
};

const deleteMessageForEveryone = async ({ io, actorId, messageId }) => {
  const normalizedActorId = String(actorId || "").trim();
  const normalizedMessageId = String(messageId || "").trim();

  if (!normalizedMessageId) {
    throw new RealtimeMessageError("messageId is required", 400);
  }

  const message = await ChatMessage.findById(normalizedMessageId);
  if (!message) {
    throw new RealtimeMessageError("Message not found", 404);
  }

  const { senderId, receiverId } = assertMessageParticipant(message, normalizedActorId);

  if (senderId !== normalizedActorId) {
    throw new RealtimeMessageError("Only sender can delete for everyone", 403);
  }

  const updatedMessage = await ChatMessage.findByIdAndUpdate(
    normalizedMessageId,
    {
      $set: {
        isDeleted: true,
        deletedForEveryoneAt: new Date(),
        deletedForEveryoneBy: normalizedActorId,
        text: "",
        content: "",
        mediaUrl: null,
        fileUrl: null,
        mimeType: null,
        fileName: null,
        fileSize: null,
        duration: null,
        metadata: {},
      },
    },
    { new: true },
  );

  const realtimePayload = toSocketPayload(updatedMessage);
  const deletionEvent = {
    success: true,
    scope: "everyone",
    messageId: normalizedMessageId,
    roomId: updatedMessage?.roomId || null,
    chatId: updatedMessage?.chatId ? String(updatedMessage.chatId) : null,
    deletedBy: normalizedActorId,
  };

  if (io) {
    io.to(`user:${senderId}`).emit("receive_message", realtimePayload);
    io.to(`user:${senderId}`).emit("message_deleted", deletionEvent);
    if (receiverId) {
      io.to(`user:${receiverId}`).emit("receive_message", realtimePayload);
      io.to(`user:${receiverId}`).emit("message_deleted", deletionEvent);
    }
    if (updatedMessage?.roomId) {
      io.to(updatedMessage.roomId).emit("receive_message", realtimePayload);
      io.to(updatedMessage.roomId).emit("message_deleted", deletionEvent);
    }
    if (updatedMessage?.chatId) {
      io.to(`chat:${updatedMessage.chatId}`).emit("receive_message", realtimePayload);
      io.to(`chat:${updatedMessage.chatId}`).emit("message_deleted", deletionEvent);
    }
  }

  await logChatValidationSafe({
    source: "socket",
    action: "delete_for_everyone",
    event: "message_deleted_everywhere",
    status: "success",
    lane: detectLane({ roomId: deletionEvent.roomId }),
    chatId: deletionEvent.chatId,
    roomId: deletionEvent.roomId,
    messageId: normalizedMessageId,
    actorId: normalizedActorId,
    senderId,
    targetUserIds: [senderId, receiverId].filter(Boolean),
    uiEvent: "message_deleted",
    details: {
      scope: "everyone",
    },
  });

  return {
    ...deletionEvent,
    data: realtimePayload,
  };
};

const getDirectConversationHistory = async ({
  currentUserId,
  otherUserId,
  page = 1,
  limit = 50,
}) => {
  const normalizedCurrentUserId = String(currentUserId || "").trim();
  const normalizedOtherUserId = String(otherUserId || "").trim();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));

  if (!normalizedCurrentUserId || !normalizedOtherUserId) {
    throw new RealtimeMessageError("currentUserId and otherUserId are required", 400);
  }

  const [messages, total] = await Promise.all([
    ChatMessage.find({
      $or: [
        { senderId: normalizedCurrentUserId, receiverId: normalizedOtherUserId },
        { senderId: normalizedOtherUserId, receiverId: normalizedCurrentUserId },
      ],
      hiddenFor: { $ne: normalizedCurrentUserId },
    })
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    ChatMessage.countDocuments({
      $or: [
        { senderId: normalizedCurrentUserId, receiverId: normalizedOtherUserId },
        { senderId: normalizedOtherUserId, receiverId: normalizedCurrentUserId },
      ],
      hiddenFor: { $ne: normalizedCurrentUserId },
    }),
  ]);

  return {
    total,
    page: safePage,
    limit: safeLimit,
    data: messages.reverse().map(toSocketPayload),
  };
};

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const searchConversationMessages = async ({
  currentUserId,
  search,
  page = 1,
  limit = 20,
}) => {
  const normalizedCurrentUserId = String(currentUserId || "").trim();
  const normalizedSearch = String(search || "").trim();
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));

  if (!normalizedCurrentUserId) {
    throw new RealtimeMessageError("currentUserId is required", 400);
  }

  if (!normalizedSearch) {
    return {
      total: 0,
      page: safePage,
      limit: safeLimit,
      data: [],
      users: {},
    };
  }

  const regex = new RegExp(escapeRegex(normalizedSearch), "i");
  const baseQuery = {
    hiddenFor: { $ne: normalizedCurrentUserId },
    $and: [
      {
        $or: [
          { content: { $regex: regex } },
          { text: { $regex: regex } },
        ],
      },
      {
        $or: [
          { senderId: normalizedCurrentUserId },
          { receiverId: normalizedCurrentUserId },
        ],
      },
    ],
  };

  const [messages, total] = await Promise.all([
    ChatMessage.find(baseQuery)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    ChatMessage.countDocuments(baseQuery),
  ]);

  const userIds = Array.from(
    new Set(
      messages.flatMap((message) => [
        String(message.senderId || ""),
        String(message.receiverId || ""),
      ]).filter(Boolean),
    ),
  );

  const users = {};
  if (userIds.length) {
    const userDocs = await User.find({ _id: { $in: userIds } }).select("_id name role profilePicture");
    userDocs.forEach((userDoc) => {
      const userId = String(userDoc._id);
      users[userId] = {
        id: userId,
        name: userDoc.name || userId,
        role: userDoc.role || null,
        image: userDoc.profilePicture || null,
      };
    });
  }

  return {
    total,
    page: safePage,
    limit: safeLimit,
    data: messages.map(toSocketPayload),
    users,
  };
};

module.exports = {
  ALLOWED_MESSAGE_TYPES,
  RealtimeMessageError,
  createAndDispatchMessage,
  deleteMessageForMe,
  deleteMessageForEveryone,
  getDirectConversationHistory,
  searchConversationMessages,
};
