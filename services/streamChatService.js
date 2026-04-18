require('dotenv').config();
const mongoose = require("mongoose");
const { StreamChat } = require('stream-chat');
const {
    createCorrelationId,
    createStructuredLogger,
} = require("../shared/utils/structuredLogger");

const apiKey = (process.env.STREAM_CHAT_API_KEY || '').trim();
const apiSecret = (process.env.STREAM_CHAT_API_SECRET || '').trim();
const announcementChannelId = process.env.STREAM_CHAT_ANNOUNCEMENT_CHANNEL_ID || 'portal-announcements';
const CHAT_DISABLED_MESSAGE = 'Internal chat is temporarily unavailable right now. Please try again later.';

const isStreamChatConfigured = () => Boolean(apiKey && apiSecret);

const buildChatDisabledPayload = (user = null, message = CHAT_DISABLED_MESSAGE) => {
    const userId = String(user?._id || user?.id || '').trim();
    const role = user?.role || null;
    const currentUser = userId
        ? {
            id: userId,
            name: user?.name || user?.email || userId,
            image: user?.profilePicture || undefined,
            role,
            portalRoleLabel: role,
        }
        : null;

    return {
        enabled: false,
        message,
        token: null,
        apiKey: null,
        currentUser,
        users: currentUser ? { [userId]: currentUser } : {},
        permissions: {
            canSendAnnouncements: false,
            canStartDirectChat: false,
            canCreateGroup: false,
            canViewAllChannels: false,
        },
        directContacts: [],
        groupCandidates: [],
        channelIds: [],
        announcementChannel: {
            id: announcementChannelId,
        },
        announcementChannelId,
    };
};

const streamChatTelemetryLogger = createStructuredLogger({
    service: 'chat',
    component: 'stream-bootstrap',
});

const logStreamChatTelemetry = (level, fields = {}, options = {}) => {
    const logger = options.logger || streamChatTelemetryLogger;
    const method =
        typeof logger?.[level] === 'function'
            ? level
            : typeof logger?.info === 'function'
                ? 'info'
                : null;
    if (!method) return;

    logger[method]({
        correlationId: fields.correlationId || createCorrelationId('chat_bootstrap'),
        stage: fields.stage || 'chat_bootstrap_event',
        status: fields.status || 'chat_bootstrap',
        outcome: fields.outcome || 'unknown',
        attempt: Number.isFinite(fields.attempt) ? fields.attempt : null,
        cleanupMode: fields.cleanupMode || 'none',
        reason: fields.reason || null,
        userId: fields.userId || null,
        role: fields.role || null,
        channelId: fields.channelId || null,
        cacheKey: fields.cacheKey || null,
    });
};

if (!apiKey || !apiSecret) {
    logStreamChatTelemetry('warn', {
        stage: 'stream_chat_credentials_missing',
        status: 'chat_setup',
        outcome: 'degraded',
        reason: 'Stream Chat credentials not found in environment variables.',
    });
}

const client = StreamChat.getInstance(apiKey, apiSecret, { timeout: 10000 });

