const mongoose = require("mongoose");
const Chat = require("../models/Chat");
const ChatMessage = require("../models/ChatMessage");
const User = require("../models/User");
const {
  RealtimeMessageError,
  createAndDispatchMessage,
} = require("./realtimeMessageService");
const {
  detectLane,
  logChatValidationSafe,
} = require("./chatValidationLogService");

const BROADCAST_TARGET_ROLES = [
  "Trainer",
  "trainer",
  "SPOCAdmin",
  "spoc",
  "CollegeAdmin",
  "collegeadmin",
];
const GROUP_DEFAULT_ADMIN_ROLES = [
  "SuperAdmin",
  "superadmin",
  "Admin",
  "admin",
  "SPOCAdmin",
  "spocadmin",
  "SPOC",
  "spoc",
  "CollegeAdmin",
  "collegeadmin",
];

const normalizeRoleToken = (value = "") =>
  String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");

const normalizePortalRole = (value = "") => {
  const token = normalizeRoleToken(value);
  if (token.includes("superadmin") || token === "admin") return "superadmin";
  if (token.includes("spoc") || token.includes("collegeadmin")) return "spoc";
  if (token.includes("trainer")) return "trainer";
  return "unknown";
};

const toObjectId = (value, fieldName = "id") => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new RealtimeMessageError(`${fieldName} is invalid`, 400);
  }
  return new mongoose.Types.ObjectId(String(value));
};

const dedupeIds = (values = []) =>
  Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));

const getChatMemberIds = (chatDoc = {}) =>
  dedupeIds(
    Array.isArray(chatDoc?.members)
      ? chatDoc.members.map((member) => String(member?._id || member?.id || member))
      : [],
  );

const buildDirectChatKey = (a, b) => `direct:${[String(a), String(b)].sort().join(":")}`;
const URL_REGEX = /https?:\/\/[^\s]+/gi;

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const canDirectMessageWith = (senderRole, targetRole) => {
  const sender = normalizePortalRole(senderRole);
  const target = normalizePortalRole(targetRole);

  if (sender === "superadmin") return ["superadmin", "spoc", "trainer"].includes(target);
  if (sender === "spoc") return ["superadmin", "trainer"].includes(target);
  if (sender === "trainer") return ["superadmin", "spoc"].includes(target);
  return false;
};

const serializeMember = (memberDoc) => ({
  id: String(memberDoc?._id || memberDoc?.id || ""),
  name: memberDoc?.name || "",
  role: memberDoc?.role || "",
  image: memberDoc?.profilePicture || null,
});

