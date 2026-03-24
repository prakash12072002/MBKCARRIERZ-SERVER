const express = require("express");
const svgCaptcha = require("svg-captcha");
const crypto = require("crypto");

const router = express.Router();

// Secret for signing — use env var or fallback
const CAPTCHA_SECRET = process.env.SESSION_SECRET || "mbkcarrierz-secret";
const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sign the captcha text + timestamp with HMAC-SHA256 so it can
 * be verified later without needing a server-side session.
 */
function signCaptcha(text, issuedAt) {
  return crypto
    .createHmac("sha256", CAPTCHA_SECRET)
    .update(`${text}:${issuedAt}`)
    .digest("hex");
}

router.get("/", (req, res) => {
  const captcha = svgCaptcha.create({
    size: 4,
    noise: 1,
    color: true,
    background: "#f0f0f0",
    fontSize: 50,
    width: 150,
    height: 50,
    charPreset: "0123456789",
  });

  const issuedAt = Date.now();
  const signature = signCaptcha(captcha.text, issuedAt);

  // Return both the SVG and a signed token so the client can pass it back on login.
  // Format: "<issuedAt>.<signature>"
  const token = `${issuedAt}.${signature}`;

  res.setHeader("X-Captcha-Token", token);
  // Expose the header so browsers allow JS to read it
  res.setHeader("Access-Control-Expose-Headers", "X-Captcha-Token");
  res.type("svg");
  res.status(200).send(captcha.data);
});

// Export helpers so verifyCaptcha middleware can use them
module.exports = router;
module.exports.signCaptcha = signCaptcha;
module.exports.CAPTCHA_TTL_MS = CAPTCHA_TTL_MS;