class ChatServiceError extends Error {
    constructor(message, statusCode = 500, code = 'CHAT_ERROR') {
        super(message);
        this.name = 'ChatServiceError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

const User = require("../models/User");
const Group = require("../models/Group");
const GroupMember = require("../models/GroupMember");
const Chat = require("../models/Chat");
const ChatMessage = require("../models/ChatMessage");
const {
    getCachedChats,
    setCachedChats,
    deleteCachedChats,
} = require("./chatCacheService");

const CHAT_ROLE_VALUES = {
    trainer: ['Trainer', 'trainer'],
    spoc: ['SPOCAdmin', 'spocadmin', 'SPOC', 'spoc', 'CollegeAdmin', 'collegeadmin'],
    superadmin: ['SuperAdmin', 'superadmin', 'Admin', 'admin'],
};

const CHAT_ENABLED_ROLE_VALUES = Array.from(
    new Set([
        ...CHAT_ROLE_VALUES.trainer,
        ...CHAT_ROLE_VALUES.spoc,
        ...CHAT_ROLE_VALUES.superadmin,
    ])
);
const GROUP_DEFAULT_CORE_ROLE_VALUES = Array.from(
    new Set([
        ...CHAT_ROLE_VALUES.spoc,
        ...CHAT_ROLE_VALUES.superadmin,
    ])
);
const STREAM_DIRECT_CUSTOM_TYPES = new Set(["direct", "spoctrainer"]);
const STREAM_GROUP_CUSTOM_TYPES = new Set(["group", "trainergroup"]);
const STREAM_BROADCAST_CUSTOM_TYPES = new Set(["announcement", "broadcast"]);

const normalizeRoleToken = (value = '') =>
    String(value).trim().toLowerCase().replace(/[\s_-]+/g, '');

const normalizePortalRole = (role = '') => {
    const token = normalizeRoleToken(role);
    if (token.includes('trainer')) return 'trainer';
    if (token.includes('spoc') || token.includes('collegeadmin')) return 'spoc';
    if (token.includes('superadmin') || token === 'admin') return 'superadmin';
    return 'unknown';
};

const getStreamRole = (portalRole = '') => {
    const normalized = normalizePortalRole(portalRole);
    return normalized === 'trainer' ? 'user' : 'admin';
};

const getDirectContactRoleValues = (senderRole = '') => {
    const sender = normalizePortalRole(senderRole);

    if (sender === 'trainer') {
        return [...CHAT_ROLE_VALUES.spoc, ...CHAT_ROLE_VALUES.superadmin];
    }
    if (sender === 'spoc') {
        return [...CHAT_ROLE_VALUES.trainer, ...CHAT_ROLE_VALUES.superadmin];
    }
    if (sender === 'superadmin') {
        return CHAT_ENABLED_ROLE_VALUES;
    }
    return [];
};

const isDirectPairAllowed = (senderRole = '', targetRole = '') => {
    const sender = normalizePortalRole(senderRole);
    const target = normalizePortalRole(targetRole);

    if (!['trainer', 'spoc', 'superadmin'].includes(sender)) return false;
    if (!['trainer', 'spoc', 'superadmin'].includes(target)) return false;

    if (sender === 'superadmin') return true;
    if (sender === 'trainer') return ['spoc', 'superadmin'].includes(target);
    if (sender === 'spoc') return ['trainer', 'superadmin'].includes(target);
    return false;
};

const buildDirectChatKey = (firstUserId, secondUserId) => {
    const sortedIds = [String(firstUserId), String(secondUserId)].sort();
    return sortedIds.join('_');
};

const buildMirrorChatKeyForStreamChannel = (channelId = '') =>
    `stream:channel:${String(channelId || '').trim()}`;

const toObjectIdOrNull = (value) => {
    const normalizedValue = String(value || "").trim();
    if (!normalizedValue || !mongoose.Types.ObjectId.isValid(normalizedValue)) {
        return null;
    }
    return new mongoose.Types.ObjectId(normalizedValue);
};

const getStreamChannelMemberIds = (channel = {}) =>
    Array.from(
        new Set(
            [
                ...Object.keys(channel?.state?.members || {}),
                ...(Array.isArray(channel?.data?.members) ? channel.data.members : []),
            ]
                .map((value) => String(value || "").trim())
                .filter(Boolean),
        ),
    );

const isStreamAnnouncementChannel = (channel = {}) => {
    const channelId = String(channel?.id || "").trim();
    const customType = normalizeRoleToken(
        channel?.data?.customType || channel?.data?.channel_type || "",
    );

    return (
        channelId === String(announcementChannelId || "").trim() ||
        channel?.data?.is_announcement === true ||
        STREAM_BROADCAST_CUSTOM_TYPES.has(customType)
    );
};

const isStreamGroupChannel = (channel = {}) => {
    const customType = normalizeRoleToken(
        channel?.data?.customType || channel?.data?.channel_type || "",
    );
    const memberIds = getStreamChannelMemberIds(channel);

    return (
        channel?.data?.is_group === true ||
        STREAM_GROUP_CUSTOM_TYPES.has(customType) ||
        (!isStreamAnnouncementChannel(channel) && memberIds.length > 2)
    );
};

const isStreamDirectChannel = (channel = {}) => {
    const customType = normalizeRoleToken(
        channel?.data?.customType || channel?.data?.channel_type || "",
    );
    const memberIds = getStreamChannelMemberIds(channel);

    if (isStreamAnnouncementChannel(channel)) {
        return false;
    }

    if (channel?.data?.is_group === true || STREAM_GROUP_CUSTOM_TYPES.has(customType)) {
        return false;
    }

    if (STREAM_DIRECT_CUSTOM_TYPES.has(customType)) {
        return memberIds.length <= 2;
    }

    return memberIds.length <= 2;
};

const clearChatCachesForUserIds = async (userIds = []) => {
    const normalizedIds = Array.from(
        new Set(
            userIds
                .map((value) => String(value || "").trim())
                .filter(Boolean),
        ),
    );

    if (!normalizedIds.length) {
        return 0;
    }

    const cacheKeys = normalizedIds.flatMap((userId) => [
        userId,
        `contacts_${userId}`,
    ]);

    await Promise.allSettled(
        cacheKeys.map((cacheKey) => deleteCachedChats(cacheKey)),
    );

    return normalizedIds.length;
};

const cleanupStreamMirrorChannelDelete = async (channelId) => {
    const normalizedChannelId = String(channelId || "").trim();
    if (!normalizedChannelId) {
        return {
            deletedChats: 0,
            deletedMessages: 0,
            deletedGroups: 0,
            deletedGroupMembers: 0,
        };
    }

    const mirrorChatKey = buildMirrorChatKeyForStreamChannel(normalizedChannelId);
    const groups = await Group.find({ streamChannelId: normalizedChannelId })
        .select("_id chatId");
    const groupIds = groups
        .map((groupDoc) => String(groupDoc?._id || "").trim())
        .filter(Boolean);
    const candidateChatIds = new Set(
        groups
            .map((groupDoc) => String(groupDoc?.chatId || "").trim())
            .filter((value) => mongoose.Types.ObjectId.isValid(value)),
    );

    const mirrorChats = await Chat.find({
        $or: [
            { chatKey: mirrorChatKey },
            ...(candidateChatIds.size
                ? [{ _id: { $in: Array.from(candidateChatIds).map((value) => new mongoose.Types.ObjectId(value)) } }]
                : []),
        ],
    }).select("_id");

    mirrorChats.forEach((chatDoc) => {
        const chatId = String(chatDoc?._id || "").trim();
        if (chatId) {
            candidateChatIds.add(chatId);
        }
    });

    let deletedMessages = 0;
    let deletedChats = 0;
    if (candidateChatIds.size) {
        const objectIds = Array.from(candidateChatIds).map(
            (value) => new mongoose.Types.ObjectId(value),
        );
        const messageDeleteResult = await ChatMessage.deleteMany({
            chatId: { $in: objectIds },
        });
        const chatDeleteResult = await Chat.deleteMany({
            _id: { $in: objectIds },
        });
        deletedMessages = messageDeleteResult?.deletedCount || 0;
        deletedChats = chatDeleteResult?.deletedCount || 0;
    }

    let deletedGroupMembers = 0;
    let deletedGroups = 0;
    if (groupIds.length) {
        const objectIds = groupIds.map((value) => new mongoose.Types.ObjectId(value));
        const groupMemberDeleteResult = await GroupMember.deleteMany({
            groupId: { $in: objectIds },
        });
        const groupDeleteResult = await Group.deleteMany({
            _id: { $in: objectIds },
        });
        deletedGroupMembers = groupMemberDeleteResult?.deletedCount || 0;
        deletedGroups = groupDeleteResult?.deletedCount || 0;
    }

    return {
        deletedChats,
        deletedMessages,
        deletedGroups,
        deletedGroupMembers,
    };
};

const cleanupStreamMirrorChannelMembership = async (channelId, userObjectId) => {
    if (!userObjectId) {
        return {
            updatedChats: 0,
            updatedGroups: 0,
            deletedGroupMembers: 0,
        };
    }

    const normalizedChannelId = String(channelId || "").trim();
    if (!normalizedChannelId) {
        return {
            updatedChats: 0,
            updatedGroups: 0,
            deletedGroupMembers: 0,
        };
    }

    const mirrorChatKey = buildMirrorChatKeyForStreamChannel(normalizedChannelId);
    const groups = await Group.find({ streamChannelId: normalizedChannelId })
        .select("_id chatId");
    const groupIds = groups
        .map((groupDoc) => String(groupDoc?._id || "").trim())
        .filter(Boolean);
    const candidateChatIds = groups
        .map((groupDoc) => String(groupDoc?.chatId || "").trim())
        .filter((value) => mongoose.Types.ObjectId.isValid(value))
        .map((value) => new mongoose.Types.ObjectId(value));

    const [chatUpdateResult, groupUpdateResult, groupMemberDeleteResult] = await Promise.all([
        Chat.updateMany(
            {
                $or: [
                    { chatKey: mirrorChatKey },
                    ...(candidateChatIds.length ? [{ _id: { $in: candidateChatIds } }] : []),
                ],
            },
            {
                $pull: {
                    members: userObjectId,
                    hiddenFor: userObjectId,
                },
            },
        ),
        groupIds.length
            ? Group.updateMany(
                {
                    _id: {
                        $in: groupIds.map((value) => new mongoose.Types.ObjectId(value)),
                    },
                },
                {
                    $pull: { members: userObjectId },
                },
            )
            : Promise.resolve({ modifiedCount: 0 }),
        groupIds.length
            ? GroupMember.deleteMany({
                groupId: {
                    $in: groupIds.map((value) => new mongoose.Types.ObjectId(value)),
                },
                userId: userObjectId,
            })
            : Promise.resolve({ deletedCount: 0 }),
    ]);

    return {
        updatedChats: chatUpdateResult?.modifiedCount || 0,
        updatedGroups: groupUpdateResult?.modifiedCount || 0,
        deletedGroupMembers: groupMemberDeleteResult?.deletedCount || 0,
    };
};

const pruneOrphanedChatArtifactsForUser = async (user, options = {}) => {
    const currentUserId = String(user?._id || user?.id || "").trim();
    const correlationId =
        options?.correlationId ||
        user?.correlationId ||
        createCorrelationId("chat_orphan_prune");

    const summary = {
        currentUserId,
        streamDirectChannelsDeleted: 0,
        streamGroupMembershipsRemoved: 0,
        streamMirrorChatsDeleted: 0,
        streamMirrorMessagesDeleted: 0,
        streamMirrorChatsUpdated: 0,
        streamMirrorGroupsUpdated: 0,
        streamMirrorGroupMembersDeleted: 0,
        localDirectChatsDeleted: 0,
        localMessagesDeleted: 0,
        localGroupChatsUpdated: 0,
        cachesCleared: 0,
        missingUserIds: [],
        affectedUserIds: [],
    };

    if (!currentUserId) {
        return summary;
    }

    const affectedUserIds = new Set([currentUserId]);
    const missingUserIds = new Set();

    try {
        if (isStreamChatConfigured()) {
            const channels = await client.queryChannels(
                { members: { $in: [currentUserId] } },
                {},
                { limit: 200, watch: false, state: true, presence: false },
            );

            const channelMemberIds = Array.from(
                new Set(
                    channels
                        .flatMap((channel) => getStreamChannelMemberIds(channel))
                        .map((memberId) => String(memberId || "").trim())
                        .filter(Boolean),
                ),
            );
            const otherMemberIds = channelMemberIds.filter(
                (memberId) => memberId !== currentUserId,
            );
            const otherMongoMemberIds = otherMemberIds.filter((memberId) =>
                mongoose.Types.ObjectId.isValid(memberId),
            );

            const existingUsers = otherMongoMemberIds.length
                ? await User.find({ _id: { $in: otherMongoMemberIds } }).select("_id")
                : [];
            const existingUserIds = new Set(
                existingUsers.map((userDoc) => String(userDoc?._id || "").trim()),
            );

            for (const channel of channels) {
                const channelId = String(channel?.id || "").trim();
                if (!channelId) {
                    continue;
                }

                const memberIds = getStreamChannelMemberIds(channel);
                memberIds.forEach((memberId) => {
                    if (memberId) affectedUserIds.add(memberId);
                });

                const orphanMemberIds = memberIds.filter(
                    (memberId) =>
                        memberId &&
                        memberId !== currentUserId &&
                        mongoose.Types.ObjectId.isValid(memberId) &&
                        !existingUserIds.has(memberId),
                );

                if (!orphanMemberIds.length) {
                    continue;
                }

                orphanMemberIds.forEach((memberId) => missingUserIds.add(memberId));

                if (isStreamDirectChannel(channel)) {
                    try {
                        await channel.delete({ hard_delete: true });
                    } catch (deleteError) {
                        await channel.delete();
                    }

                    summary.streamDirectChannelsDeleted += 1;
                    const mirrorDeleteSummary = await cleanupStreamMirrorChannelDelete(channelId);
                    summary.streamMirrorChatsDeleted += mirrorDeleteSummary.deletedChats;
                    summary.streamMirrorMessagesDeleted += mirrorDeleteSummary.deletedMessages;
                    summary.streamMirrorGroupsUpdated += mirrorDeleteSummary.deletedGroups;
                    summary.streamMirrorGroupMembersDeleted +=
                        mirrorDeleteSummary.deletedGroupMembers;
                    continue;
                }

                try {
                    await channel.removeMembers(orphanMemberIds);
                    summary.streamGroupMembershipsRemoved += orphanMemberIds.length;
                } catch (removeError) {
                    const message = String(removeError?.message || "").toLowerCase();
                    if (!message.includes("not member")) {
                        throw removeError;
                    }
                }

                for (const orphanMemberId of orphanMemberIds) {
                    const mirrorMembershipSummary = await cleanupStreamMirrorChannelMembership(
                        channelId,
                        toObjectIdOrNull(orphanMemberId),
                    );
                    summary.streamMirrorChatsUpdated +=
                        mirrorMembershipSummary.updatedChats;
                    summary.streamMirrorGroupsUpdated +=
                        mirrorMembershipSummary.updatedGroups;
                    summary.streamMirrorGroupMembersDeleted +=
                        mirrorMembershipSummary.deletedGroupMembers;
                }
            }
        }

        const currentUserObjectId = toObjectIdOrNull(currentUserId);
        if (currentUserObjectId) {
            const localChats = await Chat.find({
                members: currentUserObjectId,
            }).select("_id members isGroup chatKey");

            const localMemberIds = Array.from(
                new Set(
                    localChats
                        .flatMap((chatDoc) => chatDoc?.members || [])
                        .map((memberId) => String(memberId || "").trim())
                        .filter(Boolean),
                ),
            );
            const otherLocalMemberIds = localMemberIds.filter(
                (memberId) => memberId !== currentUserId,
            );
            const otherLocalMongoMemberIds = otherLocalMemberIds.filter((memberId) =>
                mongoose.Types.ObjectId.isValid(memberId),
            );
            const existingLocalUsers = otherLocalMongoMemberIds.length
                ? await User.find({ _id: { $in: otherLocalMongoMemberIds } }).select("_id")
                : [];
            const existingLocalUserIds = new Set(
                existingLocalUsers.map((userDoc) => String(userDoc?._id || "").trim()),
            );

            const localDirectChatIds = [];
            const localGroupChatIds = [];
            const orphanObjectIds = new Set();

            localChats.forEach((chatDoc) => {
                const memberIds = Array.isArray(chatDoc?.members)
                    ? chatDoc.members
                        .map((memberId) => String(memberId || "").trim())
                        .filter(Boolean)
                    : [];
                const orphanMemberIds = memberIds.filter(
                    (memberId) =>
                        memberId &&
                        memberId !== currentUserId &&
                        mongoose.Types.ObjectId.isValid(memberId) &&
                        !existingLocalUserIds.has(memberId),
                );

                if (!orphanMemberIds.length) {
                    return;
                }

                orphanMemberIds.forEach((memberId) => {
                    missingUserIds.add(memberId);
                    affectedUserIds.add(memberId);
                    const objectId = toObjectIdOrNull(memberId);
                    if (objectId) {
                        orphanObjectIds.add(String(objectId));
                    }
                });

                const chatKey = String(chatDoc?.chatKey || "").trim().toLowerCase();
                const isDirectLike = !chatDoc?.isGroup || chatKey.startsWith("direct:");

                if (isDirectLike) {
                    localDirectChatIds.push(chatDoc._id);
                } else {
                    localGroupChatIds.push(chatDoc._id);
                }
            });

            if (localDirectChatIds.length) {
                const [messageDeleteResult, chatDeleteResult] = await Promise.all([
                    ChatMessage.deleteMany({ chatId: { $in: localDirectChatIds } }),
                    Chat.deleteMany({ _id: { $in: localDirectChatIds } }),
                ]);
                summary.localMessagesDeleted += messageDeleteResult?.deletedCount || 0;
                summary.localDirectChatsDeleted += chatDeleteResult?.deletedCount || 0;
            }

            if (localGroupChatIds.length && orphanObjectIds.size) {
                const orphanIds = Array.from(orphanObjectIds).map(
                    (memberId) => new mongoose.Types.ObjectId(memberId),
                );
                const groupUpdateResult = await Chat.updateMany(
                    { _id: { $in: localGroupChatIds } },
                    {
                        $pull: {
                            members: { $in: orphanIds },
                            hiddenFor: { $in: orphanIds },
                        },
                    },
                );
                summary.localGroupChatsUpdated += groupUpdateResult?.modifiedCount || 0;
            }
        }

        summary.missingUserIds = Array.from(missingUserIds);
        if (summary.missingUserIds.length) {
            summary.cachesCleared = await clearChatCachesForUserIds(
                Array.from(affectedUserIds),
            );
            summary.affectedUserIds = Array.from(affectedUserIds);

            logStreamChatTelemetry("info", {
                correlationId,
                stage: "orphaned_chat_artifacts_pruned",
                status: "chat_cleanup",
                outcome: "succeeded",
                userId: currentUserId,
                role: user?.role || null,
                cleanupMode: "orphan_prune",
            });
        }

        return summary;
    } catch (error) {
        logStreamChatTelemetry("warn", {
            correlationId,
            stage: "orphaned_chat_artifacts_prune_failed",
            status: "chat_cleanup",
            outcome: "failed",
            reason: error?.message || "Orphan chat cleanup failed",
            userId: currentUserId,
            role: user?.role || null,
            cleanupMode: "orphan_prune",
        });
        return summary;
    }
};

const upsertMirrorChatForStreamChannel = async ({
    channelId,
    name,
    memberIds = [],
    createdBy,
    isBroadcast = false,
}) => {
    const normalizedChannelId = String(channelId || '').trim();
    const normalizedCreatedBy = String(createdBy || '').trim();
    const normalizedMembers = Array.from(
        new Set(
            [normalizedCreatedBy, ...memberIds.map((id) => String(id || '').trim())]
                .filter(Boolean),
        ),
    );

    if (!normalizedChannelId || !normalizedCreatedBy || !normalizedMembers.length) {
        return null;
    }

    const chatKey = buildMirrorChatKeyForStreamChannel(normalizedChannelId);
    const chatDoc = await Chat.findOneAndUpdate(
        { chatKey },
        {
            $set: {
                isGroup: true,
                name: String(name || (isBroadcast ? 'Broadcasts' : 'Group')).trim(),
                createdBy: normalizedCreatedBy,
                chatKey,
                updatedAt: new Date(),
            },
            $addToSet: {
                members: { $each: normalizedMembers },
            },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return chatDoc;
};

const ensureAnnouncementChannelMembership = async (
    user = {},
    options = {},
) => {
    const userId = (user?._id || user?.id || "").toString();
    if (!userId) return null;
    const createIfMissing = options?.createIfMissing !== false;

    const channel = client.channel('team', announcementChannelId, {
        name: 'Broadcasts',
        created_by_id: userId,
        customType: 'announcement',
        is_announcement: true,
    });

    if (createIfMissing) {
        try {
            await channel.create();
        } catch (error) {
            const code = String(error?.code || "");
            const message = String(error?.message || "").toLowerCase();
            // Channel may already exist.
            if (code !== "CHANNEL_ALREADY_EXISTS" && !message.includes("already exists")) {
                throw error;
            }
        }
    } else {
        const cid = `team:${announcementChannelId}`;
        const existing = await client.queryChannels(
            { cid: { $in: [cid] } },
            {},
            { limit: 1, watch: false, state: false, presence: false },
        );
        if (!Array.isArray(existing) || existing.length === 0) {
            return null;
        }
    }

    try {
        await channel.addMembers([userId]);
    } catch (error) {
        const message = String(error?.message || "").toLowerCase();
        // Ignore if already a member.
        if (!message.includes("already") && !message.includes("member")) {
            throw error;
        }
    }

    return channel;
};

/**
 * Bootstraps chat for a user: generates token and returns initial data.
 */
const createWorkspaceBootstrap = async (user) => {
    const correlationId = createCorrelationId('chat_bootstrap');
    try {
        if (!user || (!user._id && !user.id)) {
            throw new ChatServiceError('User identification required', 400);
        }

        const userId = (user._id || user.id).toString();
        const role = user.role;

        if (!isStreamChatConfigured()) {
            logStreamChatTelemetry('warn', {
                correlationId,
                stage: 'workspace_bootstrap_disabled',
                status: 'chat_setup',
                outcome: 'degraded',
                reason: 'Stream Chat credentials not found in environment variables.',
                userId,
                role,
            });
            return buildChatDisabledPayload(user);
        }

        // ── Redis Cache Check via Service ──────────────────────────
        await pruneOrphanedChatArtifactsForUser(user, { correlationId });

        const cached = await getCachedChats(userId);
        if (cached && cached.data && cached.data.activeChannels) {
            return cached.data;
        }

        const normalizedRole = normalizePortalRole(role);
        const streamRole = getStreamRole(role);
        
        // Ensure user exists in Stream with correct internal role
        await client.upsertUser({
            id: userId,
            name: user.name || user.email || userId,
            role: streamRole,
            image: user.profilePicture || undefined,
            portal_role: role
        });
        await ensureAnnouncementChannelMembership(user, { createIfMissing: false });

        // Generate token
        const token = client.createToken(userId);

        // Permissions logic
        const permissions = {
            canSendAnnouncements: normalizedRole === 'superadmin',
            canStartDirectChat: ['trainer', 'spoc', 'superadmin'].includes(normalizedRole),
            canCreateGroup: ['spoc', 'superadmin'].includes(normalizedRole),
            canViewAllChannels: normalizedRole === 'superadmin'
        };

        // Communication Rules / Contacts
        let directContacts = [];
        let groupCandidates = [];

        const directContactRoleValues = getDirectContactRoleValues(role);
        if (directContactRoleValues.length) {
            const directUsers = await User.find({
                _id: { $ne: user._id },
                role: { $in: directContactRoleValues },
                accountStatus: 'active',
            }).select('name role profilePicture').limit(500);

            directContacts = directUsers.map((u) => ({
                portalUserId: u._id,
                name: u.name,
                roleLabel: u.role,
                image: u.profilePicture,
            }));
        }

        if (['spoc', 'superadmin'].includes(normalizedRole)) {
            const groupUsers = await User.find({
                _id: { $ne: user._id },
                role: { $in: CHAT_ENABLED_ROLE_VALUES },
                accountStatus: 'active',
            }).select('name role profilePicture').limit(500);

            groupCandidates = groupUsers.map((u) => ({
                portalUserId: u._id,
                name: u.name,
                roleLabel: u.role,
                image: u.profilePicture,
            }));
        }

        const currentUser = {
            id: userId,
            name: user.name,
            image: user.profilePicture,
            role: role,
            portalRoleLabel: role
        };

        // Build users metadata object for initial contacts
        const users = {
            [userId]: currentUser
        };
        directContacts.forEach(u => {
            users[u.portalUserId.toString()] = {
                id: u.portalUserId.toString(),
                name: u.name,
                role: u.roleLabel,
                image: undefined // We don't have the picture in the initial brief contact list
            };
        });

        const channelList = await client.queryChannels({ members: { $in: [userId] } }, {}, { limit: 100 });
        
        const result = {
            enabled: true,
            token,
            apiKey,
            currentUser,
            users,
            permissions,
            directContacts,
            groupCandidates,
            channelIds: channelList.map(c => c.id),
            announcementChannel: {
                id: announcementChannelId
            },
            announcementChannelId
        };

        // ── Store in Redis cache (60s TTL) ─────────────────────────
        await setCachedChats(userId, result);

        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'workspace_bootstrap_succeeded',
            status: 'chat_bootstrap',
            outcome: 'succeeded',
            userId,
            role,
        });

        return result;
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'workspace_bootstrap_failed',
            status: 'chat_bootstrap',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Bootstrap Error',
            userId: String(user?._id || user?.id || ''),
            role: user?.role || null,
        });
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Quick Bootstrap: Generates token and basic info instantly (no DB queries).
 */
const createWorkspaceQuickBootstrap = async (user) => {
    const correlationId = createCorrelationId('chat_quick_bootstrap');
    try {
        if (!user || (!user._id && !user.id)) {
            throw new ChatServiceError('User identification required', 400);
        }

        const userId = (user._id || user.id).toString();
        const role = user.role;

        if (!isStreamChatConfigured()) {
            logStreamChatTelemetry('warn', {
                correlationId,
                stage: 'quick_bootstrap_disabled',
                status: 'chat_setup',
                outcome: 'degraded',
                reason: 'Stream Chat credentials not found in environment variables.',
                userId,
                role,
            });
            return buildChatDisabledPayload(user);
        }

        const normalizedRole = normalizePortalRole(role);
        const streamRole = getStreamRole(role);
        
        // Ensure user is upserted first (awaited for Trainers to avoid channel creation race)
        await client.upsertUser({
            id: userId,
            name: user.name || user.email || userId,
            role: streamRole,
            image: user.profilePicture || undefined,
            portal_role: role
        });
        await ensureAnnouncementChannelMembership(user, { createIfMissing: false });

        await pruneOrphanedChatArtifactsForUser(user, { correlationId });

        const token = client.createToken(userId);

        const permissions = {
            canSendAnnouncements: normalizedRole === 'superadmin',
            canStartDirectChat: ['trainer', 'spoc', 'superadmin'].includes(normalizedRole),
            canCreateGroup: ['spoc', 'superadmin'].includes(normalizedRole),
            canViewAllChannels: normalizedRole === 'superadmin'
        };

        const currentUser = {
            id: userId,
            name: user.name,
            image: user.profilePicture,
            role: role,
            portalRoleLabel: role
        };

        // 🔥 TRAINER FAILSAFE: If trainer has no channels yet, auto-create them now.
        if (normalizedRole === 'trainer') {
            try {
                const existingChannels = await client.queryChannels(
                    { type: 'messaging', members: { $in: [userId] } },
                    {},
                    { limit: 1 }
                );

                if (existingChannels.length === 0) {
                    logStreamChatTelemetry('info', {
                        correlationId,
                        stage: 'quick_bootstrap_auto_create_started',
                        status: 'chat_bootstrap',
                        outcome: 'started',
                        userId,
                        role,
                    });
                    // Find all admins in our DB
                    const adminUsers = await User.find({
                        role: { $in: [...CHAT_ROLE_VALUES.spoc, ...CHAT_ROLE_VALUES.superadmin] },
                        accountStatus: 'active'
                    }).select('_id name email profilePicture role');

                    if (adminUsers.length > 0) {
                        // Upsert all admins and create 1:1 channels (without awaiting, runs in background)
                        const setupPromises = adminUsers.map(async (adminUser) => {
                            const adminId = adminUser._id.toString();
                            if (adminId === userId) return;
                            
                            await client.upsertUser({
                                id: adminId,
                                name: adminUser.name || adminId,
                                role: 'admin',
                                image: adminUser.profilePicture || undefined,
                                portal_role: adminUser.role
                            });

                            // Use a deterministic channel ID based on both user IDs
                            const directChatKey = buildDirectChatKey(userId, adminId);
                            const channel = client.channel('messaging', directChatKey, {
                                members: [userId, adminId],
                                created_by_id: adminId,
                                customType: 'direct'
                            });
                            return channel.create();
                        });
                        await Promise.allSettled(setupPromises);
                        logStreamChatTelemetry('info', {
                            correlationId,
                            stage: 'quick_bootstrap_auto_create_succeeded',
                            status: 'chat_bootstrap',
                            outcome: 'succeeded',
                            userId,
                            role,
                        });
                    }
                }
            } catch (e) {
                // Non-fatal — just log and continue
                logStreamChatTelemetry('warn', {
                    correlationId,
                    stage: 'quick_bootstrap_auto_create_failed',
                    status: 'chat_bootstrap',
                    outcome: 'failed',
                    reason: e?.message || 'Trainer channel auto-create failed',
                    userId,
                    role,
                    cleanupMode: 'none',
                });
            }
        }

        return {
            enabled: true,
            token,
            apiKey,
            currentUser,
            users: {
                [userId]: currentUser
            },
            permissions,
            announcementChannel: { id: announcementChannelId },
            announcementChannelId
        };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'quick_bootstrap_failed',
            status: 'chat_bootstrap',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Quick Bootstrap Error',
            userId: String(user?._id || user?.id || ''),
            role: user?.role || null,
        });
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Full Bootstrap: Fetches heavy contact lists for modals
 */
const createWorkspaceFullBootstrap = async (user) => {
    const correlationId = createCorrelationId('chat_full_bootstrap');
    try {
        if (!user || (!user._id && !user.id)) {
            throw new ChatServiceError('User identification required', 400);
        }

        const userId = (user._id || user.id).toString();
        const role = user.role;
        const normalizedRole = normalizePortalRole(role);

        await pruneOrphanedChatArtifactsForUser(user, { correlationId });

        const cached = await getCachedChats(`contacts_${userId}`);
        
        // Define the heavy database fetch logic as a reusable function
        const fetchFreshData = async () => {
            let directContacts = [];
            let groupCandidates = [];
            let users = {};

            let usersInDb = [];

            const directContactRoleValues = getDirectContactRoleValues(role);
            if (directContactRoleValues.length) {
                const directUsers = await User.find({
                    _id: { $ne: user._id },
                    role: { $in: directContactRoleValues },
                    accountStatus: 'active',
                }).select('name role profilePicture').limit(500);

                directContacts = directUsers.map((u) => ({
                    portalUserId: u._id,
                    name: u.name,
                    roleLabel: u.role,
                    image: u.profilePicture,
                }));
            }

            if (['spoc', 'superadmin'].includes(normalizedRole)) {
                const groupUsers = await User.find({
                    _id: { $ne: user._id },
                    accountStatus: 'active',
                    role: { $in: CHAT_ENABLED_ROLE_VALUES },
                }).select('name role profilePicture').limit(500);

                groupCandidates = groupUsers.map((u) => ({
                    portalUserId: u._id,
                    name: u.name,
                    roleLabel: u.role,
                    image: u.profilePicture,
                }));
            }

            usersInDb = [];
            const userMapSources = [...directContacts, ...groupCandidates];
            if (userMapSources.length) {
                const mapIds = Array.from(new Set(userMapSources.map((u) => String(u.portalUserId))));
                usersInDb = await User.find({
                    _id: { $in: mapIds },
                    accountStatus: 'active',
                }).select('name role profilePicture');
            }

            // Build users metadata object
            usersInDb.forEach(u => {
                users[u._id.toString()] = {
                    id: u._id.toString(),
                    name: u.name,
                    role: u.role,
                    image: u.profilePicture
                };
            });

            const freshResult = { directContacts, groupCandidates, users };
            await setCachedChats(`contacts_${userId}`, freshResult);
            logStreamChatTelemetry('debug', {
                correlationId,
                stage: 'contacts_cache_revalidation_succeeded',
                status: 'chat_cache',
                outcome: 'succeeded',
                userId,
                role,
                cacheKey: `contacts_${userId}`,
            });
            return freshResult;
        };

        // If we have a cache hit
        if (cached && cached.data && cached.data.groupCandidates && cached.data.groupCandidates.length > 0) {
            // STALE-WHILE-REVALIDATE: Trigger background refresh if stale
            if (cached.isStale) {
                fetchFreshData().catch((e) => {
                    logStreamChatTelemetry('warn', {
                        correlationId,
                        stage: 'contacts_cache_revalidation_failed',
                        status: 'chat_cache',
                        outcome: 'failed',
                        reason: e?.message || 'Background revalidation failed',
                        userId,
                        role,
                        cacheKey: `contacts_${userId}`,
                        cleanupMode: 'stale_while_revalidate',
                    });
                });
            }
            return cached.data;
        }

        // Cache miss or empty candidates: wait for fresh data
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'contacts_cache_miss_fetching_fresh',
            status: 'chat_cache',
            outcome: 'started',
            userId,
            role,
            cacheKey: `contacts_${userId}`,
        });
        return await fetchFreshData();
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'full_bootstrap_failed',
            status: 'chat_bootstrap',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Full Bootstrap Error',
            userId: String(user?._id || user?.id || ''),
            role: user?.role || null,
            cacheKey: user?._id || user?.id ? `contacts_${String(user._id || user.id)}` : null,
        });
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Creates a 1:1 channel between the current user and another member.
 */