const serializeMessage = (messageDoc) => {
  const message = messageDoc?.toObject ? messageDoc.toObject() : messageDoc || {};
  const isDeleted = Boolean(message.isDeleted);
  const content = isDeleted ? "This message was deleted" : String(message.content || message.text || "");
  const fileUrl = isDeleted ? null : (message.fileUrl || message.mediaUrl || null);

  return {
    id: String(message._id || ""),
    _id: String(message._id || ""),
    tempId: isDeleted ? null : (message.tempId ? String(message.tempId) : null),
    chatId: message.chatId ? String(message.chatId) : null,
    senderId: message.senderId ? String(message.senderId) : null,
    receiverId: message.receiverId ? String(message.receiverId) : null,
    roomId: message.roomId || null,
    type: message.type || "text",
    text: content,
    content,
    mediaUrl: fileUrl,
    fileUrl,
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
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
};

const serializeChat = ({ chatDoc, currentUserId, latestMessageByChatId = {} }) => {
  const chat = chatDoc?.toObject ? chatDoc.toObject() : chatDoc || {};
  const normalizedCurrentUserId = String(currentUserId || "");

  const members = Array.isArray(chat.members) ? chat.members : [];
  const otherMembers = members.filter((member) => String(member?._id || member?.id) !== normalizedCurrentUserId);
  const fallbackName = chat.isGroup
    ? chat.name || "Group chat"
    : (otherMembers[0]?.name || "Direct chat");
  const latestMessage = latestMessageByChatId[String(chat._id)] || null;

  return {
    id: String(chat._id),
    _id: String(chat._id),
    isGroup: Boolean(chat.isGroup),
    name: fallbackName,
    members: members.map(serializeMember),
    createdBy: chat.createdBy ? String(chat.createdBy) : null,
    chatKey: chat.chatKey || null,
    hiddenFor: Array.isArray(chat.hiddenFor) ? chat.hiddenFor.map((value) => String(value)) : [],
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    lastMessage: latestMessage,
  };
};

const ensureUsersExist = async (userIds = []) => {
  const normalizedIds = dedupeIds(userIds);
  if (!normalizedIds.length) return [];
  const objectIds = normalizedIds.map((id) => toObjectId(id, "userId"));
  const docs = await User.find({ _id: { $in: objectIds } }).select("_id name role isActive");
  if (docs.length !== normalizedIds.length) {
    throw new RealtimeMessageError("One or more users were not found", 404);
  }
  return docs;
};

const ensureNotBlocked = (senderDoc, targetDoc) => {
  const senderId = String(senderDoc?._id || "");
  const targetId = String(targetDoc?._id || "");
  const senderBlockedUsers = Array.isArray(senderDoc?.blockedUsers)
    ? senderDoc.blockedUsers.map((value) => String(value))
    : [];
  const targetBlockedUsers = Array.isArray(targetDoc?.blockedUsers)
    ? targetDoc.blockedUsers.map((value) => String(value))
    : [];

  if (senderBlockedUsers.includes(targetId)) {
    throw new RealtimeMessageError("You have blocked this user", 403);
  }

  if (targetBlockedUsers.includes(senderId)) {
    throw new RealtimeMessageError("This user has blocked you", 403);
  }
};

const createChat = async ({ currentUser, payload = {} }) => {
  const actorId = String(currentUser?.id || currentUser?._id || "").trim();
  if (!actorId) {
    throw new RealtimeMessageError("Authenticated user is required", 401);
  }

  const actorRole = currentUser?.role || "";
  const actorRoleToken = normalizePortalRole(actorRole);
  const mode = String(
    payload.mode ||
      payload.type ||
      (payload.isBroadcast ? "broadcast" : payload.isGroup ? "group" : "private"),
  ).toLowerCase();

  if (mode === "broadcast") {
    if (actorRoleToken !== "superadmin") {
      throw new RealtimeMessageError("Only Super Admin can create broadcast chats", 403);
    }

    const broadcastKey = String(payload.chatKey || "broadcast:global").trim();
    const broadcastName = String(payload.name || "Broadcasts").trim();
    const recipients = await User.find({
      _id: { $ne: toObjectId(actorId, "currentUserId") },
      role: { $in: BROADCAST_TARGET_ROLES },
      isActive: { $ne: false },
    }).select("_id");

    const allMembers = dedupeIds([actorId, ...recipients.map((user) => String(user._id))]).map((id) =>
      toObjectId(id, "memberId"),
    );

    const chatDoc = await Chat.findOneAndUpdate(
      { chatKey: broadcastKey },
      {
        $set: {
          isGroup: true,
          name: broadcastName || "Broadcasts",
          createdBy: toObjectId(actorId, "currentUserId"),
          chatKey: broadcastKey,
        },
        $addToSet: {
          members: { $each: allMembers },
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).populate("members", "_id name role profilePicture");

    await logChatValidationSafe({
      source: "api",
      action: "create_chat",
      event: "broadcast_created",
      status: "success",
      lane: "broadcast",
      chatId: String(chatDoc?._id || ""),
      actorId,
      actorRole,
      senderId: actorId,
      senderRole: actorRole,
      targetUserIds: getChatMemberIds(chatDoc).filter((id) => id !== actorId),
      uiEvent: "sidebar_refresh",
      details: {
        mode: "broadcast",
        name: chatDoc?.name || broadcastName,
        memberCount: Array.isArray(chatDoc?.members) ? chatDoc.members.length : 0,
      },
    });

    return serializeChat({ chatDoc, currentUserId: actorId });
  }

  if (mode === "group") {
    if (!["superadmin", "spoc"].includes(actorRoleToken)) {
      throw new RealtimeMessageError("Only Super Admin and SPOC can create group chats", 403);
    }

    const rawMemberIds = dedupeIds([
      actorId,
      ...(Array.isArray(payload.memberIds) ? payload.memberIds : []),
      ...(Array.isArray(payload.members) ? payload.members : []),
      ...(Array.isArray(payload.portalUserIds) ? payload.portalUserIds : []),
    ]);

    const defaultAdminMembers = await User.find({
      role: { $in: GROUP_DEFAULT_ADMIN_ROLES },
      isActive: { $ne: false },
      accountStatus: "active",
      _id: { $ne: toObjectId(actorId, "currentUserId") },
    }).select("_id");

    const finalMemberIds = dedupeIds([
      ...rawMemberIds,
      ...defaultAdminMembers.map((userDoc) => String(userDoc._id)),
    ]);

    if (finalMemberIds.length < 2) {
      throw new RealtimeMessageError("At least two members are required for a group", 400);
    }

    await ensureUsersExist(finalMemberIds);
    const chatName = String(payload.name || "").trim();
    if (!chatName) {
      throw new RealtimeMessageError("Group name is required", 400);
    }

    const chatDoc = await Chat.create({
      isGroup: true,
      name: chatName,
      members: finalMemberIds.map((id) => toObjectId(id, "memberId")),
      createdBy: toObjectId(actorId, "currentUserId"),
      chatKey: payload.chatKey ? String(payload.chatKey).trim() : null,
    });

    const populated = await Chat.findById(chatDoc._id).populate("members", "_id name role profilePicture");

    await logChatValidationSafe({
      source: "api",
      action: "create_chat",
      event: "group_created",
      status: "success",
      lane: "group",
      chatId: String(populated?._id || chatDoc?._id || ""),
      actorId,
      actorRole,
      senderId: actorId,
      senderRole: actorRole,
      targetUserIds: finalMemberIds.filter((id) => id !== actorId),
      uiEvent: "sidebar_refresh",
      details: {
        mode: "group",
        name: chatName,
        memberCount: finalMemberIds.length,
        defaultAdminAdded: defaultAdminMembers.map((userDoc) => String(userDoc._id)),
      },
    });

    return serializeChat({ chatDoc: populated, currentUserId: actorId });
  }

  // Default mode: private chat
  const targetUserId = String(
    payload.targetUserId ||
      payload.receiverId ||
      payload.portalUserId ||
      payload.userId ||
      "",
  ).trim();

  if (!targetUserId) {
    throw new RealtimeMessageError("targetUserId is required for private chat", 400);
  }
  if (targetUserId === actorId) {
    throw new RealtimeMessageError("Cannot create chat with yourself", 400);
  }

  const [actorDoc, targetDoc] = await Promise.all([
    User.findById(actorId).select("_id role blockedUsers"),
    User.findById(targetUserId).select("_id role name blockedUsers"),
  ]);

  if (!actorDoc || !targetDoc) {
    throw new RealtimeMessageError("User not found", 404);
  }
  if (!canDirectMessageWith(actorDoc.role, targetDoc.role)) {
    throw new RealtimeMessageError("This direct chat is not allowed for your role", 403);
  }
  ensureNotBlocked(actorDoc, targetDoc);

  const chatKey = buildDirectChatKey(actorId, targetUserId);
  let chatDoc = await Chat.findOne({ chatKey, isGroup: false }).populate("members", "_id name role profilePicture");

  if (!chatDoc) {
    chatDoc = await Chat.create({
      isGroup: false,
      name: "",
      members: [toObjectId(actorId, "currentUserId"), toObjectId(targetUserId, "targetUserId")],
      createdBy: toObjectId(actorId, "currentUserId"),
      chatKey,
    });
    chatDoc = await Chat.findById(chatDoc._id).populate("members", "_id name role profilePicture");
  }

  await logChatValidationSafe({
    source: "api",
    action: "create_chat",
    event: "direct_ready",
    status: "success",
    lane: "chat",
    chatId: String(chatDoc?._id || ""),
    actorId,
    actorRole,
    senderId: actorId,
    senderRole: actorRole,
    targetUserIds: [targetUserId],
    uiEvent: "sidebar_refresh",
    details: {
      mode: "private",
      chatKey,
    },
  });

  return serializeChat({ chatDoc, currentUserId: actorId });
};

const listChats = async ({ currentUserId, search = "", page = 1, limit = 30 }) => {
  const normalizedCurrentUserId = String(currentUserId || "").trim();
  if (!normalizedCurrentUserId) {
    throw new RealtimeMessageError("currentUserId is required", 400);
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const normalizedSearch = String(search || "").trim().toLowerCase();

  const currentUserObjectId = toObjectId(normalizedCurrentUserId, "currentUserId");
  const baseQuery = {
    members: currentUserObjectId,
    hiddenFor: { $ne: currentUserObjectId },
  };

  const chats = await Chat.find(baseQuery)
    .populate("members", "_id name role profilePicture")
    .sort({ updatedAt: -1 })
    .skip((safePage - 1) * safeLimit)
    .limit(safeLimit);

  const chatIds = chats.map((chat) => chat._id);
  const latestMessages = chatIds.length
    ? await ChatMessage.aggregate([
        {
          $match: {
            chatId: { $in: chatIds },
            hiddenFor: { $ne: currentUserObjectId },
          },
        },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$chatId", message: { $first: "$$ROOT" } } },
      ])
    : [];

  const latestMessageByChatId = {};
  latestMessages.forEach((entry) => {
    latestMessageByChatId[String(entry._id)] = serializeMessage(entry.message);
  });

  let data = chats.map((chatDoc) =>
    serializeChat({ chatDoc, currentUserId: normalizedCurrentUserId, latestMessageByChatId }),
  );

  if (normalizedSearch) {
    data = data.filter((chat) => {
      const matchesChatName = String(chat.name || "").toLowerCase().includes(normalizedSearch);
      const matchesMember = Array.isArray(chat.members)
        ? chat.members.some((member) => String(member?.name || "").toLowerCase().includes(normalizedSearch))
        : false;
      return matchesChatName || matchesMember;
    });
  }

  data.sort((a, b) => {
    const aTime = new Date(a?.lastMessage?.createdAt || a.updatedAt || 0).getTime();
    const bTime = new Date(b?.lastMessage?.createdAt || b.updatedAt || 0).getTime();
    return bTime - aTime;
  });

  return {
    total: data.length,
    page: safePage,
    limit: safeLimit,
    data,
  };
};

const sendMessage = async ({ io, currentUser, payload = {} }) => {
  const senderId = String(currentUser?.id || currentUser?._id || "").trim();
  if (!senderId) {
    throw new RealtimeMessageError("Authenticated user is required", 401);
  }

  const normalizedPayload = payload && typeof payload === "object" ? { ...payload } : {};
  let chatId = normalizedPayload.chatId ? String(normalizedPayload.chatId).trim() : null;
  let senderRole = currentUser?.role || null;
  let targetChatDoc = null;
  let lane = "chat";
  let logTargetUserIds = [];

  try {
    const senderDoc = await User.findById(senderId).select("_id role blockedUsers isActive");
    if (!senderDoc || senderDoc.isActive === false) {
      throw new RealtimeMessageError("Sender is not active", 403);
    }
    senderRole = senderRole || senderDoc.role;

    if (chatId) {
      const chatDoc = await Chat.findById(chatId).select("_id isGroup members chatKey createdBy");
      if (!chatDoc) {
        throw new RealtimeMessageError("Chat not found", 404);
      }

      const memberIds = (chatDoc.members || []).map((value) => String(value));
      if (!memberIds.includes(senderId)) {
        throw new RealtimeMessageError("You are not a member of this chat", 403);
      }

      const isBroadcast = String(chatDoc.chatKey || "").startsWith("broadcast:");
      if (isBroadcast && normalizePortalRole(senderRole) !== "superadmin") {
        throw new RealtimeMessageError("Only Super Admin can send broadcast messages", 403);
      }

      if (!chatDoc.isGroup && !normalizedPayload.receiverId) {
        const receiverId = memberIds.find((id) => id !== senderId) || null;
        normalizedPayload.receiverId = receiverId;
      }
      normalizedPayload.chatId = chatId;
      normalizedPayload.roomId = normalizedPayload.roomId || `chat:${chatId}`;
      targetChatDoc = chatDoc;
      logTargetUserIds = memberIds.filter((id) => id !== senderId);
      lane = detectLane({
        chatKey: chatDoc.chatKey,
        isGroup: chatDoc.isGroup,
        roomId: normalizedPayload.roomId,
      });
    } else if (normalizedPayload.receiverId) {
      const receiverId = String(normalizedPayload.receiverId).trim();
      if (receiverId === senderId) {
        throw new RealtimeMessageError("Cannot send message to yourself", 400);
      }

      const targetDoc = await User.findById(receiverId).select("_id role blockedUsers isActive");
      if (!targetDoc || targetDoc.isActive === false) {
        throw new RealtimeMessageError("Receiver not found or inactive", 404);
      }

      if (!canDirectMessageWith(senderRole, targetDoc.role)) {
        throw new RealtimeMessageError("This direct chat is not allowed for your role", 403);
      }
      ensureNotBlocked(senderDoc, targetDoc);

      const directChatKey = buildDirectChatKey(senderId, receiverId);
      let directChat = await Chat.findOne({ chatKey: directChatKey, isGroup: false }).select("_id members chatKey isGroup");
      if (!directChat) {
        directChat = await Chat.create({
          isGroup: false,
          name: "",
          members: [toObjectId(senderId, "senderId"), toObjectId(receiverId, "receiverId")],
          createdBy: toObjectId(senderId, "senderId"),
          chatKey: directChatKey,
        });
      }

      chatId = String(directChat._id);
      normalizedPayload.chatId = chatId;
      normalizedPayload.roomId = normalizedPayload.roomId || directChatKey;
      normalizedPayload.receiverId = receiverId;
      targetChatDoc = directChat;
      logTargetUserIds = [receiverId];
      lane = "chat";
    }

    const saved = await createAndDispatchMessage({
      io,
      senderId,
      payload: {
        ...normalizedPayload,
        lane,
      },
    });

    if (chatId && targetChatDoc) {
      await Chat.updateOne({ _id: toObjectId(chatId, "chatId") }, { $set: { updatedAt: new Date() } });
    }

    await logChatValidationSafe({
      source: "api",
      action: "send_message",
      event: "message_saved_and_emitted",
      status: "success",
      lane,
      chatId,
      roomId: normalizedPayload.roomId || null,
      messageId: saved?.id || saved?._id || null,
      actorId: senderId,
      actorRole: senderRole,
      senderId,
      senderRole,
      targetUserIds: logTargetUserIds,
      uiEvent: "receive_message",
      details: {
        messageType: saved?.type || normalizedPayload.type || "text",
        receiverId: normalizedPayload.receiverId || null,
        via: "customChatService.sendMessage",
      },
    });

    return saved;
  } catch (error) {
    await logChatValidationSafe({
      source: "api",
      action: "send_message",
      event: "send_message_failed",
      status: "failed",
      lane,
      chatId,
      roomId: normalizedPayload.roomId || null,
      actorId: senderId,
      actorRole: senderRole,
      senderId,
      senderRole,
      targetUserIds: logTargetUserIds,
      uiEvent: "none",
      errorMessage: error?.message || "Failed to send message",
      details: {
        receiverId: normalizedPayload.receiverId || null,
        messageType: normalizedPayload.type || "text",
        via: "customChatService.sendMessage",
      },
    });
    throw error;
  }
};

const getMessagesByChat = async ({
  io,
  currentUserId,
  chatId,
  page = 1,
  limit = 50,
}) => {
  const normalizedCurrentUserId = String(currentUserId || "").trim();
  const normalizedChatId = String(chatId || "").trim();
  if (!normalizedCurrentUserId || !normalizedChatId) {
    throw new RealtimeMessageError("currentUserId and chatId are required", 400);
  }

  const chatDoc = await Chat.findById(normalizedChatId).select("_id members isGroup chatKey");
  if (!chatDoc) {
    throw new RealtimeMessageError("Chat not found", 404);
  }
  const memberIds = (chatDoc.members || []).map((value) => String(value));
  if (!memberIds.includes(normalizedCurrentUserId)) {
    throw new RealtimeMessageError("You are not a member of this chat", 403);
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const currentUserObjectId = toObjectId(normalizedCurrentUserId, "currentUserId");
  const chatObjectId = toObjectId(normalizedChatId, "chatId");

  const [messages, total] = await Promise.all([
    ChatMessage.find({
      chatId: chatObjectId,
      hiddenFor: { $ne: currentUserObjectId },
    })
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    ChatMessage.countDocuments({
      chatId: chatObjectId,
      hiddenFor: { $ne: currentUserObjectId },
    }),
  ]);

  const unreadIncomingIds = messages
    .filter(
      (message) =>
        String(message.senderId) !== normalizedCurrentUserId &&
        !message.isDeleted &&
        message.status !== "read",
    )
    .map((message) => message._id);

  if (unreadIncomingIds.length) {
    await ChatMessage.updateMany(
      { _id: { $in: unreadIncomingIds } },
      { $set: { status: "read" } },
    );

    if (io) {
      io.to(`chat:${normalizedChatId}`).emit("message_status", {
        chatId: normalizedChatId,
        messageIds: unreadIncomingIds.map((id) => String(id)),
        status: "read",
        readBy: normalizedCurrentUserId,
      });
    }

    await logChatValidationSafe({
      source: "api",
      action: "message_status",
      event: "read_marked_on_history_load",
      status: "success",
      lane: detectLane({
        chatKey: chatDoc.chatKey,
        isGroup: chatDoc.isGroup,
        roomId: `chat:${normalizedChatId}`,
      }),
      chatId: normalizedChatId,
      roomId: `chat:${normalizedChatId}`,
      actorId: normalizedCurrentUserId,
      actorRole: "unknown",
      senderId: normalizedCurrentUserId,
      senderRole: "unknown",
      uiEvent: "message_status",
      details: {
        readCount: unreadIncomingIds.length,
      },
    });
  }

  const data = messages
    .reverse()
    .map((message) => {
      const serialized = serializeMessage(message);
      if (unreadIncomingIds.find((id) => String(id) === String(message._id))) {
        serialized.status = "read";
      }
      return serialized;
    });

  await logChatValidationSafe({
    source: "api",
    action: "load_messages",
    event: "history_loaded",
    status: "success",
    lane: detectLane({
      chatKey: chatDoc.chatKey,
      isGroup: chatDoc.isGroup,
      roomId: `chat:${normalizedChatId}`,
    }),
    chatId: normalizedChatId,
    roomId: `chat:${normalizedChatId}`,
    actorId: normalizedCurrentUserId,
    actorRole: "unknown",
    senderId: normalizedCurrentUserId,
    senderRole: "unknown",
    uiEvent: "chat_history_render",
    details: {
      page: safePage,
      limit: safeLimit,
      total,
      returnedCount: data.length,
    },
  });

  return {
    total,
    page: safePage,
    limit: safeLimit,
    data,
  };
};

const searchMessages = async ({ currentUserId, search, page = 1, limit = 20 }) => {
  const normalizedCurrentUserId = String(currentUserId || "").trim();
  const normalizedSearch = String(search || "").trim();
  if (!normalizedCurrentUserId) {
    throw new RealtimeMessageError("currentUserId is required", 400);
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  if (!normalizedSearch) {
    return {
      total: 0,
      page: safePage,
      limit: safeLimit,
      data: [],
      users: {},
    };
  }

  const currentUserObjectId = toObjectId(normalizedCurrentUserId, "currentUserId");
  const memberChats = await Chat.find({
    members: currentUserObjectId,
    hiddenFor: { $ne: currentUserObjectId },
  }).select("_id");
  const memberChatIds = memberChats.map((chat) => chat._id);
  const regex = new RegExp(escapeRegex(normalizedSearch), "i");

  const accessFilters = [
    { senderId: currentUserObjectId },
    { receiverId: currentUserObjectId },
  ];

  if (memberChatIds.length) {
    accessFilters.push({ chatId: { $in: memberChatIds } });
  }

  const baseQuery = {
    hiddenFor: { $ne: currentUserObjectId },
    $and: [
      {
        $or: [
          { content: { $regex: regex } },
          { text: { $regex: regex } },
          { fileName: { $regex: regex } },
        ],
      },
      {
        $or: accessFilters,
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
      messages
        .flatMap((message) => [String(message.senderId || ""), String(message.receiverId || "")])
        .filter(Boolean),
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
    data: messages.map((message) => serializeMessage(message)),
    users,
  };
};

const markMessagesDelivered = async ({ io, currentUserId, messageIds = [], chatId = null }) => {
  const normalizedCurrentUserId = String(currentUserId || "").trim();
  if (!normalizedCurrentUserId) {
    throw new RealtimeMessageError("currentUserId is required", 400);
  }

  try {
    const normalizedIds = dedupeIds(messageIds);
    if (!normalizedIds.length) {
      return { count: 0, messageIds: [] };
    }

    const deliveredMessageObjectIds = normalizedIds
      .filter((messageId) => mongoose.Types.ObjectId.isValid(messageId))
      .map((messageId) => toObjectId(messageId, "messageId"));

    if (!deliveredMessageObjectIds.length) {
      return { count: 0, messageIds: [] };
    }

    const baseFilter = {
      _id: { $in: deliveredMessageObjectIds },
      receiverId: toObjectId(normalizedCurrentUserId, "currentUserId"),
      isDeleted: false,
      status: { $in: ["sent"] },
    };

    if (chatId && mongoose.Types.ObjectId.isValid(chatId)) {
      baseFilter.chatId = toObjectId(chatId, "chatId");
    }

    const matchedMessages = await ChatMessage.find(baseFilter).select("_id chatId senderId receiverId");
    const updateResult = await ChatMessage.updateMany(baseFilter, { $set: { status: "delivered" } });
    const deliveredIds = matchedMessages.map((message) => String(message._id));

    if (io && deliveredIds.length) {
      const chatRooms = Array.from(
        new Set(
          matchedMessages
            .map((message) => (message.chatId ? `chat:${String(message.chatId)}` : null))
            .filter(Boolean),
        ),
      );
      const userRooms = Array.from(
        new Set(
          matchedMessages
            .flatMap((message) => [message.senderId ? `user:${String(message.senderId)}` : null, message.receiverId ? `user:${String(message.receiverId)}` : null])
            .filter(Boolean),
        ),
      );

      chatRooms.forEach((roomId) => {
        io.to(roomId).emit("message_status", {
          messageIds: deliveredIds,
          status: "delivered",
          deliveredTo: normalizedCurrentUserId,
        });
      });
      userRooms.forEach((roomId) => {
        io.to(roomId).emit("message_status", {
          messageIds: deliveredIds,
          status: "delivered",
          deliveredTo: normalizedCurrentUserId,
        });
      });
    }

    await logChatValidationSafe({
      source: "api",
      action: "message_status",
      event: "delivered",
      status: "success",
      lane: "chat",
      chatId: chatId ? String(chatId) : null,
      roomId: chatId ? `chat:${String(chatId)}` : null,
      actorId: normalizedCurrentUserId,
      actorRole: "unknown",
      senderId: normalizedCurrentUserId,
      senderRole: "unknown",
      uiEvent: "message_status",
      details: {
        deliveredCount: deliveredIds.length,
        deliveredIds,
      },
    });

    return {
      count: updateResult?.modifiedCount || 0,
      messageIds: deliveredIds,
    };
  } catch (error) {
    await logChatValidationSafe({
      source: "api",
      action: "message_status",
      event: "delivered_failed",
      status: "failed",
      lane: "chat",
      chatId: chatId ? String(chatId) : null,
      roomId: chatId ? `chat:${String(chatId)}` : null,
      actorId: normalizedCurrentUserId,
      actorRole: "unknown",
      senderId: normalizedCurrentUserId,
      senderRole: "unknown",
      uiEvent: "none",
      errorMessage: error?.message || "Failed to mark delivered",
      details: {
        messageIds: dedupeIds(messageIds),
      },
    });
    throw error;
  }
};

const getChatInfo = async ({ currentUserId, chatId, mediaLimit = 100, fileLimit = 100, linkLimit = 100 }) => {
  const normalizedCurrentUserId = String(currentUserId || "").trim();
  const normalizedChatId = String(chatId || "").trim();
  if (!normalizedCurrentUserId || !normalizedChatId) {
    throw new RealtimeMessageError("currentUserId and chatId are required", 400);
  }

  const currentUserObjectId = toObjectId(normalizedCurrentUserId, "currentUserId");
  const chatDoc = await Chat.findById(normalizedChatId).populate("members", "_id name role profilePicture");
  if (!chatDoc) {
    throw new RealtimeMessageError("Chat not found", 404);
  }

  const memberIds = (chatDoc.members || []).map((member) => String(member?._id || member?.id));
  if (!memberIds.includes(normalizedCurrentUserId)) {
    throw new RealtimeMessageError("You are not a member of this chat", 403);
  }

  const messages = await ChatMessage.find({
    chatId: toObjectId(normalizedChatId, "chatId"),
    hiddenFor: { $ne: currentUserObjectId },
    isDeleted: false,
  })
    .sort({ createdAt: -1 })
    .limit(Math.max(mediaLimit, fileLimit, linkLimit, 200));

  const media = [];
  const documents = [];
  const links = [];
  const seenLinks = new Set();

  for (const message of messages) {
    const normalizedType = String(message.type || "").toLowerCase();
    const fileUrl = message.fileUrl || message.mediaUrl || null;
    const payload = {
      id: String(message._id),
      messageId: String(message._id),
      type: normalizedType || "text",
      fileUrl,
      mimeType: message.mimeType || null,
      fileName: message.fileName || null,
      fileSize: message.fileSize ?? null,
      senderId: message.senderId ? String(message.senderId) : null,
      createdAt: message.createdAt,
    };

    if (fileUrl) {
      if (["image", "video"].includes(normalizedType) && media.length < mediaLimit) {
        media.push(payload);
      } else if (!["audio", "voice"].includes(normalizedType) && documents.length < fileLimit) {
        documents.push(payload);
      }
    }

    const text = String(message.content || message.text || "");
    const foundLinks = text.match(URL_REGEX) || [];
    for (const item of foundLinks) {
      if (!seenLinks.has(item) && links.length < linkLimit) {
        seenLinks.add(item);
        links.push({
          url: item,
          messageId: String(message._id),
          senderId: message.senderId ? String(message.senderId) : null,
          createdAt: message.createdAt,
        });
      }
    }
  }

  return {
    chat: serializeChat({ chatDoc, currentUserId: normalizedCurrentUserId }),
    members: (chatDoc.members || []).map(serializeMember),
    media,
    documents,
    links,
  };
};

module.exports = {
  buildDirectChatKey,
  canDirectMessageWith,
  createChat,
  listChats,
  sendMessage,
  getMessagesByChat,
  searchMessages,
  getChatInfo,
  markMessagesDelivered,
};
