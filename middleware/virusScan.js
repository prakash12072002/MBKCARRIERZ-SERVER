const fs = require("fs");

/**
 * Mock Virus Scanner Middleware
 * Simulates a virus scan. In a real environment, this would interface with ClamAV.
 */
const scanFile = async (req, res, next) => {
    if (!req.file) {
        return next();
    }

    try {
        // Simulate scan delay
        // await new Promise(resolve => setTimeout(resolve, 100));

        // Check for EICAR test string or specific mock virus signature in filename or content.
        // For performance, this mock scanner checks only the filename.
        if (req.file.originalname.toLowerCase().includes("virus") ||
            req.file.originalname.toLowerCase().includes("eicar")) {

            // Delete the temporary file only when multer wrote to disk.
            if (req.file.path && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }

            return res.status(400).json({
                message: "Security Alert: Virus detected in uploaded file.",
                error: "VirusScanError"
            });
        }

        // Pass - File is safe
        next();
    } catch (error) {
        console.error("Virus scan error:", error);
        // Fail safe - if scan fails, do we allow or block?
        // For high security, block. For availability, allow with warning.
        // We'll block here.
        return res.status(500).json({ message: "File scan failed" });
    }
};

module.exports = scanFile;