const createDirectChannel = async (user, body) => {
    const correlationId =
        body?.correlationId ||
        user?.correlationId ||
        createCorrelationId('chat_direct');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    try {
        const { memberId, portalUserId } = body || {};
        const targetId = memberId || portalUserId;
        if (!targetId) {
            throw new ChatServiceError('Member ID is required for direct channel', 400);
        }

        const userId = (user._id || user.id).toString();
        const targetUserId = targetId.toString();
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'direct_channel_started',
            status: 'chat_mutation',
            outcome: 'started',
            userId,
            role: actorRole,
        });
        if (userId === targetUserId) {
            throw new ChatServiceError('Cannot create direct channel with yourself', 400);
        }

        // Pre-flight: ensure target exists and role pair is allowed
        const targetUser = await User.findById(targetId).select('name profilePicture role');
        if (!targetUser) {
            throw new ChatServiceError('Target user not found', 404);
        }
        if (!isDirectPairAllowed(user.role, targetUser.role)) {
            throw new ChatServiceError(
                'Direct chat is not allowed for this role pair. Allowed: Trainer->SPOC/SuperAdmin, SPOC->Trainer/SuperAdmin, SuperAdmin->Everyone.',
                403
            );
        }

        await client.upsertUser({
            id: userId,
            name: user.name || userId,
            image: user.profilePicture || undefined,
            portal_role: user.role,
            role: getStreamRole(user.role)
        });

        await client.upsertUser({
            id: targetUserId,
            name: targetUser.name || targetUserId,
            image: targetUser.profilePicture || undefined,
            portal_role: targetUser.role,
            role: getStreamRole(targetUser.role)
        });

        const chatKey = buildDirectChatKey(userId, targetUserId);
        const legacyChatKey = `dm_${chatKey}`;
        const expectedMembers = [userId, targetUserId];

        const candidateCids = [
            `messaging:${chatKey}`,
            `messaging:${legacyChatKey}`,
        ];
        const existingChannels = await client.queryChannels(
            { cid: { $in: candidateCids } },
            { last_message_at: -1 },
            { limit: 2, watch: false, presence: false, state: true }
        );

        let channel = existingChannels[0];
        let created = false;
        let resolvedChannelId = chatKey;

        if (!channel) {
            channel = client.channel('messaging', chatKey, {
                members: expectedMembers,
                created_by_id: userId,
                customType: 'direct',
                is_direct: true,
                chatKey
            });
            await channel.create();
            created = true;
        } else {
            resolvedChannelId = channel.id;
            const memberIds = Object.keys(channel.state?.members || {});
            const missingMemberIds = expectedMembers.filter((id) => !memberIds.includes(id));
            if (missingMemberIds.length) {
                await channel.addMembers(missingMemberIds);
            }
        }

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'direct_channel_succeeded',
            status: 'chat_mutation',
            outcome: created ? 'created' : 'reused',
            userId,
            role: actorRole,
            channelId: resolvedChannelId,
        });

        return {
            channelId: resolvedChannelId,
            chatKey,
            created,
            type: 'messaging',
            channel: { id: resolvedChannelId, type: 'messaging' },
            targetUser: {
                id: targetUserId,
                name: targetUser.name || targetUserId,
                role: targetUser.role,
                image: targetUser.profilePicture || null
            }
        };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'direct_channel_failed',
            status: 'chat_mutation',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Direct Channel Error',
            userId: actorUserId,
            role: actorRole,
            cleanupMode: 'none',
        });
        if (error instanceof ChatServiceError) {
            throw error;
        }
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Creates a group channel.
 */
