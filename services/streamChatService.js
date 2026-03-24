require('dotenv').config();
const { StreamChat } = require('stream-chat');

const apiKey = process.env.STREAM_CHAT_API_KEY;
const apiSecret = process.env.STREAM_CHAT_API_SECRET;
const announcementChannelId = process.env.STREAM_CHAT_ANNOUNCEMENT_CHANNEL_ID || 'portal-announcements';

if (!apiKey || !apiSecret) {
    console.warn('Stream Chat credentials not found in environment variables.');
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
const { getCachedChats, setCachedChats } = require("./chatCacheService");

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
    try {
        if (!user || (!user._id && !user.id)) {
            throw new ChatServiceError('User identification required', 400);
        }

        const userId = (user._id || user.id).toString();

        // ── Redis Cache Check via Service ──────────────────────────
        const cached = await getCachedChats(userId);
        if (cached && cached.data && cached.data.activeChannels) {
            return cached.data;
        }

        const role = user.role;
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

        return result;
    } catch (error) {
        console.error('Stream Chat Bootstrap Error:', error);
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Quick Bootstrap: Generates token and basic info instantly (no DB queries).
 */
const createWorkspaceQuickBootstrap = async (user) => {
    try {
        if (!user || (!user._id && !user.id)) {
            throw new ChatServiceError('User identification required', 400);
        }

        const userId = (user._id || user.id).toString();
        const role = user.role;
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
                    console.log(`[QB] Trainer ${user.name} has 0 channels. Auto-creating...`);
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
                        console.log(`[QB] Auto-created ${adminUsers.length} channel(s) for Trainer ${user.name}`);
                    }
                }
            } catch (e) {
                // Non-fatal — just log and continue
                console.warn('[QB] Trainer channel auto-create failed:', e?.message);
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
        console.error('Stream Chat Quick Bootstrap Error:', error);
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Full Bootstrap: Fetches heavy contact lists for modals
 */
const createWorkspaceFullBootstrap = async (user) => {
    try {
        if (!user || (!user._id && !user.id)) {
            throw new ChatServiceError('User identification required', 400);
        }

        const userId = (user._id || user.id).toString();
        const role = user.role;
        const normalizedRole = normalizePortalRole(role);

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
            console.log(`[Cache] Background revalidation completed for contacts_${userId}`);
            return freshResult;
        };

        // If we have a cache hit
        if (cached && cached.data && cached.data.groupCandidates && cached.data.groupCandidates.length > 0) {
            // STALE-WHILE-REVALIDATE: Trigger background refresh if stale
            if (cached.isStale) {
                fetchFreshData().catch(e => console.error("[Cache] Background revalidation failed:", e));
            }
            return cached.data;
        }

        // Cache miss or empty candidates: wait for fresh data
        console.log(`[Bootstrap] Fetching fresh data for ${userId} (role: ${role})`);
        return await fetchFreshData();
    } catch (error) {
        console.error('Stream Chat Full Bootstrap Error:', error);
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Creates a 1:1 channel between the current user and another member.
 */
const createDirectChannel = async (user, body) => {
    try {
        const { memberId, portalUserId } = body || {};
        const targetId = memberId || portalUserId;
        if (!targetId) {
            throw new ChatServiceError('Member ID is required for direct channel', 400);
        }

        const userId = (user._id || user.id).toString();
        const targetUserId = targetId.toString();
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
        console.error('Stream Chat Direct Channel Error:', error);
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
    try {
        const { name, memberIds, portalUserIds, description } = body || {};
        const normalizedCreatorRole = normalizePortalRole(user?.role);
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
        console.error('Stream Chat Group Channel Error:', error);
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
    try {
        const normalizedActorRole = normalizePortalRole(user?.role);
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

        return { success: true, addedMemberIds: safeMemberIds };
    } catch (error) {
        console.error('Add Members Error:', error);
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
    try {
        const normalizedActorRole = normalizePortalRole(user?.role);
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

        return { success: true };
    } catch (error) {
        console.error('Remove Member Error:', error);
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
    try {
        const { text, attachments } = body;
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

        return { messageId: message.message.id };
    } catch (error) {
        console.error('Stream Chat Announcement Error:', error);
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Updates a user's avatar/profile picture in Stream Chat.
 */
const updateUserAvatar = async (userId, imageUrl) => {
    try {
        if (!userId) throw new ChatServiceError('User ID is required', 400);
        const updateObj = { id: userId.toString() };
        if (imageUrl) {
            updateObj.set = { image: imageUrl };
        } else {
            updateObj.unset = ['image'];
        }
        await client.partialUpdateUser(updateObj);
        return { success: true };
    } catch (error) {
        console.error('Stream Chat Avatar Update Error:', error);
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Generates a standalone token for a user.
 */
const generateUserToken = async (user) => {
    try {
        const userId = (user._id || user.id).toString();
        return { token: client.createToken(userId) };
    } catch (error) {
        console.error('Stream Chat Token Generation Error:', error);
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
const autoCreateTrainerAdminChannels = async (trainerUser, adminUsers) => {
    try {
        if (!trainerUser || !adminUsers || adminUsers.length === 0) return;

        const trainerId = (trainerUser._id || trainerUser.id).toString();

        // Ensure Trainer is upserted
        await client.upsertUser({
            id: trainerId,
            name: trainerUser.name || trainerUser.email || trainerId,
            image: trainerUser.profilePicture || undefined,
            portal_role: trainerUser.role,
            role: 'admin'
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
                role: 'admin'
            });

            // Create a 1:1 direct messaging channel
            const channel = client.channel('messaging', {
                members: [trainerId, adminId],
                created_by_id: adminId, // Make the admin the creator
                customType: 'direct'
            });

            return channel.create();
        });

        await Promise.allSettled(channelPromises);
        console.log(`[StreamChat] Auto-created channels for Trainer ${trainerUser.email} with ${adminUsers.length} admin(s).`);
    } catch (error) {
        console.error('Stream Chat Auto-Create Channel Error:', error);
        // We do not throw here to prevent blocking the main business logic (e.g., registration)
    }
};

/**
 * Native Message Search using Stream's Edge ElasticSearch
 * Searches for messages containing the keyword within channels the user is a member of.
 */
const searchMessages = async (userId, query) => {
    try {
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

        return { results: searchResults.results };
    } catch (error) {
        console.error('Stream Message Search Error:', error);
        throw new ChatServiceError(error.message, 500);
    }
};

const ChatAuditLog = require('../models/ChatAuditLog');

/**
 * Administrative: Deletes a message.
 */
const deleteMessage = async (user, messageId) => {
    const role = user.role;
    const isAdmin = ['SuperAdmin', 'superadmin', 'admin', 'SPOCAdmin', 'CollegeAdmin'].includes(role);
    if (!isAdmin) throw new ChatServiceError('Unauthorized: Admin role required', 403);

    try {
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
        return { success: true };
    } catch (error) {
        console.error('Stream Delete Message Error:', error);
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
    const role = user.role;
    const isAdmin = ['SuperAdmin', 'superadmin', 'admin', 'SPOCAdmin', 'CollegeAdmin'].includes(role);
    if (!isAdmin) throw new ChatServiceError('Unauthorized: Admin role required', 403);

    try {
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
        return { success: true };
    } catch (error) {
        console.error('Stream Truncate Channel Error:', error);
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Administrative: Removes a member from a channel.
 */
const removeChannelMember = async (user, channelId, memberId, channelType = 'team') => {
    const role = user.role;
    const isAdmin = ['SuperAdmin', 'superadmin', 'admin', 'SPOCAdmin', 'CollegeAdmin'].includes(role);
    if (!isAdmin) throw new ChatServiceError('Unauthorized: Admin role required', 403);

    try {
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
        return { success: true };
    } catch (error) {
        console.error('Stream Remove Member Error:', error);
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Super Admin: Deletes an entire channel globally (for all members).
 * Used for group/broadcast channel removal across Trainer + SPOC + Admin views.
 */
const deleteChannelForEveryone = async (user, channelId, channelType = 'messaging') => {
    const role = user?.role;
    const normalizedRole = normalizePortalRole(role);
    if (normalizedRole !== 'superadmin') {
        throw new ChatServiceError('Unauthorized: Super Admin role required', 403);
    }

    try {
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
        console.error('Delete Channel Error:', error);
        if (error instanceof ChatServiceError) {
            throw error;
        }
        throw new ChatServiceError(error.message, 500);
    }
};

/**
 * Creates a new broadcast channel (SuperAdmin).
 */
const createBroadcastChannel = async (user, { name, description }) => {
    try {
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

        const channelId = `broadcast-${Date.now()}`;
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

        return {
            channelId,
            name: normalizedName,
            members: memberIds,
        };
    } catch (err) {
        console.error('Create Broadcast Error:', err);
        throw new ChatServiceError(err.message, 500);
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
    deleteMessage,
    clearChannelMessages,
    removeChannelMember,
    deleteChannelForEveryone,
    getAuditLogs: async (channelId) => {
        return await ChatAuditLog.find({ channelId }).sort({ timestamp: -1 }).limit(50);
    }
};


