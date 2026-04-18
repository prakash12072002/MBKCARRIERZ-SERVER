const {
  createChatByContext,
  createChatBroadcastChannelByContext,
  createDirectChatByContext,
  createChatGroupByContext,
  createBroadcastNotifications,
  clearChatChannelMessagesByContext,
  deleteChatChannelByContext,
  addChatGroupMembersByContext,
  removeChatGroupMemberByContext,
  removeChatChannelMemberByContext,
  removeUserFromChatChannelByContext,
  sendChatMessageByContext,
  deleteChatMessageByContext,
  deleteChatMessageForEveryoneByContext,
  deleteChatMessageForMeByContext,
  findChatBootstrapUserById,
  findChatBroadcastActorById,
  findChatCreateActorById,
  findChatDirectActorById,
  getChatWorkspaceFullBootstrapByUser,
  findChatValidationRequesterById,
  getChatWorkspaceQuickBootstrapByUser,
  getChatWorkspaceBootstrapByUser,
  getChatInfoByQuery,
  getChatMessageHistoryByQuery,
  listChatsByQuery,
  listChatChannelAuditLogsByQuery,
  listChatValidationLogsByQuery,
  logChatValidationEventByContext,
  listActiveBroadcastRecipientsByContext,
  sendAnnouncementMessageByContext,
  searchChatMessagesByQuery,
} = require("./chat.repository");
const {
  CHAT_MESSAGE_SEND_SUCCESS_MESSAGE,
  CHAT_BOOTSTRAP_USER_NOT_FOUND_MESSAGE,
  CHAT_CREATE_SUCCESS_MESSAGE,
  CHAT_BROADCAST_INPUT_REQUIRED_MESSAGE,
  CHAT_BROADCAST_NO_RECIPIENTS_MESSAGE,
  CHAT_BROADCAST_RECIPIENT_ROLES,
  CHAT_BROADCAST_USER_NOT_FOUND_MESSAGE,
  CHAT_DELETE_FOR_EVERYONE_SUCCESS_MESSAGE,
  CHAT_DELETE_FOR_ME_SUCCESS_MESSAGE,
  CHAT_VALIDATION_LOGS_USER_NOT_FOUND_MESSAGE,
} = require("./chat.types");
const {
  ALLOWED_MESSAGE_TYPES,
  RealtimeMessageError,
} = require("../../services/realtimeMessageService");

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

const canRequesterViewAllValidationLogs = (role = "") => {
  const roleToken = normalizeRoleToken(role);
  return (
    roleToken.includes("superadmin") ||
    roleToken === "admin" ||
    roleToken.includes("spoc")
  );
};

const createStatusError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const listChatValidationLogsFeed = async ({
  requesterId,
  query = {},
  findRequesterByIdLoader = findChatValidationRequesterById,
  listValidationLogsLoader = listChatValidationLogsByQuery,
} = {}) => {
  const requester = await findRequesterByIdLoader({ requesterId });
  if (!requester) {
    throw createStatusError(404, CHAT_VALIDATION_LOGS_USER_NOT_FOUND_MESSAGE);
  }

  const filters = {
    page: query.page,
    limit: query.limit,
    action: query.action,
    lane: query.lane,
    status: query.status,
    source: query.source,
    chatId: query.chatId,
    roomId: query.roomId,
    channelId: query.channelId,
    senderId: query.senderId,
    role: query.role,
    from: query.from,
    to: query.to,
    userId: canRequesterViewAllValidationLogs(requester.role)
      ? query.userId
      : requesterId,
  };

  const result = await listValidationLogsLoader({ query: filters });
  return {
    success: true,
    ...result,
  };
};

const getChatBootstrapFeed = async ({
  currentUserId,
  findUserByIdLoader = findChatBootstrapUserById,
  createWorkspaceBootstrapLoader = getChatWorkspaceBootstrapByUser,
} = {}) => {
  const user = await findUserByIdLoader({ userId: currentUserId });
  if (!user) {
    throw createStatusError(404, CHAT_BOOTSTRAP_USER_NOT_FOUND_MESSAGE);
  }

  const bootstrap = await createWorkspaceBootstrapLoader({ user });

  return {
    success: true,
    ...bootstrap,
    bootstrap,
    user: bootstrap.currentUser,
    token: bootstrap.token,
  };
};