const createGroupChannel = async (user, body) => {
    const correlationId =
        body?.correlationId ||
        user?.correlationId ||
        createCorrelationId('chat_group');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    try {
        const { name, memberIds, portalUserIds, description } = body || {};
        const normalizedCreatorRole = normalizePortalRole(user?.role);
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'group_channel_started',
            status: 'chat_mutation',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
        });
        if (!['spoc', 'superadmin'].includes(normalizedCreatorRole)) {
            throw new ChatServiceError('Only Admin and SPOC can create groups', 403);
        }

        const targetIds = Array.isArray(memberIds)
            ? memberIds
            : Array.isArray(portalUserIds)
                ? portalUserIds
                : [];
        if (!String(name || '').trim()) {
            throw new ChatServiceError('Group name is required', 400);
        }

        const creatorId = (user._id || user.id).toString();
        const defaultCoreMembers = await User.find({
            _id: { $ne: creatorId },
            role: { $in: GROUP_DEFAULT_CORE_ROLE_VALUES },
            accountStatus: 'active',
            isActive: { $ne: false },
        }).select('_id');

        // Ensure creator + selected users + default SPOC/Admin users are in the list
        const uniqueMemberIds = Array.from(new Set([
            creatorId,
            ...targetIds.map(id => id.toString()),
            ...defaultCoreMembers.map((u) => u._id.toString()),
        ]));
        if (uniqueMemberIds.length < 2) {
            throw new ChatServiceError('Group requires at least 2 members (including creator)', 400);
        }

        // 🚨 PRE-FLIGHT: Ensure all members exist in Stream Chat
        const usersInDb = await User.find({
            _id: { $in: uniqueMemberIds },
            accountStatus: 'active',
            role: { $in: CHAT_ENABLED_ROLE_VALUES }
        }).select('name profilePicture role');
        if (usersInDb.length !== uniqueMemberIds.length) {
            throw new ChatServiceError('Some selected group members are invalid or inactive', 400);
        }
        const upsertPromises = usersInDb.map(u => {
            const streamRole = ['SuperAdmin', 'superadmin', 'SPOCAdmin', 'CollegeAdmin', 'admin'].includes(u.role) ? 'admin' : 'user';
            return client.upsertUser({
                id: u._id.toString(),
                name: u.name || u._id.toString(),
                image: u.profilePicture || undefined,
                portal_role: u.role,
                role: streamRole
            });
        });
        await Promise.all(upsertPromises);
        
        const channelId = `group_${Date.now()}`;
        const channel = client.channel('messaging', channelId, {
            name: String(name).trim(),
            members: uniqueMemberIds,
            created_by_id: creatorId,
            description: description || '',
            customType: 'group',
            is_group: true
        });

        await channel.create();
        const mirrorChatDoc = await upsertMirrorChatForStreamChannel({
            channelId,
            name: String(name).trim(),
            memberIds: uniqueMemberIds,
            createdBy: creatorId,
            isBroadcast: false,
        });

        // ── SAVE TO MONGODB ──────────────────────────────────
        const newGroup = await Group.create({
            name: String(name).trim(),
            description: description || '',
            createdBy: creatorId,
            members: uniqueMemberIds,
            chatId: mirrorChatDoc?._id || null,
            streamChannelId: channelId,
            type: 'group'
        });

        const memberDocs = uniqueMemberIds.map(uid => ({
            groupId: newGroup._id,
            userId: uid,
            role: uid === creatorId ? 'admin' : 'member'
        }));
        await GroupMember.insertMany(memberDocs);

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'group_channel_succeeded',
            status: 'chat_mutation',
            outcome: 'created',
            userId: actorUserId,
            role: actorRole,
            channelId,
        });

        return {
            channelId,
            type: 'messaging',
            mongoGroupId: newGroup._id,
            group: {
                id: newGroup._id.toString(),
                name: newGroup.name,
                members: uniqueMemberIds,
                createdBy: creatorId,
                type: 'group'
            }
        };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'group_channel_failed',
            status: 'chat_mutation',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Group Channel Error',
            userId: actorUserId,
            role: actorRole,
            cleanupMode: 'none',
        });
        if (error instanceof ChatServiceError) {
            throw error;
        }
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Adds members to an existing group.
 */
