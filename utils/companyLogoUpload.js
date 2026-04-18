const fs = require("fs");
const path = require("path");
const {
  cleanupDuplicateDriveFilesByName,
  ensureCompanyHierarchy,
  isTrainingDriveEnabled,
  uploadToDrive,
} = require("../modules/drive/driveGateway");

const IMAGE_MIME_PREFIX = "image/";

const isRemoteUrl = (value = "") => /^https?:\/\//i.test(String(value || ""));

const getDriveLogoFileName = (file = {}) => {
  const extension = path.extname(file.originalname || "").toLowerCase();
  return `CompanyLogo${extension || ""}`;
};

const readUploadedFileBuffer = async (file = {}) => {
  if (file.buffer?.length) {
    return file.buffer;
  }

  if (!file.path || isRemoteUrl(file.path) || !fs.existsSync(file.path)) {
    return null;
  }

  return fs.promises.readFile(file.path);
};

const applyCompanyFolderFields = (company, companyFolder) => {
  if (!company || !companyFolder?.id) return;

  company.driveFolderId = companyFolder.id;
  company.driveFolderName = companyFolder.name || company.driveFolderName;
  company.driveFolderLink = companyFolder.link || companyFolder.webViewLink || company.driveFolderLink;
};

const uploadCompanyLogoToDrive = async ({
  file,
  company,
  hierarchy = null,
  logger = console,
} = {}) => {
  if (!file || !company || !isTrainingDriveEnabled()) {
    return null;
  }

  const mimeType = String(file.mimetype || "").toLowerCase();
  if (!mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    return null;
  }

  // Cloudinary URLs are already durable. Local disk files are copied to Drive.
  if (isRemoteUrl(file.path || file.secure_url || file.url)) {
    return null;
  }

  const fileBuffer = await readUploadedFileBuffer(file);
  if (!fileBuffer?.length) {
    return null;
  }

  const resolvedHierarchy = hierarchy || await ensureCompanyHierarchy({ company });
  applyCompanyFolderFields(company, resolvedHierarchy?.companyFolder);

  const folderId = resolvedHierarchy?.companyFolder?.id || company.driveFolderId;
  if (!folderId) {
    return null;
  }

  const fileName = getDriveLogoFileName(file);
  const driveUpload = await uploadToDrive({
    fileBuffer,
    mimeType: file.mimetype || "image/png",
    originalName: file.originalname || fileName,
    folderId,
    fileName,
    replaceExistingFile: false,
    cleanupDuplicateFiles: false,
  });

  await cleanupDuplicateDriveFilesByName({
    folderId,
    fileName,
    keepFileId: driveUpload.fileId,
  }).catch((cleanupError) => {
    logger.warn?.(
      `[GOOGLE-DRIVE] Could not clean old company logo files for ${company.name || company._id}: ${cleanupError.message}`,
    );
  });

  return {
    ...driveUpload,
    logoUrl: driveUpload.webViewLink || driveUpload.fileUrl,
  };
};

module.exports = {
  uploadCompanyLogoToDrive,
};
