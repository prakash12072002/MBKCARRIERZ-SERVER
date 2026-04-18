const Notification = require("../models/Notification");
const User = require("../models/User");
const {
  sendGoogleChatAlert,
  sendNotification,
} = require("../services/notificationService");

const WORKSPACE_ALLOWED_ROLES = new Set([
  "SuperAdmin",
  "SPOCAdmin",
  "CollegeAdmin",
  "Trainer",
  "CompanyAdmin",
  "AccouNDAnt",
]);

const WORKSPACE_ALLOWED_CHANNELS = new Set([
  "in-app",
  "email",
  "sms",
  "whatsapp",
  "google-chat",
]);

const resolveNotificationOwnerId = (req) => req.user?.id || req.user?._id;

const getNotifications = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const startIndex = (page - 1) * limit;
    const ownerId = resolveNotificationOwnerId(req);

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find({ userId: ownerId })
        .select("title message type isRead link createdAt")
        .sort({ createdAt: -1 })
        .skip(startIndex)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ userId: ownerId }),
      Notification.countDocuments({
        userId: ownerId,
        isRead: false,
      }),
    ]);

    res.status(200).json({
      success: true,
      count: notifications.length,
      total,
      unreadCount,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
      },
      data: notifications,
    });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

const markAsRead = async (req, res) => {
  try {
    const ownerId = resolveNotificationOwnerId(req);
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: ownerId },
      { isRead: true },
      { new: true, runValidators: true },
    );

    if (!notification) {
      return res
        .status(404)
        .json({ success: false, message: "Notification not found or unauthorized" });
    }

    res.status(200).json({ success: true, data: notification });
  } catch (error) {
    console.error("Error marking notification read:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

const markAllAsRead = async (req, res) => {
  try {
    const ownerId = resolveNotificationOwnerId(req);

    await Notification.updateMany(
      { userId: ownerId, isRead: false },
      { isRead: true },
    );

    res
      .status(200)
      .json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    console.error("Error marking all notifications read:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

const deleteAllNotifications = async (req, res) => {
  try {
    const ownerId = resolveNotificationOwnerId(req);
    await Notification.deleteMany({ userId: ownerId });
    res.status(200).json({ success: true, message: "All notifications cleared" });
  } catch (error) {
    console.error("Error deleting all notifications:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

const deleteNotification = async (req, res) => {
  try {
    const ownerId = resolveNotificationOwnerId(req);
    const notification = await Notification.findOneAndDelete({ 
      _id: req.params.id, 
      userId: ownerId 
    });
    
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    
    res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

const dispatchWorkspaceNotification = async (req, res) => {
  try {
    const {
      title,
      message,
      type = "Chat",
      link = null,
      channels = ["in-app"],
      recipients = [],
      recipientRoles = [],
      senderName = null,
      roomName = null,
      audience = null,
    } = req.body || {};

    const trimmedTitle = String(title || "").trim();
    const trimmedMessage = String(message || "").trim();

    if (!trimmedTitle || !trimmedMessage) {
      return res.status(400).json({
        success: false,
        message: "title and message are required",
      });
    }

    if (type === "Announcement" && req.user.role !== "SuperAdmin") {
      return res.status(403).json({
        success: false,
        message: "Only Admin can dispatch announcement notifications",
      });
    }

    const normalizedChannels = Array.from(
      new Set(
        (Array.isArray(channels) ? channels : ["in-app"]).filter((channel) =>
          WORKSPACE_ALLOWED_CHANNELS.has(channel),
        ),
      ),
    );

    const explicitUserIds = Array.from(
      new Set(
        (Array.isArray(recipients) ? recipients : [])
          .map((recipient) => String(recipient?.userId || "").trim())
          .filter(Boolean),
      ),
    );

    const normalizedRecipientRoles = Array.from(
      new Set(
        (Array.isArray(recipientRoles) ? recipientRoles : [])
          .map((role) => String(role || "").trim())
          .filter((role) => WORKSPACE_ALLOWED_ROLES.has(role)),
      ),
    );

    const [explicitUsers, roleUsers] = await Promise.all([
      explicitUserIds.length > 0
        ? User.find({ _id: { $in: explicitUserIds } }).select("_id role name")
        : [],
      normalizedRecipientRoles.length > 0
        ? User.find({
            role: { $in: normalizedRecipientRoles },
            isActive: { $ne: false },
          }).select("_id role name")
        : [],
    ]);

    const senderId = String(resolveNotificationOwnerId(req));
    const resolvedRecipients = [];
    const seenRecipients = new Set();

    [...explicitUsers, ...roleUsers].forEach((user) => {
      const userId = String(user._id);

      if (!userId || userId === senderId || seenRecipients.has(userId)) {
        return;
      }

      seenRecipients.add(userId);
      resolvedRecipients.push(user);
    });

    const wantsInAppDelivery = normalizedChannels.includes("in-app");

    if (wantsInAppDelivery && resolvedRecipients.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No workspace recipients were resolved for in-app delivery",
      });
    }

    const dispatchResults = await Promise.all(
      resolvedRecipients.map((recipient) =>
        sendNotification(req.io, {
          userId: recipient._id,
          role: recipient.role,
          title: trimmedTitle,
          message: trimmedMessage,
          type,
          link,
          channels: normalizedChannels.filter((channel) => channel !== "google-chat"),
        }),
      ),
    );

    let googleChatResult = null;
    if (normalizedChannels.includes("google-chat")) {
      googleChatResult = await sendGoogleChatAlert({
        title: trimmedTitle,
        message: trimmedMessage,
        senderName: senderName || req.user.name || req.user.email || "Workspace",
        roomName,
        audience,
        link,
      });
    }

    res.status(200).json({
      success: true,
      message: "Workspace notification dispatched",
      recipientsResolved: resolvedRecipients.length,
      channels: normalizedChannels,
      googleChat: googleChatResult,
      data: dispatchResults,
    });
  } catch (error) {
    console.error("Error dispatching workspace notification:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

module.exports = {
  dispatchWorkspaceNotification,
  getNotifications,
  markAllAsRead,
  markAsRead,
  deleteAllNotifications,
  deleteNotification
};