const getChatQuickBootstrapFeed = async ({
  currentUserId,
  findUserByIdLoader = findChatBootstrapUserById,
  createWorkspaceQuickBootstrapLoader = getChatWorkspaceQuickBootstrapByUser,
} = {}) => {
  const user = await findUserByIdLoader({ userId: currentUserId });
  if (!user) {
    throw createStatusError(404, CHAT_BOOTSTRAP_USER_NOT_FOUND_MESSAGE);
  }
  const bootstrap = await createWorkspaceQuickBootstrapLoader({ user });

  return {
    success: true,
    ...bootstrap,
    bootstrap,
    user: bootstrap.currentUser,
    token: bootstrap.token,
  };
};

const getChatFullBootstrapFeed = async ({
  currentUserId,
  findUserByIdLoader = findChatBootstrapUserById,
  createWorkspaceFullBootstrapLoader = getChatWorkspaceFullBootstrapByUser,
} = {}) => {
  const user = await findUserByIdLoader({ userId: currentUserId });
  if (!user) {
    throw createStatusError(404, CHAT_BOOTSTRAP_USER_NOT_FOUND_MESSAGE);
  }
  const bootstrap = await createWorkspaceFullBootstrapLoader({ user });

  return {
    success: true,
    ...bootstrap,
  };
};

const createChatFeed = async ({
  currentUserId,
  payload = {},
  findChatActorLoader = findChatCreateActorById,
  createChatLoader = createChatByContext,
} = {}) => {
  const user = await findChatActorLoader({ userId: currentUserId });
  if (!user) {
    throw createStatusError(404, CHAT_BOOTSTRAP_USER_NOT_FOUND_MESSAGE);
  }

  const chat = await createChatLoader({
    currentUser: user,
    payload,
  });

  return {
    success: true,
    message: CHAT_CREATE_SUCCESS_MESSAGE,
    data: chat,
  };
};

const createDirectChatFeed = async ({
  currentUserId,
  payload = {},
  findChatActorLoader = findChatDirectActorById,
  createDirectChatLoader = createDirectChatByContext,
} = {}) => {
  const user = await findChatActorLoader({ userId: currentUserId });
  const result = await createDirectChatLoader({
    currentUser: user,
    payload,
  });

  return {
    success: true,
    ...result,
  };
};

const createChatGroupFeed = async ({
  currentUserId,
  payload = {},
  findChatActorLoader = findChatDirectActorById,
  createGroupChatLoader = createChatGroupByContext,
} = {}) => {
  const currentUser = await findChatActorLoader({ userId: currentUserId });
  const result = await createGroupChatLoader({
    currentUser,
    payload,
  });

  return {
    success: true,
    ...result,
  };
};

