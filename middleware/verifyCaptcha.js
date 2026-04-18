const crypto = require("crypto");

const CAPTCHA_SECRET = process.env.SESSION_SECRET || "mbkcarrierz-secret";
const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 minutes

function signCaptcha(text, issuedAt) {
  return crypto
    .createHmac("sha256", CAPTCHA_SECRET)
    .update(`${text}:${issuedAt}`)
    .digest("hex");
}

const verifyCaptcha = (req, res, next) => {
  const captchaPayload = req.body?.captcha;
  const userInput =
    typeof captchaPayload === "string"
      ? captchaPayload.trim()
      : typeof captchaPayload?.value === "string"
        ? captchaPayload.value.trim()
        : "";
  const captchaToken =
    typeof req.body?.captchaToken === "string"
      ? req.body.captchaToken.trim()
      : typeof captchaPayload?.token === "string"
        ? captchaPayload.token.trim()
        : "";

  // Skip CAPTCHA verification on mobile (no token provided)
  // Mobile clients do not show CAPTCHA, so we skip this check.
  if (!captchaToken) {
    return next();
  }

  if (!userInput) {
    return res.status(400).json({
      success: false,
      message: "Please enter the CAPTCHA code.",
    });
  }

  // Token format: "<issuedAt>.<signature>"
  const dotIndex = captchaToken.indexOf(".");
  if (dotIndex === -1) {
    return res.status(400).json({
      success: false,
      message: "Invalid CAPTCHA token. Please refresh and try again.",
    });
  }

  const issuedAt = parseInt(captchaToken.substring(0, dotIndex), 10);
  const receivedSig = captchaToken.substring(dotIndex + 1);

  // Check token is not expired (5 min TTL)
  if (!issuedAt || Date.now() - issuedAt > CAPTCHA_TTL_MS) {
    return res.status(400).json({
      success: false,
      message: "CAPTCHA expired. Please refresh the captcha and try again.",
    });
  }

  // Verify HMAC signature for the user's input.
  // Defensive checks prevent malformed token payloads from throwing uncaught 500s.
  const expectedSig = signCaptcha(userInput, issuedAt);
  const hexRegex = /^[a-f0-9]+$/i;
  if (!hexRegex.test(receivedSig) || !hexRegex.test(expectedSig)) {
    return res.status(400).json({
      success: false,
      message: "Invalid CAPTCHA token. Please refresh and try again.",
    });
  }

  const receivedBuffer = Buffer.from(receivedSig, "hex");
  const expectedBuffer = Buffer.from(expectedSig, "hex");
  if (receivedBuffer.length !== expectedBuffer.length) {
    return res.status(400).json({
      success: false,
      message: "Invalid CAPTCHA token. Please refresh and try again.",
    });
  }

  // Constant-time comparison to avoid timing attacks
  let sigMatch = false;
  try {
    sigMatch = crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: "Invalid CAPTCHA token. Please refresh and try again.",
    });
  }

  if (!sigMatch) {
    return res.status(400).json({
      success: false,
      message: "Wrong CAPTCHA. Please try again.",
    });
  }

  next();
};

module.exports = { verifyCaptcha };
