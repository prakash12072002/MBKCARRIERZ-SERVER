const plivo = require("plivo");
require("dotenv").config();

const authId = process.env.PLIVO_AUTH_ID;
const authToken = process.env.PLIVO_AUTH_TOKEN;
const sourceNumber = process.env.PLIVO_SOURCE_NUMBER; // Global source number
const senderId = process.env.PLIVO_SENDER_ID; // India DLT Header (e.g., ANTGRV)
const dltEntityId = process.env.DLT_ENTITY_ID;

// Template IDs (These should ideally be in a DB or config)
const DLT_TEMPLATES = {
  VERIFICATION: process.env.DLT_TE_ID_VERIFICATION,
  RESET: process.env.DLT_TE_ID_RESET,
};

let client;

try {
  if (authId && authToken) {
    client = new plivo.Client(authId, authToken);
  } else {
    console.warn("Plivo credentials missing. SMS service will be disabled.");
  }
} catch (error) {
  console.error("Error initializing Plivo client:", error);
}

/**
 * Send an SMS message
 * @param {string} to - The recipient's phone number
 * @param {string} body - The message body
 * @param {string} templateType - Type of message (VERIFICATION, RESET) for DLT lookup
 * @returns {Promise<object>} - The Plivo message object
 */
const sendSMS = async (to, body, templateType = null) => {
  if (!client) {
    console.log(
      `[Mock SMS] To: ${to}, Body: ${body}, Template: ${templateType}`,
    );
    return { messageUuid: "mock_uuid", status: "sent" };
  }

  try {
    const isIndia = to.startsWith("+91");
    let src = sourceNumber;
    let dltParams = {};

    if (isIndia) {
      src = senderId; // Use 6-char Header for India
      if (dltEntityId && templateType && DLT_TEMPLATES[templateType]) {
        dltParams = {
          dlt_entity_id: dltEntityId,
          dlt_template_id: DLT_TEMPLATES[templateType],
        };
      } else {
        console.warn(
          "Sending to India without full DLT params. Message may be blocked.",
        );
      }
    }

    const payload = {
      src,
      dst: to,
      text: body,
      ...dltParams,
    };

    const response = await client.messages.create(payload);
    console.log(`SMS sent to ${to}: ${response.messageUuid}`);
    return response;
  } catch (error) {
    console.error("Error sending SMS:", error);
    throw error;
  }
};

/**
 * Send verification SMS
 * @param {string} phone - User's phone number
 * @param {string} token - Verification token or code
 */
const sendVerificationSMS = async (phone, token) => {
  // Ensure the body matches the registered DLT template EXACTLY
  // Example: "Dear User, your OTP for mbkcarrierz login is {#var#}. Do not share this."
  const message = `Dear User, your OTP for mbkcarrierz login is ${token}. Do not share this.`;
  return sendSMS(phone, message, "VERIFICATION");
};

/**
 * Send password reset SMS
 * @param {string} phone - User's phone number
 * @param {string} token - Reset token or temporary password
 */
const sendPasswordResetSMS = async (phone, token) => {
  // Example: "Dear User, your password reset code is {#var#}. Use this to reset your password."
  const message = `Dear User, your password reset code is ${token}. Use this to reset your password.`;
  return sendSMS(phone, message, "RESET");
};

module.exports = {
  sendSMS,
  sendVerificationSMS,
  sendPasswordResetSMS,
};