const createChatBroadcastFeed = async ({
  io,
  currentUserId,
  payload = {},
  findChatActorLoader = findChatBroadcastActorById,
  listBroadcastRecipientsLoader = listActiveBroadcastRecipientsByContext,
  createBroadcastNotificationsLoader = createBroadcastNotifications,
  sendAnnouncementLoader = sendAnnouncementMessageByContext,
  createBroadcastChannelLoader = createChatBroadcastChannelByContext,
  logValidationLoader = logChatValidationEventByContext,
  emitRealtimeLoader = ({ io: ioInstance, eventName, eventPayload }) =>
    ioInstance?.emit(eventName, eventPayload),
  nowLoader = () => Date.now(),
  isoDateLoader = () => new Date().toISOString(),
} = {}) => {
  const user = await findChatActorLoader({ userId: currentUserId });
  if (!user) {
    return {
      statusCode: 404,
      responsePayload: { message: CHAT_BROADCAST_USER_NOT_FOUND_MESSAGE },
    };
  }

  const actorId = String(user._id || user.id || "");
  const actorName = user.name || user.email || "Admin";
  const actorRole = user.role || "SuperAdmin";

  try {
    const { text, attachments } = normalizeAnnouncementInput(payload);

    if (text) {
      const recipients = await listBroadcastRecipientsLoader({
        roles: CHAT_BROADCAST_RECIPIENT_ROLES,
        excludeUserId: user._id,
      });

      if (!recipients.length) {
        return {
          statusCode: 400,
          responsePayload: { message: CHAT_BROADCAST_NO_RECIPIENTS_MESSAGE },
        };
      }

      await createBroadcastNotificationsLoader({
        notifications: recipients.map((recipient) => ({
          userId: recipient._id,
          role: recipient.role,
          title: "Admin Broadcast",
          message: text,
          type: "Announcement",
          link: "/chat",
          isRead: false,
        })),
      });

      let streamMessageId = null;
      try {
        const streamResult = await sendAnnouncementLoader({
          currentUser: user,
          payload: { text, attachments },
        });
        streamMessageId = streamResult?.messageId || null;
      } catch (streamError) {
        void logValidationLoader({
          payload: {
            source: "api",
            action: "broadcast",
            event: "announcement_stream_publish_degraded",
            status: "failed",
            lane: "broadcast",
            actorId,
            actorName,
            actorRole,
            senderId: actorId,
            senderRole: actorRole,
            targetUserIds: recipients.map((recipient) => String(recipient._id)),
            uiEvent: "none",
            errorMessage:
              streamError?.message ||
              String(streamError || "Stream channel publish failed"),
            details: {
              message: text,
              mode: "announcement",
              fallback: "notification_and_socket_only",
            },
          },
        });
      }

      const sentAt = isoDateLoader();
      emitRealtimeLoader({
        io: io,
        eventName: "receive_message",
        eventPayload: {
          kind: "admin_broadcast",
          broadcastId: streamMessageId || `broadcast-${nowLoader()}`,
          title: "Admin Broadcast",
          message: text,
          type: "Announcement",
          link: "/chat",
          sentAt,
          sender: {
            id: actorId,
            name: actorName,
            role: user.role,
          },
          targetRoles: CHAT_BROADCAST_RECIPIENT_ROLES,
        },
      });

      await logValidationLoader({
        payload: {
          source: "api",
          action: "broadcast",
          event: "announcement_sent",
          status: "success",
          lane: "broadcast",
          actorId,
          actorName,
          actorRole,
          senderId: actorId,
          senderRole: actorRole,
          targetUserIds: recipients.map((recipient) => String(recipient._id)),
          uiEvent: "receive_message",
          details: {
            message: text,
            streamMessageId,
            recipientsResolved: recipients.length,
          },
        },
      });

      return {
        statusCode: 200,
        responsePayload: {
          success: true,
          mode: "announcement",
          recipientsResolved: recipients.length,
          streamMessageId,
          socketEvent: "receive_message",
        },
      };
    }

    const name = String(payload?.name || "").trim();
    const description = String(payload?.description || "").trim();

    if (!name) {
      return {
        statusCode: 400,
        responsePayload: { message: CHAT_BROADCAST_INPUT_REQUIRED_MESSAGE },
      };
    }

    const result = await createBroadcastChannelLoader({
      currentUser: user,
      payload: { name, description },
    });

    await logValidationLoader({
      payload: {
        source: "api",
        action: "broadcast",
        event: "broadcast_channel_created",
        status: "success",
        lane: "broadcast",
        channelId: result?.channelId || null,
        actorId,
        actorName,
        actorRole,
        senderId: actorId,
        senderRole: actorRole,
        targetUserIds: Array.isArray(result?.members) ? result.members.map(String) : [],
        uiEvent: "sidebar_refresh",
        details: {
          name,
          description,
        },
      },
    });

    return {
      statusCode: 200,
      responsePayload: {
        success: true,
        mode: "channel",
        ...result,
      },
    };
  } catch (error) {
    await logValidationLoader({
      payload: {
        source: "api",
        action: "broadcast",
        event: "broadcast_failed",
        status: "failed",
        lane: "broadcast",
        actorId: String(currentUserId || ""),
        senderId: String(currentUserId || ""),
        uiEvent: "none",
        errorMessage: error?.message || "Broadcast failed",
      },
    });
    throw error;
  }
};

