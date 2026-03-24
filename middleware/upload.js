const multer = require('multer');
const path = require('path');
const fs = require('fs');

const logFile = path.join(__dirname, '../access_debug.log');
const log = (msg) => {
    try {
        fs.appendFileSync(logFile, `[MULTER] ${new Date().toISOString()} ${msg}\n`);
    } catch (e) {}
    console.log(`[MULTER] ${msg}`);
};

// ENSURE ABSOLUTE PATH
const ABS_UPLOAD_DIR = path.join(__dirname, '../uploads/trainer-documents');
log(`INIT !!! Upload Dir: ${ABS_UPLOAD_DIR}`);

if (!fs.existsSync(ABS_UPLOAD_DIR)) {
    log(`Creating Dir: ${ABS_UPLOAD_DIR}`);
    fs.mkdirSync(ABS_UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        log(`DESTINATION !!! Saving to: ${ABS_UPLOAD_DIR}`);
        cb(null, ABS_UPLOAD_DIR);
    },
    filename: function (req, file, cb) {
        // Match user preference: Date.now() + "-" + file.originalname
        const name = Date.now() + "-" + file.originalname;
        log(`FILENAME !!! Generated: ${name}`);
        cb(null, name);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_, file, cb) => {
        // Diagnostic logging
        log(`Filtering file: ${file.originalname} (Mime: ${file.mimetype})`);
        
        // Allow Excel, Images, PDFs, and Word Docs
        // Using a more robust regex and checking mime types
        const isExcel = file.originalname.match(/\.(xlsx|xls)$/i) || 
                       file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
                       file.mimetype === 'application/vnd.ms-excel';
        
        const isImage = file.originalname.match(/\.(jpg|jpeg|png|webp|gif)$/i) || 
                       file.mimetype.startsWith('image/');
        
        const isDoc = file.originalname.match(/\.(pdf|doc|docx)$/i) || 
                     file.mimetype === 'application/pdf' ||
                     file.mimetype === 'application/msword' ||
                     file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

        if (isExcel || isImage || isDoc) {
            log(`File APPROVED: ${file.originalname}`);
            cb(null, true);
        } else {
            log(`File REJECTED: ${file.originalname}`);
            cb(new Error("File type not allowed. Allowed: Excel, Images (JPG/PNG/WEBP), PDF, Word"), false);
        }
    }
});

module.exports = upload;
