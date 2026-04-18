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
const EXTENSION_MIME_MAP = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
const clearDriveCaches = () => {
  folderMetadataCache.clear();
  ensuredFolderCache.clear();
};

const getFolderLink = (folderId) =>
  folderId ? `https://drive.google.com/drive/folders/${folderId}` : null;

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

const resolveConfiguredDriveAuthMode = () =>
  String(process.env.GOOGLE_DRIVE_AUTH_MODE || "")
    .trim()
    .toLowerCase();

const tryResolveServiceAccountConfig = () => {
  try {
    return resolveServiceAccountConfig();
  } catch (error) {
    return null;
  }
};

const resolveImpersonatedUserEmail = () =>
  String(process.env.GOOGLE_DRIVE_IMPERSONATE_USER_EMAIL || "")
    .trim()
    .toLowerCase();

const resolveDriveAuthContext = () => {
  const configuredMode = resolveConfiguredDriveAuthMode();
  const oauthConfig = resolveOAuthDriveConfig();
  const serviceAccountConfig = tryResolveServiceAccountConfig();

  if (configuredMode === "oauth2") {
    if (!oauthConfig) {
      throw new Error(
        "GOOGLE_DRIVE_AUTH_MODE is oauth2 but OAuth credentials are missing. Set GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, and GOOGLE_DRIVE_REFRESH_TOKEN.",
      );
    }
    return {
      authMode: "oauth2",
      oauthConfig,
    };
  }

  if (configuredMode === "service_account") {
    const credentials = resolveServiceAccountConfig();
    return {
      authMode: "service_account",
      credentials,
      impersonatedUserEmail: resolveImpersonatedUserEmail(),
    };
  }

  // Auto mode: prefer service account when available, fallback to OAuth.
  if (serviceAccountConfig) {
    return {
      authMode: "service_account",
      credentials: serviceAccountConfig,
      impersonatedUserEmail: resolveImpersonatedUserEmail(),
    };
  }

  if (oauthConfig) {
    return {
      authMode: "oauth2",
      oauthConfig,
    };
  }

  // Preserve existing explicit missing-credentials error
  const credentials = resolveServiceAccountConfig();
  return {
    authMode: "service_account",
    credentials,
    impersonatedUserEmail: resolveImpersonatedUserEmail(),
  };
};

const resolveServiceAccountEmail = () => {
  const authContext = resolveDriveAuthContext();
  if (authContext.authMode !== "service_account") return "";
  return String(authContext.credentials?.client_email || "").trim();
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

  let response;
  try {
    response = await drive.files.get({
      fileId: folderId,
      fields: "id,name,mimeType,driveId",
      supportsAllDrives: true,
    });
  } catch (error) {
    if (error?.code === 404) {
      const serviceAccountEmail = resolveServiceAccountEmail();
      throw new Error(
        `Google Drive folder ${folderId} is not accessible. Confirm the folder ID is correct and share the folder with ${serviceAccountEmail || "the configured service account"} as Editor.`,
      );
    }
    if (isDrivePermissionDeniedError(error)) {
      const authContext = resolveDriveAuthContext();
      throw new Error(
        buildDrivePermissionDeniedMessage({
          folderId,
          authMode: authContext.authMode,
          serviceAccountEmail:
            authContext.authMode === "service_account"
              ? authContext.credentials?.client_email
              : "",
          impersonatedUserEmail:
            authContext.authMode === "service_account"
              ? authContext.impersonatedUserEmail
              : "",
        }),
      );
    }
    throw error;
  }

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
  const authContext = resolveDriveAuthContext();
  const serviceAccountEmail =
    authContext.authMode === "service_account"
      ? authContext.credentials?.client_email
      : "";
  const impersonatedUserEmail =
    authContext.authMode === "service_account"
      ? authContext.impersonatedUserEmail
      : "";

  let existingFolders = [];
  try {
    existingFolders = await listDriveFoldersByName({
      drive,
      folderName: safeFolderName,
      parentFolderId,
      pageSize: 25,
    });
  } catch (error) {
    if (isDrivePermissionDeniedError(error)) {
      throw new Error(
        buildDrivePermissionDeniedMessage({
          folderId: parentFolderId,
          folderName: safeFolderName,
          authMode: authContext.authMode,
          serviceAccountEmail,
          impersonatedUserEmail,
        }),
      );
    }
    throw error;
  }

  if (existingFolders.length) {
    let folder = existingFolders[0];
    if (existingFolders.length > 1) {
      const cleanupResult = await mergeDuplicateDriveFolders({
        drive,
        parentFolderId,
        folderName: safeFolderName,
        keepFolderId: folder.id,
      });
      if (Array.isArray(cleanupResult?.cleanupWarnings) && cleanupResult.cleanupWarnings.length) {
        cleanupResult.cleanupWarnings.forEach((warningMessage) => {
          console.warn("[GOOGLE-DRIVE]", warningMessage);
        });
      }
      folder = cleanupResult.folder || folder;
    }
    ensuredFolderCache.set(cacheKey, folder);
    return folder;
  }

  let createdFolder;
  try {
    createdFolder = await drive.files.create({
      requestBody: {
        name: safeFolderName,
        mimeType: DRIVE_FOLDER_MIME_TYPE,
        parents: [parentFolderId],
      },
      fields: "id,name,webViewLink,driveId",
      supportsAllDrives: true,
    });
  } catch (error) {
    if (isDrivePermissionDeniedError(error)) {
      throw new Error(
        buildDrivePermissionDeniedMessage({
          folderId: parentFolderId,
          folderName: safeFolderName,
          authMode: authContext.authMode,
          serviceAccountEmail,
          impersonatedUserEmail,
        }),
      );
    }
    throw error;
  }

  ensuredFolderCache.set(cacheKey, createdFolder.data);
  return createdFolder.data;
};

