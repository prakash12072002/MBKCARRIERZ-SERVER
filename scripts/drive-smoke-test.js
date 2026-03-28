require("dotenv").config();

const { uploadToDrive } = require("../services/googleDriveService");

const folderId =
  process.argv[2] ||
  process.env.GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_ID ||
  process.env.GOOGLE_DRIVE_FOLDER_ID ||
  process.env.GOOGLE_DRIVE_TRAINER_DOCUMENTS_FOLDER_ID;

const run = async () => {
  if (!folderId) {
    throw new Error(
      "Missing folder id. Pass as arg or set GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_ID / GOOGLE_DRIVE_FOLDER_ID.",
    );
  }

  const fileName = `smoke-test-${Date.now()}.txt`;
  const fileBuffer = Buffer.from(
    `drive smoke test ${new Date().toISOString()}`,
    "utf8",
  );

  console.log("Uploading file...");
  console.log("Parent Folder:", folderId);

  const uploaded = await uploadToDrive({
    fileBuffer,
    mimeType: "text/plain",
    originalName: fileName,
    fileName,
    folderId,
  });

  console.log("Uploaded:", uploaded);
};

run().catch((error) => {
  console.error("DRIVE_SMOKE_TEST_ERROR:", error.message);
  process.exit(1);
});
