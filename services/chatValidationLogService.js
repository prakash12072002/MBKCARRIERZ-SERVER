const ChatAuditLog = require("../models/ChatAuditLog");
const Chat = require("../models/Chat");

const normalizeRoleToken = (value = "") =>
  String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");

const normalizePortalRole = (value = "") => {
  const token = normalizeRoleToken(value);
  if (token.includes("superadmin") || token === "admin") return "superadmin";
  if (token.includes("spoc") || token.includes("collegeadmin")) return "spoc";
  if (token.includes("trainer")) return "trainer";
  return "unknown";
};

const toCleanString = (value) => {
  if (value === null || value === undefined) return null;
  const output = String(value).trim();
  return output || null;
};

const toUniqueStringArray = (values = []) =>
  Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map(toCleanString)
        .filter(Boolean),
    ),
  );

const detectLane = ({ lane, chatKey, isGroup, roomId, channelId, action }) => {
  const explicitLane = toCleanString(lane);
  if (explicitLane && ["chat", "group", "broadcast", "system", "unknown"].includes(explicitLane)) {
    return explicitLane;
  }

  const normalizedChatKey = String(chatKey || "").toLowerCase();
  const normalizedRoomId = String(roomId || "").toLowerCase();
  const normalizedChannelId = String(channelId || "").toLowerCase();
  const normalizedAction = String(action || "").toLowerCase();

  if (
    normalizedChatKey.startsWith("broadcast:") ||
    normalizedRoomId.includes("broadcast") ||
    normalizedChannelId.includes("broadcast")
  ) {
    return "broadcast";
  }

  if (isGroup === true) return "group";
  if (normalizedRoomId.startsWith("direct:")) return "chat";
  if (normalizedAction === "typing" || normalizedAction === "online_users" || normalizedAction === "connect" || normalizedAction === "disconnect") {
    return "system";
  }
  return "chat";
};

const resolveLaneByChatId = async (chatId) => {
  const normalizedChatId = toCleanString(chatId);
  if (!normalizedChatId) return { lane: "unknown", chatKey: null, isGroup: null };

  try {
    const chatDoc = await Chat.findById(normalizedChatId).select("chatKey isGroup");
    if (!chatDoc) return { lane: "unknown", chatKey: null, isGroup: null };
    return {
      lane: detectLane({
        chatKey: chatDoc.chatKey,
        isGroup: Boolean(chatDoc.isGroup),
      }),
      chatKey: chatDoc.chatKey || null,
      isGroup: Boolean(chatDoc.isGroup),
    };
  } catch (_error) {
    return { lane: "unknown", chatKey: null, isGroup: null };
  }
};

const logChatValidation = async (payload = {}) => {
  const actorRole = toCleanString(payload.actorRole || payload.senderRole);
  const senderRole = toCleanString(payload.senderRole || payload.actorRole);
  const actorId = toCleanString(payload.actorId || payload.senderId || payload.userId);
  const senderId = toCleanString(payload.senderId || payload.actorId || payload.userId);
  const messageId = toCleanString(payload.messageId);
  const chatId = toCleanString(payload.chatId);
  const roomId = toCleanString(payload.roomId);
  const channelId = toCleanString(payload.channelId);
  const resolvedByChat = payload.resolveLaneWithChatId && chatId
    ? await resolveLaneByChatId(chatId)
    : { lane: "unknown", chatKey: null, isGroup: null };

  const lane = detectLane({
    lane: payload.lane || resolvedByChat.lane,
    chatKey: payload.chatKey || resolvedByChat.chatKey,
    isGroup: payload.isGroup ?? resolvedByChat.isGroup,
    roomId,
    channelId,
    action: payload.action,
  });

  const docPayload = {
    messageId,
    channelId,
    chatId,
    roomId,
    action: toCleanString(payload.action || "trace"),
    event: toCleanString(payload.event),
    status: ["success", "failed", "info"].includes(payload.status) ? payload.status : "info",
    lane,
    source: ["api", "socket", "stream", "system"].includes(payload.source) ? payload.source : "system",
    actorId: actorId || "system",
    actorName: toCleanString(payload.actorName),
    actorRole: actorRole || normalizePortalRole(payload.actorRole),
    senderId,
    senderRole: senderRole || normalizePortalRole(payload.senderRole),
    targetUserIds: toUniqueStringArray(payload.targetUserIds),
    uiEvent: toCleanString(payload.uiEvent),
    details: payload.details && typeof payload.details === "object" ? payload.details : {},
    errorMessage: toCleanString(payload.errorMessage),
    timestamp: payload.timestamp instanceof Date ? payload.timestamp : new Date(),
  };

  const saved = await ChatAuditLog.create(docPayload);

  if (String(process.env.CHAT_VALIDATION_LOG_CONSOLE || "true").toLowerCase() !== "false") {
    const preview = {
      action: saved.action,
      event: saved.event,
      status: saved.status,
      lane: saved.lane,
      source: saved.source,
      actorId: saved.actorId,
      actorRole: saved.actorRole,
      senderId: saved.senderId,
      targetUserIds: saved.targetUserIds,
      chatId: saved.chatId,
      messageId: saved.messageId,
      uiEvent: saved.uiEvent,
      errorMessage: saved.errorMessage,
      at: saved.timestamp,
    };
    console.info("[chat-validation]", JSON.stringify(preview));
  }

  return saved;
};

const logChatValidationSafe = async (payload = {}) => {
  try {
    await logChatValidation(payload);
  } catch (error) {
    console.warn("[chat-validation] failed to persist log:", error?.message || error);
  }
};

const listChatValidationLogs = async ({
  page = 1,
  limit = 100,
  action,
  lane,
  status,
  source,
  chatId,
  roomId,
  channelId,
  userId,
  senderId,
  role,
  from,
  to,
} = {}) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const query = {};

  if (toCleanString(action)) query.action = toCleanString(action);
  if (toCleanString(lane)) query.lane = toCleanString(lane);
  if (toCleanString(status)) query.status = toCleanString(status);
  if (toCleanString(source)) query.source = toCleanString(source);
  if (toCleanString(chatId)) query.chatId = toCleanString(chatId);
  if (toCleanString(roomId)) query.roomId = toCleanString(roomId);
  if (toCleanString(channelId)) query.channelId = toCleanString(channelId);
  if (toCleanString(senderId)) query.senderId = toCleanString(senderId);
  if (toCleanString(role)) query.$or = [{ actorRole: toCleanString(role) }, { senderRole: toCleanString(role) }];

  if (toCleanString(userId)) {
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { actorId: toCleanString(userId) },
        { senderId: toCleanString(userId) },
        { targetUserIds: toCleanString(userId) },
      ],
    });
  }

  const fromDate = toCleanString(from) ? new Date(String(from)) : null;
  const toDate = toCleanString(to) ? new Date(String(to)) : null;
  if (fromDate || toDate) {
    query.timestamp = {};
    if (fromDate && !Number.isNaN(fromDate.getTime())) query.timestamp.$gte = fromDate;
    if (toDate && !Number.isNaN(toDate.getTime())) query.timestamp.$lte = toDate;
    if (!Object.keys(query.timestamp).length) delete query.timestamp;
  }

  const [data, total] = await Promise.all([
    ChatAuditLog.find(query)
      .sort({ timestamp: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    ChatAuditLog.countDocuments(query),
  ]);

  return {
    total,
    page: safePage,
    limit: safeLimit,
    data,
  };
};

module.exports = {
  detectLane,
  normalizePortalRole,
  logChatValidation,
  logChatValidationSafe,
  listChatValidationLogs,
};
