require("dotenv").config();

const { google } = require("googleapis");
const readline = require("readline");

const CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.GOOGLE_DRIVE_OAUTH_REDIRECT_URI ||
  "http://localhost:5001/oauth2callback";

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  console.error("Missing Google OAuth config.");
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive"],
});

console.log("Authorize this app:");
console.log(authUrl);
console.log("");
console.log(
  "After approving access, copy the `code` query parameter from the redirect URL.",
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const normalizeAuthorizationCode = (input = "") => {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";

  const sanitized = trimmed.replace(/^[\\/"'\s]+/, "");

  if (sanitized.includes("code=")) {
    try {
      const parsedUrl = new URL(sanitized);
      const codeFromQuery = parsedUrl.searchParams.get("code");
      if (codeFromQuery) return codeFromQuery.trim();
    } catch (_error) {
      const codeMatch = sanitized.match(/[?&]code=([^&]+)/);
      if (codeMatch?.[1]) {
        return decodeURIComponent(codeMatch[1]).trim();
      }
    }
  }

  return sanitized;
};

rl.question("Enter the code here: ", async (code) => {
  try {
    const normalizedCode = normalizeAuthorizationCode(code);
    const { tokens } = await oAuth2Client.getToken(normalizedCode);
    console.log("");
    console.log("REFRESH TOKEN:", tokens.refresh_token || "(not returned)");

    if (!tokens.refresh_token) {
      console.log(
        "Google did not return a refresh token. Revoke the existing app grant or retry with a fresh consent screen.",
      );
    }
  } catch (error) {
    console.error("Failed to get refresh token:", error.message);
    if (error.message?.includes("invalid_grant")) {
      console.log(
        "Tip: use a fresh auth URL and paste either the raw code or the full redirect URL. Google auth codes expire quickly and can only be used once.",
      );
    }
    process.exitCode = 1;
  } finally {
    rl.close();
  }
});