const sendChatMessageFeed = async ({
  io,
  currentUserId,
  payload = {},
  findChatActorLoader = findChatCreateActorById,
  sendChatMessageLoader = sendChatMessageByContext,
  allowedTypes = Array.from(ALLOWED_MESSAGE_TYPES),
} = {}) => {
  const currentUser = await findChatActorLoader({ userId: currentUserId });
  if (!currentUser) {
    throw new RealtimeMessageError(CHAT_BOOTSTRAP_USER_NOT_FOUND_MESSAGE, 404);
  }

  const savedMessage = await sendChatMessageLoader({
    io,
    currentUser,
    payload,
  });

  return {
    success: true,
    message: CHAT_MESSAGE_SEND_SUCCESS_MESSAGE,
    allowedTypes,
    data: savedMessage,
  };
};

const deleteChatMessageForMeFeed = async ({
  io,
  actorId,
  messageId,
  deleteMessageForMeLoader = deleteChatMessageForMeByContext,
} = {}) => {
  const result = await deleteMessageForMeLoader({
    io,
    actorId,
    messageId,
  });

  return {
    success: true,
    message: CHAT_DELETE_FOR_ME_SUCCESS_MESSAGE,
    data: result,
  };
};

const deleteChatMessageForEveryoneFeed = async ({
  io,
  actorId,
  messageId,
  deleteMessageForEveryoneLoader = deleteChatMessageForEveryoneByContext,
} = {}) => {
  const result = await deleteMessageForEveryoneLoader({
    io,
    actorId,
    messageId,
  });

  return {
    success: true,
    message: CHAT_DELETE_FOR_EVERYONE_SUCCESS_MESSAGE,
    data: result,
  };
};

const deleteChatMessageFeed = async ({
  currentUserId,
  messageId,
  deleteMessageLoader = deleteChatMessageByContext,
} = {}) => {
  const result = await deleteMessageLoader({
    currentUserId,
    messageId,
  });

  return {
    success: true,
    ...result,
  };
};

const leaveChatChannelFeed = async ({
  currentUserId,
  channelId,
  type,
  findChatActorLoader = findChatDirectActorById,
  removeChannelMemberLoader = removeChatChannelMemberByContext,
} = {}) => {
  const currentUser = await findChatActorLoader({ userId: currentUserId });
  const memberId = currentUser._id.toString();
  const result = await removeChannelMemberLoader({
    currentUser,
    channelId,
    memberId,
    type,
  });

  return {
    success: true,
    ...result,
  };
};

const removeUserFromChatChannelFeed = async ({
  currentUserId,
  channelId,
  memberId,
  type,
  findChatActorLoader = findChatDirectActorById,
  removeUserFromChannelLoader = removeUserFromChatChannelByContext,
} = {}) => {
  const currentUser = await findChatActorLoader({ userId: currentUserId });
  const result = await removeUserFromChannelLoader({
    currentUser,
    channelId,
    memberId,
    type,
  });

  return {
    success: true,
    ...result,
  };
};

const clearChatChannelMessagesFeed = async ({
  currentUserId,
  channelId,
  type,
  findChatActorLoader = findChatDirectActorById,
  clearChannelMessagesLoader = clearChatChannelMessagesByContext,
} = {}) => {
  const currentUser = await findChatActorLoader({ userId: currentUserId });
  const result = await clearChannelMessagesLoader({
    currentUser,
    channelId,
    type,
  });

  return {
    success: true,
    ...result,
  };
};

const deleteChatChannelFeed = async ({
  currentUserId,
  channelId,
  type = "messaging",
  findChatActorLoader = findChatDirectActorById,
  deleteChatChannelLoader = deleteChatChannelByContext,
} = {}) => {
  const currentUser = await findChatActorLoader({ userId: currentUserId });
  const result = await deleteChatChannelLoader({
    currentUser,
    channelId,
    type,
  });

  return {
    success: true,
    ...result,
  };
};

