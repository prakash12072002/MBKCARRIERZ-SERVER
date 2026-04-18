const axios = require("axios");
const twilio = require("twilio");
const Notification = require("../models/Notification");
const {
  createCorrelationId,
  createStructuredLogger,
} = require("../shared/utils/structuredLogger");

let client = null;

const notificationLogger = createStructuredLogger({
  service: "notifications",
  component: "notification-service",
});

const logNotificationTelemetry = (level, fields = {}, options = {}) => {
  const logger = options.logger || notificationLogger;
  const method =
    typeof logger?.[level] === "function"
      ? level
      : typeof logger?.info === "function"
        ? "info"
        : null;
  if (!method) return;

  logger[method]({
    correlationId: fields.correlationId || createCorrelationId("notification"),
    stage: fields.stage || "notification_event",
    status: fields.status || "notification",
    outcome: fields.outcome || "unknown",
    attempt: Number.isFinite(fields.attempt) ? fields.attempt : null,
    cleanupMode: fields.cleanupMode || "none",
    reason: fields.reason || null,
    notifyChannel: fields.notifyChannel || null,
    userId: fields.userId || null,
    role: fields.role || null,
    phoneNumber: fields.phoneNumber || null,
    roomName: fields.roomName || null,
    audience: fields.audience || null,
    title: fields.title || null,
  });
};

try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
    );
  }
} catch (error) {
  logNotificationTelemetry("warn", {
    stage: "twilio_client_init_failed",
    status: "notification_setup",
    outcome: "failed",
    reason: error?.message || "Twilio init failed",
  });
}

const formatScheduleMessage = (trainerName, college, schedules) => {
  let message = `Hello ${trainerName}!\n\n`;
  message += `You have been assigned to ${college.name}.\n`;

  if (college.location?.address) {
    message += `Location: ${college.location.address}\n`;
  }

  const mapLink =
    college.location?.mapUrl ||
    (college.location?.lat && college.location?.lng
      ? `https://www.google.com/maps?q=${college.location.lat},${college.location.lng}`
      : null);

  if (mapLink) {
    message += `Map: ${mapLink}\n`;
  }

  message += "\nYour Schedule:\n";

  schedules.forEach((schedule, index) => {
    message += `${index + 1}. ${schedule.dayOfWeek}: ${schedule.startTime} - ${schedule.endTime}`;
    if (schedule.subject) {
      message += ` (${schedule.subject})`;
    }
    message += "\n";
  });

  message += "\nPlease confirm your availability.";
  return message;
};

const sendSMS = async (phoneNumber, message, options = {}) => {
  const twilioClient =
    Object.prototype.hasOwnProperty.call(options, "twilioClient")
      ? options.twilioClient
      : client;
  const correlationId =
    options.correlationId || createCorrelationId("notification_sms");

  if (!twilioClient) {
    logNotificationTelemetry(
      "warn",
      {
        correlationId,
        stage: "sms_send_skipped_unconfigured",
        status: "notification_dispatch",
        outcome: "skipped",
        reason: "Twilio not configured",
        notifyChannel: "sms",
        phoneNumber,
      },
      options,
    );
    return { success: false, skipped: true, error: "Twilio not configured" };
  }

  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber,
    });

    logNotificationTelemetry(
      "info",
      {
        correlationId,
        stage: "sms_sent",
        status: "notification_dispatch",
        outcome: "succeeded",
        notifyChannel: "sms",
        phoneNumber,
      },
      options,
    );
    return { success: true, sid: result.sid };
  } catch (error) {
    logNotificationTelemetry(
      "warn",
      {
        correlationId,
        stage: "sms_send_failed",
        status: "notification_dispatch",
        outcome: "failed",
        reason: error?.message || "SMS failed",
        notifyChannel: "sms",
        phoneNumber,
      },
      options,
    );
    return { success: false, error: error.message };
  }
};

