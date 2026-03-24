const axios = require("axios");
const twilio = require("twilio");
const Notification = require("../models/Notification");

let client = null;

try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
    );
  }
} catch (error) {
  console.warn("Twilio not configured:", error.message);
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

const sendSMS = async (phoneNumber, message) => {
  if (!client) {
    console.warn("Twilio not configured. SMS not sent.");
    return { success: false, skipped: true, error: "Twilio not configured" };
  }

  try {
    const result = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber,
    });

    console.log(`SMS sent to ${phoneNumber}: ${result.sid}`);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error(`SMS failed to ${phoneNumber}:`, error.message);
    return { success: false, error: error.message };
  }
};

const sendWhatsApp = async (phoneNumber, contentVariables = {}) => {
  if (!client) {
    console.warn("Twilio not configured. WhatsApp not sent.");
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

    const result = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || "+14155238886"}`,
      contentSid:
        process.env.TWILIO_WHATSAPP_CONTENT_SID ||
        "HXb5b62575e6e4ff6129ad7c8efe1f983e",
      contentVariables: JSON.stringify(variables),
      to: `whatsapp:${formattedPhone}`,
    });

    console.log(`WhatsApp template sent to ${phoneNumber}: ${result.sid}`);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error(`WhatsApp template failed to ${phoneNumber}:`, error.message);
    return { success: false, error: error.message };
  }
};

const sendGoogleChatAlert = async ({
  title,
  message,
  senderName = null,
  roomName = null,
  audience = null,
  link = null,
}) => {
  const webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;

  if (!webhookUrl) {
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

    return { success: true };
  } catch (error) {
    console.error("Google Chat webhook delivery failed:", error.message);
    return { success: false, error: error.message };
  }
};

const notifyTrainerSchedule = async (trainer, college, schedules) => {
  const message = formatScheduleMessage(trainer.name, college, schedules);

  const results = {
    sms: null,
    whatsapp: null,
  };

  if (trainer.phone) {
    results.sms = await sendSMS(trainer.phone, message);
    results.whatsapp = await sendWhatsApp(trainer.phone, {
      "1": "today",
      "2": schedules?.[0]?.startTime || "TBD",
    });
  } else {
    console.warn(`No phone number for trainer: ${trainer.name}`);
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
  },
) => {
  try {
    const normalizedChannels =
      Array.isArray(channels) && channels.length > 0 ? channels : ["in-app"];
    const results = { db: null, socket: false, channels: {} };

    if (normalizedChannels.includes("in-app")) {
      if (!userId || !role) {
        throw new Error("userId and role are required for in-app notifications");
      }

      const notification = await Notification.create({
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
    }

    if (normalizedChannels.includes("email")) {
      console.log(`[STUB] Sending EMAIL to User ${userId}: ${title}`);
      results.channels.email = "stub_success";
    }

    if (normalizedChannels.includes("sms")) {
      results.channels.sms = phone
        ? await sendSMS(phone, `${title}\n${message}`)
        : {
            success: false,
            skipped: true,
            error: "phone number required",
          };
    }

    if (normalizedChannels.includes("whatsapp")) {
      results.channels.whatsapp = phone
        ? await sendWhatsApp(
            phone,
            whatsappVariables || { "1": "soon", "2": "TBD" },
          )
        : {
            success: false,
            skipped: true,
            error: "phone number required",
          };
    }

    if (normalizedChannels.includes("google-chat")) {
      results.channels.googleChat = await sendGoogleChatAlert({
        title,
        message,
        link,
        ...(googleChatPayload || {}),
      });
    }

    return { success: true, results };
  } catch (error) {
    console.error("Error dispatching unified notification:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Simulates sending a Browser Push Notification
 */
const sendPushNotification = async (userId, title, body, data = {}) => {
    try {
        console.log(`\n🔔 [Notification: PUSH] -> User: ${userId}`);
        console.log(`   Title: ${title}`);
        console.log(`   Body:  ${body}`);
        console.log(`   Data:  `, data);
        
        return true;
    } catch (err) {
        console.error(`[Notification] Push error:`, err.message);
        return false;
    }
};

/**
 * Simulates sending an Email Fallback (if user is offline)
 */
const sendEmailNotification = async (email, subject, text) => {
    try {
        console.log(`\n📧 [Notification: EMAIL] -> To: ${email || 'unknown_email@domain.com'}`);
        console.log(`   Subject: ${subject}`);
        console.log(`   Text:    ${text}\n`);
        
        return true;
    } catch (err) {
        console.error(`[Notification] Email error:`, err.message);
        return false;
    }
};

/**
 * Orchestrator: Decides how to notify a user about a new chat message.
 * Triggered asynchronously by the Redis Event Bus.
 */
const handleNewMessageNotification = async (payload) => {
    try {
        const { message, channel, user: sender } = payload;
        if (!message || !channel) return;

        // Example logic: Notify the members who aren't the sender.
        const title = `New message in ${channel.name || 'Chat'}`;
        const body = `${sender.name}: ${message.text?.substring(0, 50)}${message.text?.length > 50 ? '...' : ''}`;
        const data = { channelId: channel.id, messageId: message.id };

        // 1. Send Browser Push Notification
        await sendPushNotification('offline_member_id_mock', title, body, data);

        // 2. Schedule or Send Email Fallback
        await sendEmailNotification(
            'offline_member_id_mock', 
            `Unread message from ${sender.name}`, 
            `You have unread messages in ${channel.name}.\n\n"${body}"\n\nLog in to reply.`
        );

    } catch (err) {
        console.error(`[Notification] handleNewMessageNotification error:`, err);
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
  handleNewMessageNotification
};