const createFolder = async (name, parentId = DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID) =>
  ensureDriveFolder({
    folderName: name,
    parentFolderId: parentId,
  });

const listDriveFoldersByName = async ({
  drive,
  folderName,
  parentFolderId = DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  pageSize = 10,
}) => {
  if (!parentFolderId) {
    throw new Error("Google Drive parent folder ID is required.");
  }

  const driveClient = drive || (await getDriveClient());
  const safeFolderName = sanitizeFileName(folderName || "Folder");
  const query = [
    `mimeType = '${DRIVE_FOLDER_MIME_TYPE}'`,
    `name = '${escapeDriveQueryValue(safeFolderName)}'`,
    `'${parentFolderId}' in parents`,
    "trashed = false",
  ].join(" and ");

  const response = await driveClient.files.list({
      q: query,
      fields: "files(id,name,webViewLink,driveId,parents,createdTime)",
      pageSize,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    }).catch((error) => {
      if (isDrivePermissionDeniedError(error)) {
        const authContext = resolveDriveAuthContext();
        throw new Error(
          buildDrivePermissionDeniedMessage({
            folderId: parentFolderId,
            folderName: safeFolderName,
            authMode: authContext.authMode,
            serviceAccountEmail:
              authContext.authMode === "service_account"
                ? authContext.credentials?.client_email
                : "",
            impersonatedUserEmail:
              authContext.authMode === "service_account"
                ? authContext.impersonatedUserEmail
                : "",
          }),
        );
      }
      throw error;
    });

  return Array.isArray(response.data.files) ? response.data.files : [];
};

const findDriveFolder = async ({
  folderName,
  parentFolderId = DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
}) => {
  if (!parentFolderId) {
    throw new Error("Google Drive parent folder ID is required.");
  }

  const existingFolders = await listDriveFoldersByName({
    folderName,
    parentFolderId,
    pageSize: 1,
  });

  return existingFolders[0] || null;
};