const sendWhatsApp = async (phoneNumber, contentVariables = {}, options = {}) => {
  const twilioClient =
    Object.prototype.hasOwnProperty.call(options, "twilioClient")
      ? options.twilioClient
      : client;
  const correlationId =
    options.correlationId || createCorrelationId("notification_whatsapp");

  if (!twilioClient) {
    logNotificationTelemetry(
      "warn",
      {
        correlationId,
        stage: "whatsapp_send_skipped_unconfigured",
        status: "notification_dispatch",
        outcome: "skipped",
        reason: "Twilio not configured",
        notifyChannel: "whatsapp",
        phoneNumber,
      },
      options,
    );
    return { success: false, skipped: true, error: "Twilio not configured" };
  }

  try {
    const variables =
      Object.keys(contentVariables).length > 0
        ? contentVariables
        : { "1": "today", "2": "TBD" };

    const formattedPhone = phoneNumber.startsWith("+")
      ? phoneNumber
      : `+91${phoneNumber}`;

    const result = await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || "+14155238886"}`,
      contentSid:
        process.env.TWILIO_WHATSAPP_CONTENT_SID ||
        "HXb5b62575e6e4ff6129ad7c8efe1f983e",
      contentVariables: JSON.stringify(variables),
      to: `whatsapp:${formattedPhone}`,
    });

    logNotificationTelemetry(
      "info",
      {
        correlationId,
        stage: "whatsapp_sent",
        status: "notification_dispatch",
        outcome: "succeeded",
        notifyChannel: "whatsapp",
        phoneNumber,
      },
      options,
    );
    return { success: true, sid: result.sid };
  } catch (error) {
    logNotificationTelemetry(
      "warn",
      {
        correlationId,
        stage: "whatsapp_send_failed",
        status: "notification_dispatch",
        outcome: "failed",
        reason: error?.message || "WhatsApp failed",
        notifyChannel: "whatsapp",
        phoneNumber,
      },
      options,
    );
    return { success: false, error: error.message };
  }
};

const sendGoogleChatAlert = async (
  {
    title,
    message,
    senderName = null,
    roomName = null,
    audience = null,
    link = null,
  },
  options = {},
) => {
  const correlationId =
    options.correlationId || createCorrelationId("notification_google_chat");
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;

  if (!webhookUrl) {
    logNotificationTelemetry(
      "warn",
      {
        correlationId,
        stage: "google_chat_skipped_unconfigured",
        status: "notification_dispatch",
        outcome: "skipped",
        reason: "GOOGLE_CHAT_WEBHOOK_URL is not configured",
        notifyChannel: "google-chat",
        roomName,
        audience,
        title,
      },
      options,
    );
    return {
      success: false,
      skipped: true,
      error: "GOOGLE_CHAT_WEBHOOK_URL is not configured",
    };
  }

  const lines = [
    title,
    message,
    roomName ? `Room: ${roomName}` : null,
    senderName ? `From: ${senderName}` : null,
    audience ? `Audience: ${audience}` : null,
    link ? `Link: ${link}` : null,
  ].filter(Boolean);

  try {
    await axios.post(
      webhookUrl,
      { text: lines.join("\n") },
      { timeout: 5000, headers: { "Content-Type": "application/json" } },
    );

    logNotificationTelemetry(
      "info",
      {
        correlationId,
        stage: "google_chat_sent",
        status: "notification_dispatch",
        outcome: "succeeded",
        notifyChannel: "google-chat",
        roomName,
        audience,
        title,
      },
      options,
    );
    return { success: true };
  } catch (error) {
    logNotificationTelemetry(
      "warn",
      {
        correlationId,
        stage: "google_chat_send_failed",
        status: "notification_dispatch",
        outcome: "failed",
        reason: error?.message || "Google Chat delivery failed",
        notifyChannel: "google-chat",
        roomName,
        audience,
        title,
      },
      options,
    );
    return { success: false, error: error.message };
  }
};

const notifyTrainerSchedule = async (trainer, college, schedules, options = {}) => {
  const correlationId =
    options.correlationId || createCorrelationId("notification_schedule");
  const message = formatScheduleMessage(trainer.name, college, schedules);

  const results = {
    sms: null,
    whatsapp: null,
  };

  if (trainer.phone) {
    results.sms = await sendSMS(trainer.phone, message, {
      ...options,
      correlationId,
    });
    results.whatsapp = await sendWhatsApp(
      trainer.phone,
      {
        "1": "today",
        "2": schedules?.[0]?.startTime || "TBD",
      },
      {
        ...options,
        correlationId,
      },
    );
  } else {
    logNotificationTelemetry(
      "warn",
      {
        correlationId,
        stage: "schedule_notification_phone_missing",
        status: "notification_dispatch",
        outcome: "skipped",
        reason: "No phone number for trainer",
        notifyChannel: "sms_whatsapp",
        phoneNumber: null,
      },
      options,
    );
  }

  return results;
};

const sendNotification = async (
  io,
  {
    userId,
    role,
    title,
    message,
    type = "System",
    link = null,
    channels = ["in-app"],
    phone = null,
    whatsappVariables = null,
    googleChatPayload = null,
    correlationId: payloadCorrelationId = null,
  },
  options = {},
) => {
  const correlationId =
    payloadCorrelationId ||
    options.correlationId ||
    createCorrelationId("notification_dispatch");
  const createInAppNotificationLoader =
    options.createInAppNotificationLoader || Notification.create.bind(Notification);
  const sendSMSLoader = options.sendSMSLoader || sendSMS;
  const sendWhatsAppLoader = options.sendWhatsAppLoader || sendWhatsApp;
  const sendGoogleChatAlertLoader =
    options.sendGoogleChatAlertLoader || sendGoogleChatAlert;

  try {
    const normalizedChannels =
      Array.isArray(channels) && channels.length > 0 ? channels : ["in-app"];
    const results = { db: null, socket: false, channels: {} };

    if (normalizedChannels.includes("in-app")) {
      if (!userId || !role) {
        throw new Error("userId and role are required for in-app notifications");
      }

      const notification = await createInAppNotificationLoader({
        userId,
        role,
        title,
        message,
        type,
        link,
        isRead: false,
      });

      results.db = notification;

      if (io) {
        io.emit(`notification_${userId}`, notification);
        results.socket = true;
      }

      logNotificationTelemetry(
        "debug",
        {
          correlationId,
          stage: "in_app_notification_created",
          status: "notification_dispatch",
          outcome: "succeeded",
          notifyChannel: "in-app",
          userId,
          role,
          title,
        },
        options,
      );
    }

    if (normalizedChannels.includes("email")) {
      logNotificationTelemetry(
        "info",
        {
          correlationId,
          stage: "email_stub_sent",
          status: "notification_dispatch",
          outcome: "succeeded",
          notifyChannel: "email",
          userId,
          role,
          title,
        },
        options,
      );
      results.channels.email = "stub_success";
    }

    if (normalizedChannels.includes("sms")) {
      results.channels.sms = phone
        ? await sendSMSLoader(phone, `${title}\n${message}`, {
            ...options,
            correlationId,
          })
        : {
            success: false,
            skipped: true,
            error: "phone number required",
          };
    }

    if (normalizedChannels.includes("whatsapp")) {
      results.channels.whatsapp = phone
        ? await sendWhatsAppLoader(
            phone,
            whatsappVariables || { "1": "soon", "2": "TBD" },
            {
              ...options,
              correlationId,
            },
          )
        : {
            success: false,
            skipped: true,
            error: "phone number required",
          };
    }

    if (normalizedChannels.includes("google-chat")) {
      results.channels.googleChat = await sendGoogleChatAlertLoader(
        {
          title,
          message,
          link,
          ...(googleChatPayload || {}),
        },
        {
          ...options,
          correlationId,
        },
      );
    }

    return { success: true, results };
  } catch (error) {
    logNotificationTelemetry(
      "error",
      {
        correlationId,
        stage: "notification_dispatch_failed",
        status: "notification_dispatch",
        outcome: "failed",
        reason: error?.message || "Notification dispatch failed",
        notifyChannel: "multi",
        userId,
        role,
        title,
      },
      options,
    );
    return { success: false, error: error.message };
  }
};

const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    logNotificationTelemetry("debug", {
      correlationId: createCorrelationId("notification_push"),
      stage: "push_notification_stub_sent",
      status: "notification_dispatch",
      outcome: "succeeded",
      notifyChannel: "push",
      userId,
      title,
    });

    return true;
  } catch (err) {
    logNotificationTelemetry("warn", {
      correlationId: createCorrelationId("notification_push"),
      stage: "push_notification_failed",
      status: "notification_dispatch",
      outcome: "failed",
      reason: err?.message || "Push notification failed",
      notifyChannel: "push",
      userId,
      title,
    });
    return false;
  }
};

const sendEmailNotification = async (email, subject, text) => {
  try {
    logNotificationTelemetry("debug", {
      correlationId: createCorrelationId("notification_email"),
      stage: "email_notification_stub_sent",
      status: "notification_dispatch",
      outcome: "succeeded",
      notifyChannel: "email",
      userId: email || "unknown_email@domain.com",
      title: subject,
    });

    return true;
  } catch (err) {
    logNotificationTelemetry("warn", {
      correlationId: createCorrelationId("notification_email"),
      stage: "email_notification_failed",
      status: "notification_dispatch",
      outcome: "failed",
      reason: err?.message || "Email notification failed",
      notifyChannel: "email",
      userId: email || "unknown_email@domain.com",
      title: subject,
    });
    return false;
  }
};

const handleNewMessageNotification = async (payload) => {
  const correlationId = createCorrelationId("notification_new_message");
  try {
    const { message, channel, user: sender } = payload;
    if (!message || !channel) return;

    const title = `New message in ${channel.name || "Chat"}`;
    const body = `${sender.name}: ${message.text?.substring(0, 50)}${message.text?.length > 50 ? "..." : ""}`;
    const data = { channelId: channel.id, messageId: message.id };

    await sendPushNotification("offline_member_id_mock", title, body, data);

    await sendEmailNotification(
      "offline_member_id_mock",
      `Unread message from ${sender.name}`,
      `You have unread messages in ${channel.name}.\n\n"${body}"\n\nLog in to reply.`,
    );
  } catch (err) {
    logNotificationTelemetry("warn", {
      correlationId,
      stage: "new_message_notification_failed",
      status: "notification_dispatch",
      outcome: "failed",
      reason: err?.message || "New message notification failed",
      notifyChannel: "push_email_fallback",
      title: "New message notification",
    });
  }
};

module.exports = {
  formatScheduleMessage,
  notifyTrainerSchedule,
  sendGoogleChatAlert,
  sendNotification,
  sendSMS,
  sendWhatsApp,
  sendPushNotification,
  sendEmailNotification,
  handleNewMessageNotification,
};
