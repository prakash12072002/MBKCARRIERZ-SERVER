const {
  parseChatBootstrapContext,
  parseChatCreateBody,
  parseChatCreateContext,
  parseChatMessageSendBody,
  parseChatMessageSendContext,
  parseChatDeleteForEveryoneContext,
  parseChatDeleteForEveryoneParams,
  parseChatDeleteMessageContext,
  parseChatDeleteMessageParams,
  parseChatChannelLeaveContext,
  parseChatChannelLeaveParams,
  parseChatChannelLeaveQuery,
  parseChatChannelRemoveUserContext,
  parseChatChannelRemoveUserParams,
  parseChatChannelRemoveUserQuery,
  parseChatChannelClearMessagesContext,
  parseChatChannelClearMessagesParams,
  parseChatChannelClearMessagesQuery,
  parseChatChannelDeleteContext,
  parseChatChannelDeleteParams,
  parseChatChannelDeleteQuery,
  parseChatGroupRemoveMemberContext,
  parseChatGroupRemoveMemberParams,
  parseChatGroupAddMembersContext,
  parseChatGroupAddMembersParams,
  parseChatGroupAddMembersBody,
  parseChatDeleteForMeContext,
  parseChatDeleteForMeParams,
  parseChatBroadcastBody,
  parseChatBroadcastContext,
  parseChatDirectBody,
  parseChatDirectContext,
  parseChatGroupCreateBody,
  parseChatGroupCreateContext,
  parseChatChannelAuditLogParams,
  parseChatChannelAuditLogQuery,
  parseChatInfoContext,
  parseChatInfoParams,
  parseChatInfoQuery,
  parseChatListContext,
  parseChatListQuery,
  parseChatMessageHistoryContext,
  parseChatMessageHistoryParams,
  parseChatMessageHistoryQuery,
  parseChatMessageSearchContext,
  parseChatMessageSearchQuery,
  parseChatSearchContext,
  parseChatSearchQuery,
  parseChatValidationLogsContext,
  parseChatValidationLogsQuery,
} = require("./chat.schema");
const {
  createChatFeed,
  clearChatChannelMessagesFeed,
  deleteChatChannelFeed,
  addChatGroupMembersFeed,
  removeChatGroupMemberFeed,
  deleteChatMessageFeed,
  leaveChatChannelFeed,
  removeUserFromChatChannelFeed,
  sendChatMessageFeed,
  createChatBroadcastFeed,
  createDirectChatFeed,
  createChatGroupFeed,
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
} = require("./chat.service");
const {
  CHAT_CHANNEL_AUDIT_LOG_FETCH_FAILED_MESSAGE,
  CHAT_CREATE_FAILED_MESSAGE,
  CHAT_DELETE_FOR_EVERYONE_FAILED_MESSAGE,
  CHAT_DELETE_FOR_ME_FAILED_MESSAGE,
  CHAT_INFO_FETCH_FAILED_MESSAGE,
  CHAT_LIST_FETCH_FAILED_MESSAGE,
  CHAT_MESSAGE_HISTORY_FETCH_FAILED_MESSAGE,
  CHAT_MESSAGE_SEND_FAILED_MESSAGE,
  CHAT_MESSAGE_SEARCH_FETCH_FAILED_MESSAGE,
  CHAT_MESSAGE_SEARCH_QUERY_REQUIRED_MESSAGE,
  CHAT_SEARCH_QUERY_REQUIRED_MESSAGE,
  CHAT_VALIDATION_LOGS_FETCH_FAILED_MESSAGE,
} = require("./chat.types");
const { RealtimeMessageError } = require("../../services/realtimeMessageService");
const {
  createStructuredLogger,
} = require("../../shared/utils/structuredLogger");
const { logControllerError } = require("../../shared/utils/controllerTelemetry");

const chatControllerLogger = createStructuredLogger({
  service: "chat",
  component: "controller",
});

const logChatControllerError = (req, stage, error, fields = {}) =>
  logControllerError(chatControllerLogger, {
    req,
    stage,
    error,
    fields,
    correlationPrefix: "chat_ctrl",
  });

const createChatValidationLogsController = ({
  getChatValidationLogsFeed = listChatValidationLogsFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatValidationLogsContext(req.user);
    const query = parseChatValidationLogsQuery(req.query);
    const payload = await getChatValidationLogsFeed({
      requesterId: context.requesterId,
      query,
    });

    return res.json(payload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
      });
    }

    logChatControllerError(req, "list_chat_validation_logs_failed", error);
    return res.status(500).json({
      success: false,
      message: error?.message || CHAT_VALIDATION_LOGS_FETCH_FAILED_MESSAGE,
    });
  }
};