const addMembersToGroup = async (user, groupId, memberIds) => {
    const correlationId =
        user?.correlationId ||
        createCorrelationId('chat_member_add');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    try {
        const normalizedActorRole = normalizePortalRole(user?.role);
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'group_member_add_started',
            status: 'chat_mutation',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
            channelId: groupId,
        });
        if (!['spoc', 'superadmin'].includes(normalizedActorRole)) {
            throw new ChatServiceError('Only Admin and SPOC can add group members', 403);
        }

        const group = await Group.findOne({ streamChannelId: groupId });
        if (!group) throw new ChatServiceError('Group not found', 404);

        const channel = client.channel('messaging', groupId);
        const safeMemberIds = Array.isArray(memberIds)
            ? Array.from(new Set(memberIds.map((id) => String(id))))
            : [];
        if (!safeMemberIds.length) {
            throw new ChatServiceError('memberIds are required', 400);
        }
        
        // Ensure members exist in Stream
        const usersInDb = await User.find({
            _id: { $in: safeMemberIds },
            accountStatus: 'active',
            role: { $in: CHAT_ENABLED_ROLE_VALUES }
        }).select('name profilePicture role');
        if (usersInDb.length !== safeMemberIds.length) {
            throw new ChatServiceError('Some members are invalid or inactive', 400);
        }
        await Promise.all(usersInDb.map(u => {
            const streamRole = ['SuperAdmin', 'superadmin', 'SPOCAdmin', 'CollegeAdmin', 'admin'].includes(u.role) ? 'admin' : 'user';
            return client.upsertUser({
                id: u._id.toString(),
                name: u.name || u._id.toString(),
                image: u.profilePicture || undefined,
                portal_role: u.role,
                role: streamRole
            });
        }));

        await channel.addMembers(safeMemberIds);

        // Update MongoDB
        const memberDocs = safeMemberIds.map(uid => ({
            groupId: group._id,
            userId: uid,
            role: 'member'
        }));
        
        // Use try-catch for individual inserts to handle duplicates gracefully if needed, 
        // or just use insertMany with ordered: false
        await GroupMember.insertMany(memberDocs, { ordered: false }).catch(() => {});
        await Group.updateOne(
            { _id: group._id },
            { $addToSet: { members: { $each: safeMemberIds } } }
        );

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'group_member_add_succeeded',
            status: 'chat_mutation',
            outcome: 'succeeded',
            userId: actorUserId,
            role: actorRole,
            channelId: groupId,
        });

        return { success: true, addedMemberIds: safeMemberIds };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'group_member_add_failed',
            status: 'chat_mutation',
            outcome: 'failed',
            reason: error?.message || 'Add Members Error',
            userId: actorUserId,
            role: actorRole,
            channelId: groupId,
            cleanupMode: 'none',
        });
        if (error instanceof ChatServiceError) {
            throw error;
        }
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Removes a member from a group.
 */
const removeMemberFromGroup = async (user, groupId, userIdToRemove) => {
    const correlationId =
        user?.correlationId ||
        createCorrelationId('chat_member_remove');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    try {
        const normalizedActorRole = normalizePortalRole(user?.role);
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'group_member_remove_started',
            status: 'chat_mutation',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
            channelId: groupId,
        });
        if (!['spoc', 'superadmin'].includes(normalizedActorRole)) {
            throw new ChatServiceError('Only Admin and SPOC can remove group members', 403);
        }

        const group = await Group.findOne({ streamChannelId: groupId });
        if (!group) throw new ChatServiceError('Group not found', 404);

        const channel = client.channel('messaging', groupId);
        await channel.removeMembers([userIdToRemove]);

        // Update MongoDB
        await GroupMember.deleteOne({ groupId: group._id, userId: userIdToRemove });
        await Group.updateOne(
            { _id: group._id },
            { $pull: { members: userIdToRemove } }
        );

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'group_member_remove_succeeded',
            status: 'chat_mutation',
            outcome: 'succeeded',
            userId: actorUserId,
            role: actorRole,
            channelId: groupId,
        });

        return { success: true };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'group_member_remove_failed',
            status: 'chat_mutation',
            outcome: 'failed',
            reason: error?.message || 'Remove Member Error',
            userId: actorUserId,
            role: actorRole,
            channelId: groupId,
            cleanupMode: 'none',
        });
        if (error instanceof ChatServiceError) {
            throw error;
        }
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Sends a message to the announcement channel.
 */