const listDriveFolderChildren = async ({ drive, folderId }) => {
  if (!folderId) return [];

  const driveClient = drive || (await getDriveClient());
  const items = [];
  let pageToken = undefined;

  do {
    const response = await driveClient.files.list({
      q: [`'${folderId}' in parents`, "trashed = false"].join(" and "),
      fields:
        "nextPageToken,files(id,name,mimeType,parents,webViewLink,driveId,createdTime,modifiedTime)",
      pageSize: 100,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    items.push(...(Array.isArray(response.data.files) ? response.data.files : []));
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return items;
};

const mergeDuplicateDriveFolders = async ({
  drive,
  parentFolderId = DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  folderName,
  keepFolderId = null,
}) => {
  if (!parentFolderId) {
    throw new Error("Google Drive parent folder ID is required.");
  }

  const driveClient = drive || (await getDriveClient());
  const matches = await listDriveFoldersByName({
    drive: driveClient,
    folderName,
    parentFolderId,
    pageSize: 25,
  });

  if (!matches.length) {
    return {
      folder: null,
      removedFolderIds: [],
      movedItems: [],
    };
  }

  const keepFolder =
    (keepFolderId && matches.find((item) => item.id === keepFolderId)) || matches[0];
  const duplicates = matches.filter((item) => item?.id && item.id !== keepFolder.id);
  const movedItems = [];
  const removedFolderIds = [];
  const cleanupWarnings = [];

  for (const duplicate of duplicates) {
    let children = [];
    try {
      children = await listDriveFolderChildren({
        drive: driveClient,
        folderId: duplicate.id,
      });
    } catch (error) {
      if (isDrivePermissionDeniedError(error)) {
        cleanupWarnings.push(
          `Skipping duplicate folder cleanup for "${duplicate.name || folderName}" because the Drive account cannot inspect folder ${duplicate.id}.`,
        );
        continue;
      }
      throw error;
    }

    for (const child of children) {
      if (!child?.id) continue;
      try {
        await moveDriveItemToParent({
          itemId: child.id,
          targetParentId: keepFolder.id,
        });
        movedItems.push({
          itemId: child.id,
          itemName: child.name || null,
          fromFolderId: duplicate.id,
          toFolderId: keepFolder.id,
        });
      } catch (error) {
        if (isDrivePermissionDeniedError(error)) {
          cleanupWarnings.push(
            `Skipping move for Drive item ${child.id} from duplicate folder ${duplicate.id} because the Drive account lacks permission.`,
          );
          continue;
        }
        throw error;
      }
    }

    try {
      await driveClient.files.delete({
        fileId: duplicate.id,
        supportsAllDrives: true,
      });
      removedFolderIds.push(duplicate.id);
    } catch (error) {
      if (isDrivePermissionDeniedError(error)) {
        cleanupWarnings.push(
          `Duplicate Drive folder ${duplicate.id} could not be deleted because the Drive account lacks permission. Keeping existing folder ${keepFolder.id} for sync.`,
        );
        continue;
      }
      throw error;
    }
  }

  if (duplicates.length) {
    clearDriveCaches();
  }

  return {
    folder: keepFolder,
    removedFolderIds,
    movedItems,
    cleanupWarnings,
  };
};

const cleanupDuplicateDriveFoldersByName = async ({
  parentFolderId,
  folderName,
  keepFolderId = null,
}) => {
  const drive = await getDriveClient();
  return mergeDuplicateDriveFolders({
    drive,
    parentFolderId,
    folderName,
    keepFolderId,
  });
};

const moveDriveItemToParent = async ({ itemId, targetParentId }) => {
  if (!itemId) {
    throw new Error("Google Drive item ID is required.");
  }
  if (!targetParentId) {
    throw new Error("Google Drive target parent folder ID is required.");
  }

  const drive = await getDriveClient();
  const metadataResponse = await drive.files.get({
    fileId: itemId,
    fields: "id,name,webViewLink,parents,driveId",
    supportsAllDrives: true,
  });

  const currentParents = Array.isArray(metadataResponse.data.parents)
    ? metadataResponse.data.parents
    : [];

  const addParents = currentParents.includes(targetParentId)
    ? undefined
    : targetParentId;
  const removeParents = currentParents
    .filter((parentId) => parentId !== targetParentId)
    .join(",");

  if (!addParents && !removeParents) {
    return metadataResponse.data;
  }

  const updatedResponse = await drive.files.update({
    fileId: itemId,
    addParents,
    removeParents: removeParents || undefined,
    fields: "id,name,webViewLink,driveId,parents",
    supportsAllDrives: true,
  });

  clearDriveCaches();
  return updatedResponse.data;
};

const syncDriveFolder = async ({
  folderId,
  folderName,
  parentFolderId = DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
}) => {
  if (!parentFolderId) {
    throw new Error("Google Drive parent folder ID is required.");
  }

  const safeFolderName = sanitizeFileName(folderName || "Folder");
  if (!folderId) {
    return ensureDriveFolder({
      folderName: safeFolderName,
      parentFolderId,
    });
  }

  const drive = await getDriveClient();

  let metadataResponse;
  try {
    metadataResponse = await drive.files.get({
      fileId: folderId,
      fields: "id,name,mimeType,webViewLink,parents,driveId",
      supportsAllDrives: true,
    });
  } catch (error) {
    if (error?.code === 404) {
      clearDriveCaches();
      return ensureDriveFolder({
        folderName: safeFolderName,
        parentFolderId,
      });
    }
    throw error;
  }

  if (metadataResponse.data.mimeType !== DRIVE_FOLDER_MIME_TYPE) {
    throw new Error(`Google Drive item ${folderId} is not a folder.`);
  }

  const currentParents = Array.isArray(metadataResponse.data.parents)
    ? metadataResponse.data.parents
    : [];
  const addParents = currentParents.includes(parentFolderId)
    ? undefined
    : parentFolderId;
  const removeParents = currentParents
    .filter((parentId) => parentId !== parentFolderId)
    .join(",");
  const requestBody =
    metadataResponse.data.name !== safeFolderName
      ? { name: safeFolderName }
      : undefined;

  if (!requestBody && !addParents && !removeParents) {
    return metadataResponse.data;
  }

  const updatedResponse = await drive.files.update({
    fileId: folderId,
    requestBody,
    addParents,
    removeParents: removeParents || undefined,
    fields: "id,name,webViewLink,driveId,parents",
    supportsAllDrives: true,
  });

  clearDriveCaches();
  return updatedResponse.data;
};

const isStorageQuotaExceededError = (error) =>
  error?.code === 403 &&
  Array.isArray(error?.errors) &&
  error.errors.some((item) => item?.reason === "storageQuotaExceeded");

const getDriveErrorReasons = (error) => {
  const directReasons = Array.isArray(error?.errors)
    ? error.errors.map((item) => String(item?.reason || "").trim()).filter(Boolean)
    : [];
  const nestedReasons = Array.isArray(error?.response?.data?.error?.errors)
    ? error.response.data.error.errors
        .map((item) => String(item?.reason || "").trim())
        .filter(Boolean)
    : [];

  return [...directReasons, ...nestedReasons];
};

const isDrivePermissionDeniedError = (error) => {
  const reasons = getDriveErrorReasons(error);
  const message = String(error?.message || "").toLowerCase();

  return (
    error?.code === 403 &&
    (
      reasons.some((reason) =>
        ["insufficientfilepermissions", "insufficientpermissions", "forbidden"].includes(
          reason.toLowerCase(),
        ),
      ) ||
      message.includes("sufficient permissions") ||
      message.includes("insufficient permissions") ||
      message.includes("permission")
    )
  );
};

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

const buildDrivePermissionDeniedMessage = ({
  folderId,
  folderName,
  authMode,
  serviceAccountEmail,
  impersonatedUserEmail,
}) => {
  const folderLabel = folderName || folderId || "configured Drive folder";

  if (authMode === "oauth2") {
    return `Google Drive permission issue: the Google account connected by GOOGLE_DRIVE_REFRESH_TOKEN cannot access or edit folder "${folderLabel}". Share that folder or its parent with the same Google account as Editor, or reconnect using a Google account that already has access.`;
  }

  if (impersonatedUserEmail) {
    return `Google Drive permission issue: delegated user ${impersonatedUserEmail} cannot access or edit folder "${folderLabel}". Share that folder with ${impersonatedUserEmail}, or confirm domain-wide delegation and Drive scope are enabled for ${serviceAccountEmail}.`;
  }

  return `Google Drive permission issue: service account ${serviceAccountEmail || "the configured service account"} cannot access or edit folder "${folderLabel}". Share that folder with the service account as Editor, or move the hierarchy into a Shared Drive where it has access.`;
};

const buildDriveUrls = (fileId) => ({
  fileUrl: `https://drive.google.com/uc?export=view&id=${fileId}`,
  webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
  downloadLink: `https://drive.google.com/uc?export=download&id=${fileId}`,
});

const waitForRetry = (delayMs) =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

const findDriveFilesByName = async ({ drive, folderId, fileName }) => {
  if (!drive || !folderId || !fileName) return null;

  const query = [
    `name = '${escapeDriveQueryValue(fileName)}'`,
    `'${folderId}' in parents`,
    "trashed = false",
  ].join(" and ");

  const response = await drive.files.list({
    q: query,
    fields: "files(id,name,webViewLink,webContentLink)",
    pageSize: 10,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  const matches = Array.isArray(response.data.files) ? response.data.files : [];
  if (matches.length > 1) {
    console.warn(
      `[GOOGLE-DRIVE] Found ${matches.length} existing files named "${fileName}" in folder ${folderId}. Reusing the first match.`,
    );
  }

  return matches;
};

const cleanupDuplicateDriveFiles = async ({
  drive,
  folderId,
  fileName,
  keepFileId,
}) => {
  const matches = await findDriveFilesByName({
    drive,
    folderId,
    fileName,
  });
  const normalizedMatches = Array.isArray(matches) ? matches : [];
  const duplicates = normalizedMatches.filter(
    (item) => item?.id && item.id !== keepFileId,
  );

  for (const duplicate of duplicates) {
    try {
      await drive.files.delete({
        fileId: duplicate.id,
        supportsAllDrives: true,
      });
      console.log(
        `[GOOGLE-DRIVE] Removed duplicate file "${fileName}" (${duplicate.id}) from folder ${folderId}`,
      );
    } catch (error) {
      if (error?.code === 404) {
        continue;
      }
      console.warn(
        `[GOOGLE-DRIVE] Failed to remove duplicate file "${fileName}" (${duplicate.id}): ${error.message}`,
      );
    }
  }

  if (duplicates.length) {
    clearDriveCaches();
  }

  return {
    matches: normalizedMatches,
    removedFileIds: duplicates.map((item) => item.id),
  };
};

const cleanupDuplicateDriveFilesByName = async ({
  folderId,
  fileName,
  keepFileId,
}) => {
  const drive = await getDriveClient();
  return cleanupDuplicateDriveFiles({
    drive,
    folderId,
    fileName,
    keepFileId,
  });
};

const isRetryableDriveError = (error) => {
  const statusCode =
    error?.code || error?.statusCode || error?.response?.status || null;
  if ([408, 409, 429, 500, 502, 503, 504].includes(Number(statusCode))) {
    return true;
  }

  const normalizedMessage = String(error?.message || "").toLowerCase();
  return [
    "timeout",
    "temporarily unavailable",
    "socket hang up",
    "econnreset",
    "rate limit",
    "quota exceeded",
    "backend error",
  ].some((token) => normalizedMessage.includes(token));
};

const uploadToDrive = async ({
  fileBuffer,
  mimeType,
  originalName,
  folderId = DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  fileName,
  replaceExistingFile = true,
  cleanupDuplicateFiles = true,
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

  const driveFileName = buildDriveFileName({
    fileName,
    originalName,
    mimeType,
  });

  console.log(
    `[GOOGLE-DRIVE] Uploading "${driveFileName}" to folder ${folderId} (${folderMetadata?.name || "unknown"}) using ${authContext.authMode}${isSharedDriveFolder ? " [shared-drive]" : " [my-drive]"}`,
  );

  let fileResponse;
  try {
    const existingMatches =
      replaceExistingFile && fileName
        ? await findDriveFilesByName({
            drive,
            folderId,
            fileName: driveFileName,
          })
        : [];
    const existingFile = replaceExistingFile && Array.isArray(existingMatches)
      ? existingMatches[0] || null
      : null;

    if (existingFile?.id) {
      console.log(
        `[GOOGLE-DRIVE] Replacing existing file "${driveFileName}" (${existingFile.id}) in folder ${folderId}`,
      );
      fileResponse = await drive.files.update({
        fileId: existingFile.id,
        requestBody: {
          name: driveFileName,
        },
        media: {
          mimeType,
          body: Readable.from(fileBuffer),
        },
        fields: "id,name,webViewLink,webContentLink",
        supportsAllDrives: true,
      });
    } else {
      fileResponse = await drive.files.create({
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
    }
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

    if (isDrivePermissionDeniedError(error)) {
      throw new Error(
        buildDrivePermissionDeniedMessage({
          folderId,
          folderName: folderMetadata?.name,
          authMode: authContext.authMode,
          serviceAccountEmail: credentials?.client_email,
          impersonatedUserEmail,
        }),
      );
    }

    throw error;
  }

  const fileId = fileResponse.data.id;

  console.log(
    `[GOOGLE-DRIVE] Uploaded "${driveFileName}" as file ${fileId} into folder ${folderId}`,
  );

  if (fileName && cleanupDuplicateFiles) {
    await cleanupDuplicateDriveFiles({
      drive,
      folderId,
      fileName: driveFileName,
      keepFileId: fileId,
    });
  }

  try {
    await drive.permissions.create({
      fileId,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
      supportsAllDrives: true,
    });
  } catch (permissionError) {
    const statusCode =
      permissionError?.code ||
      permissionError?.statusCode ||
      permissionError?.response?.status ||
      null;
    if (Number(statusCode) !== 409) {
      throw permissionError;
    }
  }

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

const uploadFile = async (filePath, fileName, folderId, mimeType = null) => {
  if (!filePath) {
    throw new Error("filePath is required for uploadFile");
  }

  const fileBuffer = await fs.promises.readFile(filePath);
  const detectedMimeType =
    mimeType ||
    EXTENSION_MIME_MAP[
      String(path.extname(fileName || filePath || "")).toLowerCase()
    ] ||
    "application/octet-stream";

  return uploadToDriveWithRetry({
    fileBuffer,
    mimeType: detectedMimeType,
    originalName: path.basename(fileName || filePath),
    folderId,
    fileName: fileName || path.basename(filePath),
  });
};

const uploadToDriveWithRetry = async (
  uploadPayload,
  {
    attempts = 3,
    initialDelayMs = 400,
    backoffMultiplier = 2,
  } = {},
) => {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await uploadToDrive(uploadPayload);
    } catch (error) {
      lastError = error;
      const retryable = attempt < attempts && isRetryableDriveError(error);
      console.error(
        `[GOOGLE-DRIVE] Upload attempt ${attempt}/${attempts} failed: ${error.message}`,
      );
      if (!retryable) break;
      const nextDelay = initialDelayMs * backoffMultiplier ** (attempt - 1);
      await waitForRetry(nextDelay);
    }
  }

  throw lastError;
};

const deleteFromDrive = async (fileId) => {
  if (!fileId) return;

  const drive = await getDriveClient();

  try {
    await drive.files.delete({
      fileId,
      supportsAllDrives: true,
    });
    clearDriveCaches();
  } catch (error) {
    if (error?.code === 404) {
      return;
    }

    throw error;
  }
};

module.exports = {
  DEFAULT_TRAINER_DOCUMENTS_FOLDER_ID,
  getFolderLink,
  createFolder,
  ensureDriveFolder,
  listDriveFoldersByName,
  findDriveFolder,
  listDriveFolderChildren,
  mergeDuplicateDriveFolders,
  cleanupDuplicateDriveFoldersByName,
  moveDriveItemToParent,
  syncDriveFolder,
  findDriveFilesByName,
  cleanupDuplicateDriveFiles,
  cleanupDuplicateDriveFilesByName,
  uploadFile,
  uploadToDrive,
  uploadToDriveWithRetry,
  deleteFromDrive,
};
