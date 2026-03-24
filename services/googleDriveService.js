const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { google } = require("googleapis");

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const MIME_EXTENSION_MAP = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
};
const resolveDefaultDriveFolderId = () =>
  String(
    process.env.GOOGLE_DRIVE_FOLDER_ID ||
      process.env.GOOGLE_DRIVE_TRAINER_DOCUMENTS_FOLDER_ID ||
      "",
  ).trim();

const DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID = resolveDefaultDriveFolderId();

let driveClientPromise = null;
const folderMetadataCache = new Map();
const ensuredFolderCache = new Map();

const sanitizeFileName = (value = "document") =>
  String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "document";

const normalizeExtension = (value = "") => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
};

const escapeDriveQueryValue = (value = "") =>
  String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");

const buildDriveFileName = ({ fileName, originalName, mimeType }) => {
  const originalExtension =
    normalizeExtension(path.extname(originalName || "")) ||
    normalizeExtension(MIME_EXTENSION_MAP[mimeType] || "");

  if (fileName) {
    const providedExtension = normalizeExtension(path.extname(fileName));
    const fileBaseName = sanitizeFileName(
      path.basename(fileName, providedExtension || ""),
    );

    return `${fileBaseName}${providedExtension || originalExtension}`;
  }

  const baseName = sanitizeFileName(
    path.basename(originalName || "document", path.extname(originalName || "")),
  );

  return `${Date.now()}-${baseName}${originalExtension}`;
};

const resolveCandidateServiceAccountPaths = () => {
  const configDir = path.resolve(process.cwd(), "config");
  const candidatePaths = [];

  if (fs.existsSync(configDir)) {
    const jsonFiles = fs
      .readdirSync(configDir)
      .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
      .map((fileName) => path.join(configDir, fileName));

    candidatePaths.push(...jsonFiles);
  }

  return candidatePaths;
};

const resolveServiceAccountConfig = () => {
  const inlineConfig = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  if (inlineConfig) {
    return JSON.parse(inlineConfig);
  }

  const configuredPath = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH;
  if (configuredPath) {
    const absolutePath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(process.cwd(), configuredPath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(
        `Google Drive service account key not found at: ${absolutePath}`,
      );
    }

    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  }

  const candidatePaths = resolveCandidateServiceAccountPaths();
  if (candidatePaths.length === 1) {
    return JSON.parse(fs.readFileSync(candidatePaths[0], "utf8"));
  }

  if (candidatePaths.length > 1) {
    throw new Error(
      "Multiple Google Drive credential files found in config. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH explicitly.",
    );
  }

  throw new Error(
    "Missing Google Drive credentials. Set GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH or GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON.",
  );
};

const resolveOAuthDriveConfig = () => {
  const clientId = String(
    process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || "",
  ).trim();
  const clientSecret = String(
    process.env.GOOGLE_DRIVE_CLIENT_SECRET ||
      process.env.GOOGLE_CLIENT_SECRET ||
      "",
  ).trim();
  const refreshToken = String(
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN || "",
  ).trim();

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
  };
};

const resolveImpersonatedUserEmail = () =>
  String(process.env.GOOGLE_DRIVE_IMPERSONATE_USER_EMAIL || "")
    .trim()
    .toLowerCase();

const resolveDriveAuthContext = () => {
  const oauthConfig = resolveOAuthDriveConfig();
  if (oauthConfig) {
    return {
      authMode: "oauth2",
      oauthConfig,
    };
  }

  const credentials = resolveServiceAccountConfig();
  return {
    authMode: "service_account",
    credentials,
    impersonatedUserEmail: resolveImpersonatedUserEmail(),
  };
};

const createDriveAuthClient = async (authContext) => {
  if (authContext.authMode === "oauth2") {
    const oauthClient = new google.auth.OAuth2(
      authContext.oauthConfig.clientId,
      authContext.oauthConfig.clientSecret,
    );
    oauthClient.setCredentials({
      refresh_token: authContext.oauthConfig.refreshToken,
    });
    return oauthClient;
  }

  const { credentials, impersonatedUserEmail } = authContext;

  if (impersonatedUserEmail) {
    return new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: DRIVE_SCOPES,
      subject: impersonatedUserEmail,
    });
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: DRIVE_SCOPES,
  });

  return auth.getClient();
};

const getDriveClient = async () => {
  if (!driveClientPromise) {
    driveClientPromise = (async () => {
      const authContext = resolveDriveAuthContext();
      console.log(
        `[GOOGLE-DRIVE] Auth mode: ${authContext.authMode}, folder: ${resolveDefaultDriveFolderId() || "(missing)"}`,
      );
      const client = await createDriveAuthClient(authContext);
      return google.drive({ version: "v3", auth: client });
    })();
  }

  return driveClientPromise;
};

const getFolderMetadata = async (drive, folderId) => {
  if (folderMetadataCache.has(folderId)) {
    return folderMetadataCache.get(folderId);
  }

  const response = await drive.files.get({
    fileId: folderId,
    fields: "id,name,mimeType,driveId",
    supportsAllDrives: true,
  });

  folderMetadataCache.set(folderId, response.data);
  return response.data;
};