const createChatCreateController = ({
  getChatCreatePayload = createChatFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatCreateContext(req.user);
    const payload = parseChatCreateBody(req.body);

    const responsePayload = await getChatCreatePayload({
      currentUserId: context.currentUserId,
      payload,
    });

    return res.status(201).json(responsePayload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : (error?.statusCode || 500);

    if (status >= 500) {
      logChatControllerError(req, "create_chat_failed", error);
    }

    return res.status(status).json({
      success: false,
      message: error?.message || CHAT_CREATE_FAILED_MESSAGE,
    });
  }
};

const createChatDirectController = ({
  getChatDirectPayload = createDirectChatFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatDirectContext(req.user);
    const payload = parseChatDirectBody(req.body);

    const responsePayload = await getChatDirectPayload({
      currentUserId: context.currentUserId,
      payload,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;
    if (status >= 500) {
      logChatControllerError(req, "create_direct_chat_failed", error);
    }
    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatBroadcastController = ({
  getChatBroadcastPayload = createChatBroadcastFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatBroadcastContext(req.user);
    const payload = parseChatBroadcastBody(req.body);

    const { statusCode, responsePayload } = await getChatBroadcastPayload({
      io: req.io,
      currentUserId: context.currentUserId,
      payload,
    });

    return res.status(statusCode || 200).json(responsePayload);
  } catch (error) {
    logChatControllerError(req, "create_chat_broadcast_failed", error);
    return res.status(500).json({
      message: error?.message,
    });
  }
};

const createChatGroupCreateController = ({
  getChatGroupCreatePayload = createChatGroupFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatGroupCreateContext(req.user);
    const payload = parseChatGroupCreateBody(req.body);

    const responsePayload = await getChatGroupCreatePayload({
      currentUserId: context.currentUserId,
      payload,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;
    if (status >= 500) {
      logChatControllerError(req, "create_chat_group_failed", error);
    }
    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatDeleteForMeController = ({
  getChatDeleteForMePayload = deleteChatMessageForMeFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatDeleteForMeContext(req.user);
    const params = parseChatDeleteForMeParams(req.params);

    const responsePayload = await getChatDeleteForMePayload({
      io: req.io,
      actorId: context.actorId,
      messageId: params.messageId,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : 500;

    if (status >= 500) {
      logChatControllerError(req, "delete_chat_message_for_me_failed", error, {
        messageId: String(req.params?.messageId || "").trim() || null,
      });
    }

    return res.status(status).json({
      success: false,
      message: error?.message || CHAT_DELETE_FOR_ME_FAILED_MESSAGE,
    });
  }
};

const createChatDeleteForEveryoneController = ({
  getChatDeleteForEveryonePayload = deleteChatMessageForEveryoneFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatDeleteForEveryoneContext(req.user);
    const params = parseChatDeleteForEveryoneParams(req.params);

    const responsePayload = await getChatDeleteForEveryonePayload({
      io: req.io,
      actorId: context.actorId,
      messageId: params.messageId,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : 500;

    if (status >= 500) {
      logChatControllerError(req, "delete_chat_message_for_everyone_failed", error, {
        messageId: String(req.params?.messageId || "").trim() || null,
      });
    }

    return res.status(status).json({
      success: false,
      message: error?.message || CHAT_DELETE_FOR_EVERYONE_FAILED_MESSAGE,
    });
  }
};

const createChatDeleteMessageController = ({
  getChatDeleteMessagePayload = deleteChatMessageFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatDeleteMessageContext(req.user);
    const params = parseChatDeleteMessageParams(req.params);

    const responsePayload = await getChatDeleteMessagePayload({
      currentUserId: context.currentUserId,
      messageId: params.messageId,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;

    if (status >= 500) {
      logChatControllerError(req, "delete_chat_message_failed", error, {
        messageId: String(req.params?.messageId || "").trim() || null,
      });
    }

    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatChannelLeaveController = ({
  getChatChannelLeavePayload = leaveChatChannelFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatChannelLeaveContext(req.user);
    const params = parseChatChannelLeaveParams(req.params);
    const query = parseChatChannelLeaveQuery(req.query);

    const responsePayload = await getChatChannelLeavePayload({
      currentUserId: context.currentUserId,
      channelId: params.channelId,
      type: query.type,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;

    if (status >= 500) {
      logChatControllerError(req, "leave_chat_channel_failed", error, {
        channelId: String(req.params?.channelId || "").trim() || null,
      });
    }

    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatChannelClearMessagesController = ({
  getChatChannelClearMessagesPayload = clearChatChannelMessagesFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatChannelClearMessagesContext(req.user);
    const params = parseChatChannelClearMessagesParams(req.params);
    const query = parseChatChannelClearMessagesQuery(req.query);

    const responsePayload = await getChatChannelClearMessagesPayload({
      currentUserId: context.currentUserId,
      channelId: params.channelId,
      type: query.type,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;

    if (status >= 500) {
      logChatControllerError(req, "clear_chat_channel_messages_failed", error, {
        channelId: String(req.params?.channelId || "").trim() || null,
      });
    }

    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatChannelDeleteController = ({
  getChatChannelDeletePayload = deleteChatChannelFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatChannelDeleteContext(req.user);
    const params = parseChatChannelDeleteParams(req.params);
    const query = parseChatChannelDeleteQuery(req.query);

    const responsePayload = await getChatChannelDeletePayload({
      currentUserId: context.currentUserId,
      channelId: params.channelId,
      type: query.type,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;

    if (status >= 500) {
      logChatControllerError(req, "delete_chat_channel_failed", error, {
        channelId: String(req.params?.channelId || "").trim() || null,
      });
    }

    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatChannelRemoveUserController = ({
  getChatChannelRemoveUserPayload = removeUserFromChatChannelFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatChannelRemoveUserContext(req.user);
    const params = parseChatChannelRemoveUserParams(req.params);
    const query = parseChatChannelRemoveUserQuery(req.query);

    const responsePayload = await getChatChannelRemoveUserPayload({
      currentUserId: context.currentUserId,
      channelId: params.channelId,
      memberId: params.memberId,
      type: query.type,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;

    if (status >= 500) {
      logChatControllerError(req, "remove_user_from_chat_channel_failed", error, {
        channelId: String(req.params?.channelId || "").trim() || null,
        memberId: String(req.params?.memberId || "").trim() || null,
      });
    }

    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatGroupRemoveMemberController = ({
  getChatGroupRemoveMemberPayload = removeChatGroupMemberFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatGroupRemoveMemberContext(req.user);
    const params = parseChatGroupRemoveMemberParams(req.params);

    const responsePayload = await getChatGroupRemoveMemberPayload({
      currentUserId: context.currentUserId,
      groupId: params.groupId,
      userIdToRemove: params.userIdToRemove,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;

    if (status >= 500) {
      logChatControllerError(req, "remove_member_from_chat_group_failed", error, {
        groupId: String(req.params?.id || "").trim() || null,
        userIdToRemove: String(req.params?.userId || "").trim() || null,
      });
    }

    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatGroupAddMembersController = ({
  getChatGroupAddMembersPayload = addChatGroupMembersFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatGroupAddMembersContext(req.user);
    const params = parseChatGroupAddMembersParams(req.params);
    const payload = parseChatGroupAddMembersBody(req.body);

    const responsePayload = await getChatGroupAddMembersPayload({
      currentUserId: context.currentUserId,
      groupId: params.groupId,
      memberIds: payload.memberIds,
    });

    return res.json(responsePayload);
  } catch (error) {
    const status = error?.statusCode || 500;

    if (status >= 500) {
      logChatControllerError(req, "add_members_to_chat_group_failed", error, {
        groupId: String(req.params?.id || "").trim() || null,
      });
    }

    return res.status(status).json({
      message: error?.message,
    });
  }
};

const createChatMessageSendController = ({
  getChatMessageSendPayload = sendChatMessageFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatMessageSendContext(req.user);
    const payload = parseChatMessageSendBody(req.body);

    const responsePayload = await getChatMessageSendPayload({
      io: req.io,
      currentUserId: context.currentUserId,
      payload,
    });

    return res.status(201).json(responsePayload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : 500;

    if (status >= 500) {
      logChatControllerError(req, "send_chat_message_failed", error);
    }

    return res.status(status).json({
      success: false,
      message: error?.message || CHAT_MESSAGE_SEND_FAILED_MESSAGE,
    });
  }
};

const createChatBootstrapController = ({
  getChatBootstrapPayload = getChatBootstrapFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatBootstrapContext(req.user);
    const payload = await getChatBootstrapPayload({
      currentUserId: context.currentUserId,
    });

    return res.json(payload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        message: error.message,
      });
    }

    logChatControllerError(req, "get_chat_bootstrap_failed", error);
    return res.status(500).json({
      message: error?.message,
    });
  }
};

const createChatQuickBootstrapController = ({
  getChatQuickBootstrapPayload = getChatQuickBootstrapFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatBootstrapContext(req.user);
    const payload = await getChatQuickBootstrapPayload({
      currentUserId: context.currentUserId,
    });

    return res.json(payload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        message: error.message,
      });
    }

    logChatControllerError(req, "get_chat_quick_bootstrap_failed", error);
    return res.status(500).json({
      message: error?.message,
    });
  }
};

const createChatFullBootstrapController = ({
  getChatFullBootstrapPayload = getChatFullBootstrapFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatBootstrapContext(req.user);
    const payload = await getChatFullBootstrapPayload({
      currentUserId: context.currentUserId,
    });

    return res.json(payload);
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        message: error.message,
      });
    }

    logChatControllerError(req, "get_chat_full_bootstrap_failed", error);
    return res.status(500).json({
      message: error?.message,
    });
  }
};

const createChatListController = ({
  getChatListFeed = listChatListFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatListContext(req.user);
    const query = parseChatListQuery(req.query);

    const payload = await getChatListFeed({
      currentUserId: context.currentUserId,
      query,
    });

    return res.json(payload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : 500;

    if (status >= 500) {
      logChatControllerError(req, "list_chat_feed_failed", error);
    }

    return res.status(status).json({
      success: false,
      message: error?.message || CHAT_LIST_FETCH_FAILED_MESSAGE,
    });
  }
};

const createChatSearchController = ({
  getChatSearchFeed = listChatSearchFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatSearchContext(req.user);
    const query = parseChatSearchQuery(req.query);

    if (!String(query.search || "").trim()) {
      return res.status(400).json({
        success: false,
        message: CHAT_SEARCH_QUERY_REQUIRED_MESSAGE,
      });
    }

    const payload = await getChatSearchFeed({
      currentUserId: context.currentUserId,
      query,
    });

    return res.json(payload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : 500;

    if (status >= 500) {
      logChatControllerError(req, "search_chat_messages_failed", error);
    }

    return res.status(status).json({
      success: false,
      message: error?.message,
    });
  }
};

const createChatMessageSearchController = ({
  getChatMessageSearchFeed = listChatMessageSearchFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatMessageSearchContext(req.user);
    const query = parseChatMessageSearchQuery(req.query);

    if (!String(query.search || "").trim()) {
      return res.status(400).json({
        success: false,
        message: CHAT_MESSAGE_SEARCH_QUERY_REQUIRED_MESSAGE,
      });
    }

    const payload = await getChatMessageSearchFeed({
      currentUserId: context.currentUserId,
      query,
    });

    return res.json(payload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : 500;

    if (status >= 500) {
      logChatControllerError(req, "search_chat_message_failed", error);
    }

    return res.status(status).json({
      success: false,
      message: error?.message || CHAT_MESSAGE_SEARCH_FETCH_FAILED_MESSAGE,
    });
  }
};

const createChatMessageHistoryController = ({
  getChatMessageHistoryPayload = listChatMessageHistoryFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatMessageHistoryContext(req.user);
    const params = parseChatMessageHistoryParams(req.params);
    const query = parseChatMessageHistoryQuery(req.query);

    const payload = await getChatMessageHistoryPayload({
      currentUserId: context.currentUserId,
      otherUserId: params.otherUserId,
      query,
    });

    return res.json(payload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : 500;

    if (status >= 500) {
      logChatControllerError(req, "get_chat_message_history_failed", error, {
        otherUserId: String(req.params?.otherUserId || "").trim() || null,
      });
    }

    return res.status(status).json({
      success: false,
      message: error?.message || CHAT_MESSAGE_HISTORY_FETCH_FAILED_MESSAGE,
    });
  }
};

const createChatChannelAuditLogController = ({
  getChatChannelAuditLogFeed = listChatChannelAuditLogFeed,
} = {}) => async (req, res) => {
  try {
    const params = parseChatChannelAuditLogParams(req.params);
    const query = parseChatChannelAuditLogQuery(req.query);

    const payload = await getChatChannelAuditLogFeed({
      channelId: params.channelId,
      query,
    });

    return res.json(payload);
  } catch (error) {
    logChatControllerError(req, "list_chat_channel_audit_log_failed", error, {
      channelId: String(req.params?.channelId || "").trim() || null,
    });

    return res.status(500).json({
      message: error?.message || CHAT_CHANNEL_AUDIT_LOG_FETCH_FAILED_MESSAGE,
    });
  }
};

const createChatInfoController = ({
  getChatInfoPayload = getChatInfoFeed,
} = {}) => async (req, res) => {
  try {
    const context = parseChatInfoContext(req.user);
    const params = parseChatInfoParams(req.params);
    const query = parseChatInfoQuery(req.query);

    const payload = await getChatInfoPayload({
      currentUserId: context.currentUserId,
      chatId: params.chatId,
      query,
    });

    return res.json(payload);
  } catch (error) {
    const status = error instanceof RealtimeMessageError
      ? error.statusCode
      : 500;

    if (status >= 500) {
      logChatControllerError(req, "get_chat_info_failed", error, {
        chatId: String(req.params?.chatId || "").trim() || null,
      });
    }

    return res.status(status).json({
      success: false,
      message: error?.message || CHAT_INFO_FETCH_FAILED_MESSAGE,
    });
  }
};

const chatChannelAuditLogController = createChatChannelAuditLogController();
const chatBootstrapController = createChatBootstrapController();
const chatChannelLeaveController = createChatChannelLeaveController();
const chatChannelClearMessagesController = createChatChannelClearMessagesController();
const chatChannelDeleteController = createChatChannelDeleteController();
const chatChannelRemoveUserController = createChatChannelRemoveUserController();
const chatGroupRemoveMemberController = createChatGroupRemoveMemberController();
const chatGroupAddMembersController = createChatGroupAddMembersController();
const chatGroupCreateController = createChatGroupCreateController();
const chatBroadcastController = createChatBroadcastController();
const chatCreateController = createChatCreateController();
const chatDeleteMessageController = createChatDeleteMessageController();
const chatDeleteForEveryoneController = createChatDeleteForEveryoneController();
const chatDeleteForMeController = createChatDeleteForMeController();
const chatMessageSendController = createChatMessageSendController();
const chatDirectController = createChatDirectController();
const chatFullBootstrapController = createChatFullBootstrapController();
const chatQuickBootstrapController = createChatQuickBootstrapController();
const chatInfoController = createChatInfoController();
const chatListController = createChatListController();
const chatMessageHistoryController = createChatMessageHistoryController();
const chatMessageSearchController = createChatMessageSearchController();
const chatSearchController = createChatSearchController();
const chatValidationLogsController = createChatValidationLogsController();

module.exports = {
  chatChannelAuditLogController,
  chatBootstrapController,
  chatChannelLeaveController,
  chatChannelClearMessagesController,
  chatChannelDeleteController,
  chatChannelRemoveUserController,
  chatGroupRemoveMemberController,
  chatGroupAddMembersController,
  chatGroupCreateController,
  chatBroadcastController,
  chatCreateController,
  chatDeleteMessageController,
  chatDeleteForEveryoneController,
  chatDeleteForMeController,
  chatMessageSendController,
  chatDirectController,
  chatFullBootstrapController,
  chatQuickBootstrapController,
  chatInfoController,
  chatListController,
  chatMessageHistoryController,
  chatMessageSearchController,
  chatSearchController,
  chatValidationLogsController,
  createChatChannelAuditLogController,
  createChatBootstrapController,
  createChatChannelLeaveController,
  createChatChannelClearMessagesController,
  createChatChannelDeleteController,
  createChatChannelRemoveUserController,
  createChatGroupRemoveMemberController,
  createChatGroupAddMembersController,
  createChatGroupCreateController,
  createChatBroadcastController,
  createChatCreateController,
  createChatDeleteMessageController,
  createChatDeleteForEveryoneController,
  createChatDeleteForMeController,
  createChatMessageSendController,
  createChatDirectController,
  createChatFullBootstrapController,
  createChatQuickBootstrapController,
  createChatInfoController,
  createChatListController,
  createChatMessageHistoryController,
  createChatMessageSearchController,
  createChatSearchController,
  createChatValidationLogsController,
};
