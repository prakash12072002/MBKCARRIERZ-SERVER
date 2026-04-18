const parseChatValidationLogsContext = (user = null) => ({
  requesterId: String(user?.id || user?._id || "").trim(),
});

const parseChatBootstrapContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatCreateContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatCreateBody = (body = null) => body || {};

const parseChatMessageSendContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatMessageSendBody = (body = null) => body || {};

const parseChatDirectContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatDirectBody = (body = null) => body || {};

const parseChatGroupCreateContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatGroupCreateBody = (body = null) => body || {};

const parseChatBroadcastContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatBroadcastBody = (body = null) => body;

const parseChatDeleteForMeContext = (user = null) => ({
  actorId: String(user?.id || user?._id || "").trim(),
});

const parseChatDeleteForMeParams = (params = {}) => ({
  messageId: String(params.messageId || ""),
});

const parseChatDeleteForEveryoneContext = (user = null) => ({
  actorId: String(user?.id || user?._id || "").trim(),
});

const parseChatDeleteForEveryoneParams = (params = {}) => ({
  messageId: String(params.messageId || ""),
});

const parseChatDeleteMessageContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatDeleteMessageParams = (params = {}) => ({
  messageId: String(params.messageId || ""),
});

const parseChatChannelLeaveContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatChannelLeaveParams = (params = {}) => ({
  channelId: String(params.channelId || ""),
});

const parseChatChannelLeaveQuery = (query = {}) => ({
  type: query.type,
});

const parseChatChannelRemoveUserContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatChannelRemoveUserParams = (params = {}) => ({
  channelId: String(params.channelId || ""),
  memberId: String(params.memberId || ""),
});

const parseChatChannelRemoveUserQuery = (query = {}) => ({
  type: query.type,
});

const parseChatChannelClearMessagesContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatChannelClearMessagesParams = (params = {}) => ({
  channelId: String(params.channelId || ""),
});

const parseChatChannelClearMessagesQuery = (query = {}) => ({
  type: query.type,
});

const parseChatChannelDeleteContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatChannelDeleteParams = (params = {}) => ({
  channelId: String(params.channelId || ""),
});

const parseChatChannelDeleteQuery = (query = {}) => ({
  type: query.type || "messaging",
});

const parseChatGroupRemoveMemberContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatGroupRemoveMemberParams = (params = {}) => ({
  groupId: String(params.id || ""),
  userIdToRemove: String(params.userId || ""),
});

const parseChatGroupAddMembersContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatGroupAddMembersParams = (params = {}) => ({
  groupId: String(params.id || ""),
});

const parseChatGroupAddMembersBody = (body = {}) => ({
  memberIds: body?.memberIds,
});

const parseChatListContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatListQuery = (query = {}) => ({
  search: query.search || query.q || "",
  page: Object.prototype.hasOwnProperty.call(query, "page") ? query.page : 1,
  limit: Object.prototype.hasOwnProperty.call(query, "limit") ? query.limit : 30,
});

const parseChatSearchContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatSearchQuery = (query = {}) => ({
  search: query.q || query.search || "",
  page: Object.prototype.hasOwnProperty.call(query, "page") ? query.page : 1,
  limit: Object.prototype.hasOwnProperty.call(query, "limit") ? query.limit : 20,
});

const parseChatMessageSearchContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatMessageSearchQuery = (query = {}) => ({
  search: query.search || query.q || "",
  page: Object.prototype.hasOwnProperty.call(query, "page") ? query.page : 1,
  limit: Object.prototype.hasOwnProperty.call(query, "limit") ? query.limit : 20,
});

const parseChatMessageHistoryContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatMessageHistoryParams = (params = {}) => ({
  otherUserId: String(params.otherUserId || ""),
});

const parseChatMessageHistoryQuery = (query = {}) => ({
  page: Object.prototype.hasOwnProperty.call(query, "page") ? query.page : 1,
  limit: Object.prototype.hasOwnProperty.call(query, "limit") ? query.limit : 50,
});

const parseChatChannelAuditLogParams = (params = {}) => ({
  channelId: String(params.channelId || "").trim(),
});

const parseChatChannelAuditLogQuery = (query = {}) => ({
  limit: query.limit || 100,
  page: query.page || 1,
});

const parseChatInfoContext = (user = null) => ({
  currentUserId: String(user?.id || user?._id || "").trim(),
});

const parseChatInfoParams = (params = {}) => ({
  chatId: String(params.chatId || "").trim(),
});

const parseChatInfoQuery = (query = {}) => ({
  mediaLimit: Number(query.mediaLimit) || 100,
  fileLimit: Number(query.fileLimit) || 100,
  linkLimit: Number(query.linkLimit) || 100,
});

const parseChatValidationLogsQuery = (query = {}) => ({
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
  userId: query.userId,
});

module.exports = {
  parseChatBootstrapContext,
  parseChatCreateBody,
  parseChatCreateContext,
  parseChatMessageSendBody,
  parseChatMessageSendContext,
  parseChatDeleteForMeContext,
  parseChatDeleteForMeParams,
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
  parseChatDirectBody,
  parseChatDirectContext,
  parseChatBroadcastBody,
  parseChatBroadcastContext,
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
};