const ensureDriveFolder = async ({
  folderName,
  parentFolderId = DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
}) => {
  if (!parentFolderId) {
    throw new Error("Google Drive parent folder ID is required.");
  }

  const safeFolderName = sanitizeFileName(folderName || "Folder");
  const cacheKey = `${parentFolderId}:${safeFolderName}`;
  if (ensuredFolderCache.has(cacheKey)) {
    return ensuredFolderCache.get(cacheKey);
  }

  const drive = await getDriveClient();
  const query = [
    `mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`,
    `name = '${escapeDriveQueryValue(safeFolderName)}'`,
    `'${parentFolderId}' in parents`,
    "trashed = false",
  ].join(" and ");

  const existingFolders = await drive.files.list({
    q: query,
    fields: "files(id,name,webViewLink,driveId)",
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  if (existingFolders.data.files?.length) {
    const folder = existingFolders.data.files[0];
    ensuredFolderCache.set(cacheKey, folder);
    return folder;
  }

  const createdFolder = await drive.files.create({
    requestBody: {
      name: safeFolderName,
      mimeType: DRIVE_FOLDER_MIME_TYPE,
      parents: [parentFolderId],
    },
    fields: "id,name,webViewLink,driveId",
    supportsAllDrives: true,
  });

  ensuredFolderCache.set(cacheKey, createdFolder.data);
  return createdFolder.data;
};

const isStorageQuotaExceededError = (error) =>
  error?.code === 403 &&
  Array.isArray(error?.errors) &&
  error.errors.some((item) => item?.reason === "storageQuotaExceeded");

const buildDriveQuotaErrorMessage = ({
  folderId,
  folderName,
  isSharedDriveFolder,
  serviceAccountEmail,
  impersonatedUserEmail,
  authMode,
}) => {
  const folderLabel = folderName || folderId;

  if (authMode === "oauth2") {
    return `Google Drive upload failed for folder "${folderLabel}". Confirm the refresh token is valid, the Google account still has access to this folder, and the account has available Drive storage.`;
  }

  if (impersonatedUserEmail) {
    return `Google Drive upload failed for delegated user ${impersonatedUserEmail}. Confirm domain-wide delegation is enabled for ${serviceAccountEmail}, the Drive scope is allowed in Google Workspace Admin, and ${impersonatedUserEmail} can upload into folder "${folderLabel}".`;
  }

  if (!isSharedDriveFolder) {
    return `Google Drive setup issue: folder "${folderLabel}" is in My Drive. Service accounts do not have storage quota for My Drive uploads. Move this folder into a Shared Drive and add ${serviceAccountEmail} as a member, or configure GOOGLE_DRIVE_IMPERSONATE_USER_EMAIL with Google Workspace domain-wide delegation.`;
  }

  return `Google Drive upload failed because the service account ${serviceAccountEmail} does not have usable storage for folder "${folderLabel}". Confirm the folder is inside a Shared Drive and that the service account has upload access there.`;
};

const buildDriveUrls = (fileId) => ({
  fileUrl: `https://drive.google.com/uc?export=view&id=${fileId}`,
  webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
  downloadLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
});

const uploadToDrive = async ({
  fileBuffer,
  mimeType,
  originalName,
  folderId = DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  fileName,
}) => {
  if (!folderId) {
    throw new Error("Google Drive folder ID is required.");
  }

  if (!fileBuffer || !fileBuffer.length) {
    throw new Error("File buffer is required for Google Drive upload.");
  }

  const drive = await getDriveClient();
  const authContext = resolveDriveAuthContext();
  const credentials =
    authContext.authMode === "service_account" ? authContext.credentials : null;
  const impersonatedUserEmail =
    authContext.authMode === "service_account"
      ? authContext.impersonatedUserEmail
      : "";
  const folderMetadata = await getFolderMetadata(drive, folderId);
  const isSharedDriveFolder = Boolean(folderMetadata?.driveId);

  if (
    authContext.authMode === "service_account" &&
    !isSharedDriveFolder &&
    !impersonatedUserEmail
  ) {
    throw new Error(
      buildDriveQuotaErrorMessage({
        folderId,
        folderName: folderMetadata?.name,
        isSharedDriveFolder,
        serviceAccountEmail: credentials.client_email,
        impersonatedUserEmail,
        authMode: authContext.authMode,
      }),
    );
  }

  const driveFileName = buildDriveFileName({
    fileName,
    originalName,
    mimeType,
  });

  let createResponse;
  try {
    createResponse = await drive.files.create({
      requestBody: {
        name: driveFileName,
        parents: [folderId],
      },
      media: {
        mimeType,
        body: Readable.from(fileBuffer),
      },
      fields: "id,name,webViewLink,webContentLink",
      supportsAllDrives: true,
    });
  } catch (error) {
    if (isStorageQuotaExceededError(error)) {
      throw new Error(
        buildDriveQuotaErrorMessage({
          folderId,
          folderName: folderMetadata?.name,
          isSharedDriveFolder,
          serviceAccountEmail: credentials?.client_email,
          impersonatedUserEmail,
          authMode: authContext.authMode,
        }),
      );
    }

    throw error;
  }

  const fileId = createResponse.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
    supportsAllDrives: true,
  });

  const metadataResponse = await drive.files.get({
    fileId,
    fields: "id,name,webViewLink,webContentLink",
    supportsAllDrives: true,
  });

  const defaultLinks = buildDriveUrls(fileId);

  return {
    fileId,
    folderId,
    fileName: metadataResponse.data.name || driveFileName,
    fileUrl: defaultLinks.fileUrl,
    webViewLink: metadataResponse.data.webViewLink || defaultLinks.webViewLink,
    downloadLink:
      metadataResponse.data.webContentLink || defaultLinks.downloadLink,
  };
};

const deleteFromDrive = async (fileId) => {
  if (!fileId) return;

  const drive = await getDriveClient();

  try {
    await drive.files.delete({
      fileId,
      supportsAllDrives: true,
    });
  } catch (error) {
    if (error?.code === 404) {
      return;
    }

    throw error;
  }
};

module.exports = {
  DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  ensureDriveFolder,
  uploadToDrive,
  deleteFromDrive,
};