const sendAnnouncementMessage = async (user, body) => {
    const correlationId =
        body?.correlationId ||
        user?.correlationId ||
        createCorrelationId('chat_announcement');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    try {
        const { text, attachments } = body;
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'announcement_send_started',
            status: 'chat_message',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
            channelId: announcementChannelId,
        });
        if (!text) {
            throw new ChatServiceError('Message text is required', 400);
        }

        const userId = (user._id || user.id).toString();
        await ensureAnnouncementChannelMembership(user);
        const channel = client.channel('team', announcementChannelId);

        const message = await channel.sendMessage({
            text,
            attachments: attachments || [],
            user_id: userId
        });

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'announcement_send_succeeded',
            status: 'chat_message',
            outcome: 'succeeded',
            userId,
            role: actorRole,
            channelId: announcementChannelId,
        });

        return { messageId: message.message.id };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'announcement_send_failed',
            status: 'chat_message',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Announcement Error',
            userId: actorUserId,
            role: actorRole,
            channelId: announcementChannelId,
            cleanupMode: 'none',
        });
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Updates a user's avatar/profile picture in Stream Chat.
 */
const updateUserAvatar = async (userId, imageUrl, options = {}) => {
    const correlationId =
        options?.correlationId ||
        createCorrelationId('chat_avatar');
    const normalizedUserId = userId ? String(userId) : null;
    try {
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'avatar_update_started',
            status: 'chat_profile',
            outcome: 'started',
            userId: normalizedUserId,
        });
        if (!userId) throw new ChatServiceError('User ID is required', 400);
        const updateObj = { id: userId.toString() };
        if (imageUrl) {
            updateObj.set = { image: imageUrl };
        } else {
            updateObj.unset = ['image'];
        }
        await client.partialUpdateUser(updateObj);

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'avatar_update_succeeded',
            status: 'chat_profile',
            outcome: imageUrl ? 'updated' : 'removed',
            userId: normalizedUserId,
        });
        return { success: true };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'avatar_update_failed',
            status: 'chat_profile',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Avatar Update Error',
            userId: normalizedUserId,
            cleanupMode: 'none',
        });
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Generates a standalone token for a user.
 */
const generateUserToken = async (user, options = {}) => {
    const correlationId =
        options?.correlationId ||
        user?.correlationId ||
        createCorrelationId('chat_token');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    try {
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'token_generate_started',
            status: 'chat_token',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
        });
        const userId = (user._id || user.id).toString();
        const token = client.createToken(userId);

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'token_generate_succeeded',
            status: 'chat_token',
            outcome: 'succeeded',
            userId,
            role: actorRole,
        });

        return { token };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'token_generate_failed',
            status: 'chat_token',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Token Generation Error',
            userId: actorUserId,
            role: actorRole,
            cleanupMode: 'none',
        });
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Automatically creates 1:1 channels between a Trainer and one or more Admins.
 * Used during registration, approval, and assignment flows.
 * 
 * @param {Object} trainerUser - The Mongoose User object for the Trainer.
 * @param {Array<Object>} adminUsers - An array of Mongoose User objects for the Admins.
 */
const autoCreateTrainerAdminChannels = async (trainerUser, adminUsers, options = {}) => {
    const correlationId =
        options?.correlationId ||
        trainerUser?.correlationId ||
        createCorrelationId('chat_auto_create');
    const trainerIdForTelemetry =
        trainerUser?._id || trainerUser?.id
            ? String(trainerUser._id || trainerUser.id)
            : null;
    const trainerRole = trainerUser?.role || null;
    try {
        if (!trainerUser || !adminUsers || adminUsers.length === 0) return;

        const trainerId = (trainerUser._id || trainerUser.id).toString();
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'auto_create_channels_started',
            status: 'chat_mutation',
            outcome: 'started',
            userId: trainerIdForTelemetry,
            role: trainerRole,
        });

        // Ensure Trainer is upserted
        await client.upsertUser({
            id: trainerId,
            name: trainerUser.name || trainerUser.email || trainerId,
            image: trainerUser.profilePicture || undefined,
            portal_role: trainerUser.role,
            role: getStreamRole(trainerUser.role)
        });

        // Upsert all admins and create channels
        const channelPromises = adminUsers.map(async (adminUser) => {
            const adminId = (adminUser._id || adminUser.id).toString();
            
            // Skip self-channels just in case
            if (trainerId === adminId) return null;

            await client.upsertUser({
                id: adminId,
                name: adminUser.name || adminUser.email || adminId,
                image: adminUser.profilePicture || undefined,
                portal_role: adminUser.role,
                role: getStreamRole(adminUser.role)
            });

            // Use a deterministic ID so repeated approval/schedule hooks reuse one chat.
            const directChatKey = buildDirectChatKey(trainerId, adminId);
            const channel = client.channel('messaging', directChatKey, {
                members: [trainerId, adminId],
                created_by_id: adminId, // Make the admin the creator
                customType: 'direct',
                is_direct: true,
                chatKey: directChatKey,
            });

            try {
                return await channel.create();
            } catch (createError) {
                const code = String(createError?.code || "");
                const message = String(createError?.message || "").toLowerCase();
                if (code !== "CHANNEL_ALREADY_EXISTS" && !message.includes("already exists")) {
                    throw createError;
                }
                try {
                    await channel.addMembers([trainerId, adminId]);
                } catch (addMemberError) {
                    const addMessage = String(addMemberError?.message || "").toLowerCase();
                    if (!addMessage.includes("already") && !addMessage.includes("member")) {
                        throw addMemberError;
                    }
                }
                return channel;
            }
        });

        await Promise.allSettled(channelPromises);
        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'auto_create_channels_succeeded',
            status: 'chat_mutation',
            outcome: 'succeeded',
            userId: trainerId,
            role: trainerRole,
        });
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'auto_create_channels_failed',
            status: 'chat_mutation',
            outcome: 'failed',
            reason: error?.message || 'Stream Chat Auto-Create Channel Error',
            userId: trainerIdForTelemetry,
            role: trainerRole,
            cleanupMode: 'none',
        });
        // We do not throw here to prevent blocking the main business logic (e.g., registration)
    }
};

/**
 * Native Message Search using Stream's Edge ElasticSearch
 * Searches for messages containing the keyword within channels the user is a member of.
 */
const searchMessages = async (userId, query) => {
    const correlationId = createCorrelationId('chat_search');
    const normalizedUserId = userId ? String(userId) : null;
    try {
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'message_search_started',
            status: 'chat_search',
            outcome: 'started',
            userId: normalizedUserId,
        });
        if (!query || query.trim() === '') {
            return { results: [] };
        }

        // Search parameters:
        // 1. Channel Filter: User must be a member
        // 2. Message Query: Full-text search
        // 3. Options: limit to 20
        const searchResults = await client.search(
            { members: { $in: [userId] } },
            query,
            { limit: 20, offset: 0 }
        );

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'message_search_succeeded',
            status: 'chat_search',
            outcome: 'succeeded',
            userId: normalizedUserId,
        });

        return { results: searchResults.results };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'message_search_failed',
            status: 'chat_search',
            outcome: 'failed',
            reason: error?.message || 'Stream Message Search Error',
            userId: normalizedUserId,
            cleanupMode: 'none',
        });
        throw new ChatServiceError(error.message, 500);
    }
};

const ChatAuditLog = require('../models/ChatAuditLog');

/**
 * Administrative: Deletes a message.
 */
const deleteMessage = async (user, messageId) => {
    const correlationId =
        user?.correlationId ||
        createCorrelationId('chat_delete_message');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    const role = user.role;
    const isAdmin = ['SuperAdmin', 'superadmin', 'admin', 'SPOCAdmin', 'CollegeAdmin'].includes(role);
    if (!isAdmin) throw new ChatServiceError('Unauthorized: Admin role required', 403);

    try {
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'message_delete_started',
            status: 'chat_moderation',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
        });
        // Log the action before deleting
        let messageRes;
        try {
            messageRes = await client.getMessage(messageId);
        } catch (e) {
            // If already deleted, just return success
            if (e.message?.toLowerCase().includes('deleted') || e.status === 404) {
                return { success: true, alreadyDeleted: true };
            }
            throw e;
        }

        await ChatAuditLog.create({
            messageId,
            channelId: messageRes.message.channel.id,
            action: 'delete',
            actorId: user._id || user.id,
            actorName: user.name,
            actorRole: role,
            details: { text: messageRes.message.text }
        });

        await client.deleteMessage(messageId, { hard: true });
        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'message_delete_succeeded',
            status: 'chat_moderation',
            outcome: 'succeeded',
            userId: actorUserId,
            role: actorRole,
        });
        return { success: true };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'message_delete_failed',
            status: 'chat_moderation',
            outcome: 'failed',
            reason: error?.message || 'Stream Delete Message Error',
            userId: actorUserId,
            role: actorRole,
            cleanupMode: 'none',
        });
        // If it's already deleted at the final step, still count as success
        if (error.message?.toLowerCase().includes('deleted')) {
            return { success: true };
        }
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Administrative: Clears all messages in a channel (truncate).
 */