const removeChatGroupMemberFeed = async ({
  currentUserId,
  groupId,
  userIdToRemove,
  findChatActorLoader = findChatDirectActorById,
  removeGroupMemberLoader = removeChatGroupMemberByContext,
} = {}) => {
  const currentUser = await findChatActorLoader({ userId: currentUserId });
  const result = await removeGroupMemberLoader({
    currentUser,
    groupId,
    userIdToRemove,
  });

  return {
    success: true,
    ...result,
  };
};

const addChatGroupMembersFeed = async ({
  currentUserId,
  groupId,
  memberIds,
  findChatActorLoader = findChatDirectActorById,
  addGroupMembersLoader = addChatGroupMembersByContext,
} = {}) => {
  const currentUser = await findChatActorLoader({ userId: currentUserId });
  const result = await addGroupMembersLoader({
    currentUser,
    groupId,
    memberIds,
  });

  return {
    success: true,
    ...result,
  };
};

const listChatSearchFeed = async ({
  currentUserId,
  query = {},
  searchChatMessagesLoader = searchChatMessagesByQuery,
} = {}) => {
  const result = await searchChatMessagesLoader({
    query: {
      currentUserId,
      search: query.search,
      page: query.page,
      limit: query.limit,
    },
  });

  return {
    success: true,
    ...result,
  };
};

const listChatMessageSearchFeed = async ({
  currentUserId,
  query = {},
  searchChatMessagesLoader = searchChatMessagesByQuery,
} = {}) => {
  const result = await searchChatMessagesLoader({
    query: {
      currentUserId,
      search: query.search,
      page: query.page,
      limit: query.limit,
    },
  });

  return {
    success: true,
    ...result,
  };
};

const listChatChannelAuditLogFeed = async ({
  channelId,
  query = {},
  listChannelAuditLogsLoader = listChatChannelAuditLogsByQuery,
} = {}) => {
  const result = await listChannelAuditLogsLoader({
    query: {
      channelId,
      limit: query.limit,
      page: query.page,
    },
  });

  return {
    success: true,
    logs: result?.data || [],
    total: result?.total || 0,
  };
};

const getChatInfoFeed = async ({
  currentUserId,
  chatId,
  query = {},
  getChatInfoLoader = getChatInfoByQuery,
} = {}) => {
  const result = await getChatInfoLoader({
    query: {
      currentUserId,
      chatId,
      mediaLimit: query.mediaLimit,
      fileLimit: query.fileLimit,
      linkLimit: query.linkLimit,
    },
  });

  return {
    success: true,
    data: result,
  };
};

const listChatMessageHistoryFeed = async ({
  currentUserId,
  otherUserId,
  query = {},
  getChatMessageHistoryLoader = getChatMessageHistoryByQuery,
} = {}) => {
  const result = await getChatMessageHistoryLoader({
    query: {
      currentUserId,
      otherUserId,
      page: query.page,
      limit: query.limit,
    },
  });

  return {
    success: true,
    ...result,
  };
};

const listChatListFeed = async ({
  currentUserId,
  query = {},
  listChatsLoader = listChatsByQuery,
} = {}) => {
  const result = await listChatsLoader({
    query: {
      currentUserId,
      search: query.search,
      page: query.page,
      limit: query.limit,
    },
  });

  return {
    success: true,
    ...result,
  };
};

module.exports = {
  canRequesterViewAllValidationLogs,
  createChatFeed,
  createDirectChatFeed,
  createChatGroupFeed,
  createChatBroadcastFeed,
  leaveChatChannelFeed,
  removeUserFromChatChannelFeed,
  clearChatChannelMessagesFeed,
  deleteChatChannelFeed,
  addChatGroupMembersFeed,
  removeChatGroupMemberFeed,
  sendChatMessageFeed,
  deleteChatMessageFeed,
  deleteChatMessageForEveryoneFeed,
  deleteChatMessageForMeFeed,
  getChatBootstrapFeed,
  getChatFullBootstrapFeed,
  getChatQuickBootstrapFeed,
  getChatInfoFeed,
  listChatListFeed,
  listChatChannelAuditLogFeed,
  listChatMessageHistoryFeed,
  listChatMessageSearchFeed,
  listChatSearchFeed,
  listChatValidationLogsFeed,
};