const clearChannelMessages = async (user, channelId, channelType = 'messaging') => {
    const correlationId =
        user?.correlationId ||
        createCorrelationId('chat_truncate');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    const role = user.role;
    const isAdmin = ['SuperAdmin', 'superadmin', 'admin', 'SPOCAdmin', 'CollegeAdmin'].includes(role);
    if (!isAdmin) throw new ChatServiceError('Unauthorized: Admin role required', 403);

    try {
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'channel_truncate_started',
            status: 'chat_moderation',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
            channelId,
        });
        await ChatAuditLog.create({
            messageId: 'N/A',
            channelId,
            action: 'clear',
            actorId: user._id || user.id,
            actorName: user.name,
            actorRole: role
        });

        const channel = client.channel(channelType, channelId);
        await channel.truncate();
        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'channel_truncate_succeeded',
            status: 'chat_moderation',
            outcome: 'succeeded',
            userId: actorUserId,
            role: actorRole,
            channelId,
        });
        return { success: true };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'channel_truncate_failed',
            status: 'chat_moderation',
            outcome: 'failed',
            reason: error?.message || 'Stream Truncate Channel Error',
            userId: actorUserId,
            role: actorRole,
            channelId,
            cleanupMode: 'none',
        });
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Administrative: Removes a member from a channel.
 */
const removeChannelMember = async (user, channelId, memberId, channelType = 'team') => {
    const correlationId =
        user?.correlationId ||
        createCorrelationId('chat_remove_member');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    const role = user.role;
    const isAdmin = ['SuperAdmin', 'superadmin', 'admin', 'SPOCAdmin', 'CollegeAdmin'].includes(role);
    if (!isAdmin) throw new ChatServiceError('Unauthorized: Admin role required', 403);

    try {
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'channel_member_remove_started',
            status: 'chat_moderation',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
            channelId,
        });
        await ChatAuditLog.create({
            messageId: 'N/A',
            channelId,
            action: 'remove_member',
            actorId: user._id || user.id,
            actorName: user.name,
            actorRole: role,
            details: { targetMemberId: memberId }
        });

        const channel = client.channel(channelType, channelId);
        await channel.removeMembers([memberId]);
        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'channel_member_remove_succeeded',
            status: 'chat_moderation',
            outcome: 'succeeded',
            userId: actorUserId,
            role: actorRole,
            channelId,
        });
        return { success: true };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'channel_member_remove_failed',
            status: 'chat_moderation',
            outcome: 'failed',
            reason: error?.message || 'Stream Remove Member Error',
            userId: actorUserId,
            role: actorRole,
            channelId,
            cleanupMode: 'none',
        });
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Super Admin: Deletes an entire channel globally (for all members).
 * Used for group/broadcast channel removal across Trainer + SPOC + Admin views.
 */
const deleteChannelForEveryone = async (user, channelId, channelType = 'messaging') => {
    const correlationId =
        user?.correlationId ||
        createCorrelationId('chat_channel_delete');
    const actorUserId = String(user?._id || user?.id || '');
    const actorRole = user?.role || null;
    const role = user?.role;
    const normalizedRole = normalizePortalRole(role);
    if (normalizedRole !== 'superadmin') {
        throw new ChatServiceError('Unauthorized: Super Admin role required', 403);
    }

    try {
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'channel_delete_for_everyone_started',
            status: 'chat_moderation',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
            channelId: channelId ? String(channelId) : null,
        });
        const normalizedChannelId = String(channelId || '').trim();
        const normalizedType = String(channelType || 'messaging').trim();
        if (!normalizedChannelId) {
            throw new ChatServiceError('channelId is required', 400);
        }

        const channel = client.channel(normalizedType, normalizedChannelId);
        const state = await channel.query({ watch: false, state: true, presence: false });
        const memberIds = Object.keys(state?.members || {});
        const customType = state?.channel?.customType || null;
        const isAnnouncement = Boolean(state?.channel?.is_announcement);
        const isGroup = Boolean(state?.channel?.is_group);

        await ChatAuditLog.create({
            messageId: 'N/A',
            channelId: normalizedChannelId,
            action: 'delete_channel',
            event: 'channel_deleted_globally',
            status: 'success',
            lane: isAnnouncement ? 'broadcast' : (isGroup ? 'group' : 'chat'),
            source: 'stream',
            actorId: (user._id || user.id || '').toString(),
            actorName: user.name || user.email || 'Super Admin',
            actorRole: role,
            senderId: (user._id || user.id || '').toString(),
            senderRole: role,
            targetUserIds: memberIds,
            uiEvent: 'sidebar_refresh',
            details: {
                channelType: normalizedType,
                customType,
                isAnnouncement,
                isGroup,
                memberCount: memberIds.length,
            },
        });

        try {
            await channel.delete({ hard_delete: true });
        } catch (deleteErr) {
            // Fallback for SDK variants that do not accept hard_delete option.
            await channel.delete();
        }

        // Cleanup Mongo mirror records so recreated group/broadcast starts fresh.
        const groupDoc = await Group.findOneAndDelete({ streamChannelId: normalizedChannelId });
        let deletedGroupMembers = 0;
        if (groupDoc?._id) {
            const groupMemberDeleteResult = await GroupMember.deleteMany({ groupId: groupDoc._id });
            deletedGroupMembers = groupMemberDeleteResult?.deletedCount || 0;
        }

        const mirrorChatKey = buildMirrorChatKeyForStreamChannel(normalizedChannelId);
        const candidateChatIds = new Set();
        if (groupDoc?.chatId) {
            candidateChatIds.add(String(groupDoc.chatId));
        }

        const mirrorChatDocs = await Chat.find({
            $or: [
                { chatKey: mirrorChatKey },
                ...(candidateChatIds.size
                    ? [{ _id: { $in: Array.from(candidateChatIds) } }]
                    : []),
            ],
        }).select('_id');

        mirrorChatDocs.forEach((chatDoc) => {
            if (chatDoc?._id) {
                candidateChatIds.add(String(chatDoc._id));
            }
        });

        let deletedChats = 0;
        let deletedMessages = 0;
        if (candidateChatIds.size) {
            const chatIds = Array.from(candidateChatIds);
            const messageDeleteResult = await ChatMessage.deleteMany({ chatId: { $in: chatIds } });
            const chatDeleteResult = await Chat.deleteMany({ _id: { $in: chatIds } });
            deletedMessages = messageDeleteResult?.deletedCount || 0;
            deletedChats = chatDeleteResult?.deletedCount || 0;
        }

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'channel_delete_for_everyone_succeeded',
            status: 'chat_moderation',
            outcome: 'succeeded',
            userId: actorUserId,
            role: actorRole,
            channelId: normalizedChannelId,
        });

        return {
            success: true,
            channelId: normalizedChannelId,
            channelType: normalizedType,
            deletedForUsers: memberIds.length,
            deletedGroupMembers,
            deletedChats,
            deletedMessages,
            customType,
            isAnnouncement,
            isGroup,
        };
    } catch (error) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'channel_delete_for_everyone_failed',
            status: 'chat_moderation',
            outcome: 'failed',
            reason: error?.message || 'Delete Channel Error',
            userId: actorUserId,
            role: actorRole,
            channelId: channelId ? String(channelId) : null,
            cleanupMode: 'none',
        });
        if (error instanceof ChatServiceError) {
            throw error;
        }
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Creates a new broadcast channel (SuperAdmin).
 */
const createBroadcastChannel = async (user, { name, description }, options = {}) => {
    const correlationId =
        options?.correlationId ||
        user?.correlationId ||
        createCorrelationId('chat_broadcast_create');
    const actorUserId =
        user?._id || user?.id
            ? String(user._id || user.id)
            : null;
    const actorRole = user?.role || null;
    let channelId = null;
    try {
        logStreamChatTelemetry('debug', {
            correlationId,
            stage: 'broadcast_channel_create_started',
            status: 'chat_mutation',
            outcome: 'started',
            userId: actorUserId,
            role: actorRole,
        }, {
            logger: options?.logger,
        });

        const userId = (user._id || user.id).toString();
        const normalizedName = String(name || "").trim();
        if (!normalizedName) {
            throw new ChatServiceError('Broadcast name is required', 400);
        }

        const memberUsers = await User.find({
            accountStatus: 'active',
            isActive: { $ne: false },
            role: { $in: CHAT_ENABLED_ROLE_VALUES },
        }).select('_id name profilePicture role');

        const memberIds = Array.from(
            new Set([userId, ...memberUsers.map((member) => String(member._id))])
        );

        await Promise.all(
            memberUsers.map((member) =>
                client.upsertUser({
                    id: String(member._id),
                    name: member.name || String(member._id),
                    image: member.profilePicture || undefined,
                    portal_role: member.role,
                    role: getStreamRole(member.role),
                }),
            ),
        );

        channelId = `broadcast-${Date.now()}`;
        const channel = client.channel('messaging', channelId, {
            name: normalizedName,
            description: description || '',
            created_by_id: userId,
            customType: 'broadcast',
            is_announcement: true,
            is_group: true,
            members: memberIds,
        });
        await channel.create();
        const mirrorChatDoc = await upsertMirrorChatForStreamChannel({
            channelId,
            name: normalizedName,
            memberIds,
            createdBy: userId,
            isBroadcast: true,
        });

        await Group.create({
            name: normalizedName,
            description: description || '',
            createdBy: userId,
            members: memberIds,
            chatId: mirrorChatDoc?._id || null,
            streamChannelId: channelId,
            type: 'broadcast',
        });

        logStreamChatTelemetry('info', {
            correlationId,
            stage: 'broadcast_channel_create_succeeded',
            status: 'chat_mutation',
            outcome: 'succeeded',
            userId: actorUserId,
            role: actorRole,
            channelId,
        }, {
            logger: options?.logger,
        });

        return {
            channelId,
            name: normalizedName,
            members: memberIds,
        };
    } catch (err) {
        logStreamChatTelemetry('error', {
            correlationId,
            stage: 'broadcast_channel_create_failed',
            status: 'chat_mutation',
            outcome: 'failed',
            reason: err?.message || 'Create Broadcast Error',
            userId: actorUserId,
            role: actorRole,
            channelId: channelId ? String(channelId) : null,
            cleanupMode: 'none',
        }, {
            logger: options?.logger,
        });
        throw new ChatServiceError(err.message, 500);
    }
};

const cleanupDeletedUserChatArtifacts = async (user, options = {}) => {
    const correlationId =
        options?.correlationId ||
        user?.correlationId ||
        createCorrelationId("chat_user_cleanup");
    const deletedUserId = String(user?._id || user?.id || "").trim();
    const deletedUserRole = user?.role || null;

    if (!deletedUserId) {
        return {
            cleaned: false,
            deletedUserId: null,
            deletedUserRole,
            affectedUserIds: [],
            localDirectChatsDeleted: 0,
            localGroupChatsUpdated: 0,
            localMessagesDeleted: 0,
            streamDirectChannelsDeleted: 0,
            streamMembershipsRemoved: 0,
            streamMirrorChatsUpdated: 0,
            streamMirrorGroupsUpdated: 0,
            streamMirrorGroupMembersDeleted: 0,
            streamMirrorChatsDeleted: 0,
            streamMirrorMessagesDeleted: 0,
            cachesCleared: 0,
        };
    }

    const deletedUserObjectId = toObjectIdOrNull(deletedUserId);
    const affectedUserIds = new Set([deletedUserId]);
    const summary = {
        cleaned: true,
        deletedUserId,
        deletedUserRole,
        affectedUserIds: [],
        localDirectChatsDeleted: 0,
        localGroupChatsUpdated: 0,
        localMessagesDeleted: 0,
        streamDirectChannelsDeleted: 0,
        streamMembershipsRemoved: 0,
        streamMirrorChatsUpdated: 0,
        streamMirrorGroupsUpdated: 0,
        streamMirrorGroupMembersDeleted: 0,
        streamMirrorChatsDeleted: 0,
        streamMirrorMessagesDeleted: 0,
        cachesCleared: 0,
    };

    logStreamChatTelemetry("info", {
        correlationId,
        stage: "deleted_user_chat_cleanup_started",
        status: "chat_cleanup",
        outcome: "started",
        userId: deletedUserId,
        role: deletedUserRole,
    });

    try {
        if (deletedUserObjectId) {
            const localChats = await Chat.find({
                members: deletedUserObjectId,
            }).select("_id members isGroup chatKey");

            const directChatIds = [];
            const groupChatIds = [];

            localChats.forEach((chatDoc) => {
                const memberIds = Array.isArray(chatDoc?.members)
                    ? chatDoc.members.map((member) => String(member || "").trim()).filter(Boolean)
                    : [];
                memberIds
                    .filter((memberId) => memberId && memberId !== deletedUserId)
                    .forEach((memberId) => affectedUserIds.add(memberId));

                const chatKey = String(chatDoc?.chatKey || "").trim().toLowerCase();
                const isDirectLike =
                    !chatDoc?.isGroup ||
                    chatKey.startsWith("direct:");

                if (isDirectLike) {
                    directChatIds.push(chatDoc._id);
                } else {
                    groupChatIds.push(chatDoc._id);
                }
            });

            if (directChatIds.length) {
                const [messageDeleteResult, directChatDeleteResult] = await Promise.all([
                    ChatMessage.deleteMany({ chatId: { $in: directChatIds } }),
                    Chat.deleteMany({ _id: { $in: directChatIds } }),
                ]);
                summary.localMessagesDeleted += messageDeleteResult?.deletedCount || 0;
                summary.localDirectChatsDeleted += directChatDeleteResult?.deletedCount || 0;
            }

            if (groupChatIds.length) {
                const groupChatUpdateResult = await Chat.updateMany(
                    { _id: { $in: groupChatIds } },
                    {
                        $pull: {
                            members: deletedUserObjectId,
                            hiddenFor: deletedUserObjectId,
                        },
                    },
                );
                summary.localGroupChatsUpdated += groupChatUpdateResult?.modifiedCount || 0;
            }

            const legacyMessageDeleteResult = await ChatMessage.deleteMany({
                chatId: null,
                $or: [
                    { senderId: deletedUserObjectId },
                    { receiverId: deletedUserObjectId },
                ],
            });
            summary.localMessagesDeleted += legacyMessageDeleteResult?.deletedCount || 0;

            const relatedGroups = await Group.find({
                members: deletedUserObjectId,
            }).select("_id members");
            relatedGroups.forEach((groupDoc) => {
                const memberIds = Array.isArray(groupDoc?.members)
                    ? groupDoc.members.map((member) => String(member || "").trim()).filter(Boolean)
                    : [];
                memberIds
                    .filter((memberId) => memberId && memberId !== deletedUserId)
                    .forEach((memberId) => affectedUserIds.add(memberId));
            });

            if (relatedGroups.length) {
                const groupIds = relatedGroups.map((groupDoc) => groupDoc._id);
                await Promise.all([
                    Group.updateMany(
                        { _id: { $in: groupIds } },
                        { $pull: { members: deletedUserObjectId } },
                    ),
                    GroupMember.deleteMany({
                        groupId: { $in: groupIds },
                        userId: deletedUserObjectId,
                    }),
                ]);
            }
        }

        if (isStreamChatConfigured()) {
            try {
                const channels = await client.queryChannels(
                    { members: { $in: [deletedUserId] } },
                    {},
                    { limit: 200, watch: false, state: true, presence: false },
                );

                for (const channel of channels) {
                    const channelId = String(channel?.id || "").trim();
                    if (!channelId) {
                        continue;
                    }

                    const memberIds = getStreamChannelMemberIds(channel);
                    memberIds.forEach((memberId) => affectedUserIds.add(memberId));

                    if (isStreamDirectChannel(channel)) {
                        try {
                            await channel.delete({ hard_delete: true });
                        } catch (deleteError) {
                            await channel.delete();
                        }

                        summary.streamDirectChannelsDeleted += 1;
                        const mirrorDeleteSummary = await cleanupStreamMirrorChannelDelete(channelId);
                        summary.streamMirrorChatsDeleted += mirrorDeleteSummary.deletedChats;
                        summary.streamMirrorMessagesDeleted += mirrorDeleteSummary.deletedMessages;
                        summary.streamMirrorGroupsUpdated += mirrorDeleteSummary.deletedGroups;
                        summary.streamMirrorGroupMembersDeleted += mirrorDeleteSummary.deletedGroupMembers;
                        continue;
                    }

                    try {
                        await channel.removeMembers([deletedUserId]);
                    } catch (removeError) {
                        const message = String(removeError?.message || "").toLowerCase();
                        if (!message.includes("not member")) {
                            throw removeError;
                        }
                    }

                    summary.streamMembershipsRemoved += 1;
                    const mirrorMembershipSummary = await cleanupStreamMirrorChannelMembership(
                        channelId,
                        deletedUserObjectId,
                    );
                    summary.streamMirrorChatsUpdated += mirrorMembershipSummary.updatedChats;
                    summary.streamMirrorGroupsUpdated += mirrorMembershipSummary.updatedGroups;
                    summary.streamMirrorGroupMembersDeleted += mirrorMembershipSummary.deletedGroupMembers;
                }
            } catch (streamCleanupError) {
                logStreamChatTelemetry("warn", {
                    correlationId,
                    stage: "deleted_user_stream_cleanup_failed",
                    status: "chat_cleanup",
                    outcome: "failed",
                    reason: streamCleanupError?.message || "Stream cleanup failed",
                    userId: deletedUserId,
                    role: deletedUserRole,
                    cleanupMode: "stream_partial",
                });
            }
        }

        const cacheUserDocs = await User.find({
            role: { $in: CHAT_ENABLED_ROLE_VALUES },
        }).select("_id");
        cacheUserDocs.forEach((userDoc) => {
            const cacheUserId = String(userDoc?._id || "").trim();
            if (cacheUserId) {
                affectedUserIds.add(cacheUserId);
            }
        });

        summary.cachesCleared = await clearChatCachesForUserIds(
            Array.from(affectedUserIds),
        );
        summary.affectedUserIds = Array.from(affectedUserIds);

        logStreamChatTelemetry("info", {
            correlationId,
            stage: "deleted_user_chat_cleanup_succeeded",
            status: "chat_cleanup",
            outcome: "succeeded",
            userId: deletedUserId,
            role: deletedUserRole,
        });

        return summary;
    } catch (error) {
        logStreamChatTelemetry("error", {
            correlationId,
            stage: "deleted_user_chat_cleanup_failed",
            status: "chat_cleanup",
            outcome: "failed",
            reason: error?.message || "Deleted user chat cleanup failed",
            userId: deletedUserId,
            role: deletedUserRole,
            cleanupMode: "failed",
        });
        throw error;
    }
};

module.exports = {
    ChatServiceError,
    createDirectChannel,
    createGroupChannel,
    addMembersToGroup,
    removeMemberFromGroup,
    createBroadcastChannel,
    createWorkspaceBootstrap,
    createWorkspaceQuickBootstrap,
    createWorkspaceFullBootstrap,
    sendAnnouncementMessage,
    searchMessages,
    generateUserToken,
    updateUserAvatar,
    autoCreateTrainerAdminChannels,
    cleanupDeletedUserChatArtifacts,
    deleteMessage,
    clearChannelMessages,
    removeChannelMember,
    deleteChannelForEveryone,
    __logStreamChatTelemetry: logStreamChatTelemetry,
    getAuditLogs: async (channelId) => {
        return await ChatAuditLog.find({ channelId }).sort({ timestamp: -1 }).limit(50);
    }
};


