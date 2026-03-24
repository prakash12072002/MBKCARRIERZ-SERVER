const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directories exist
const uploadDir = './uploads/attendance';
const imageDir = path.join(uploadDir, 'images');
const signatureDir = path.join(uploadDir, 'signatures');
const pdfDir = path.join(uploadDir, 'pdfs');
const videoDir = path.join(uploadDir, 'videos');
const photoDir = path.join(uploadDir, 'photos');

[uploadDir, imageDir, signatureDir, pdfDir, videoDir, photoDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Storage configuration for attendance images
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, imageDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

// Storage configuration for signatures
const signatureStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, signatureDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `sig-${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

// Multi-type storage for new attendance submission
const multiStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        let dir = uploadDir;
        if (file.fieldname === 'attendancePdf') dir = pdfDir;
        else if (file.fieldname === 'studentsPhoto') dir = photoDir;
        else if (file.fieldname === 'signature') dir = signatureDir;
        else if (file.fieldname === 'activityPhotos') dir = photoDir;
        else if (file.fieldname === 'activityVideos') dir = videoDir;
        else if (file.fieldname === 'checkOutGeoImage' || file.fieldname === 'photo') dir = imageDir;
        else if (file.fieldname === 'checkOutSignature') dir = signatureDir;
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${file.fieldname}-${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

// File filter - allow images, PDFs, and videos
const fileFilter = (req, file, cb) => {
    const allowedImageTypes = /jpeg|jpg|png|gif/;
    const allowedPdfTypes = /pdf/;
    const allowedVideoTypes = /mp4|avi|mov|wmv/;

    const extname = path.extname(file.originalname).toLowerCase();
    const basename = path.basename(extname);

    if (allowedImageTypes.test(extname) || allowedImageTypes.test(file.mimetype)) {
        cb(null, true);
    } else if (allowedPdfTypes.test(extname) || file.mimetype === 'application/pdf') {
        cb(null, true);
    } else if (allowedVideoTypes.test(extname) || file.mimetype.startsWith('video/')) {
        cb(null, true);
    } else {
        cb(new Error('Only image, PDF, and video files are allowed'));
    }
};

// Upload middleware for attendance with image and signature (LEGACY)
const uploadAttendance = multer({
    storage: multiStorage,
    fileFilter: (req, file, cb) => {
        // Diagnostic logging
        console.log(`[MULTER-DEBUG] Processing field: ${file.fieldname}`);
        fileFilter(req, file, cb);
    },
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB max file size (to accommodate high-quality videos)
    }
}).fields([
    { name: 'attendancePdf', maxCount: 1 },
    { name: 'studentsPhoto', maxCount: 1 },
    { name: 'signature', maxCount: 1 },
    { name: 'photo', maxCount: 10 },        // Added plural/singular variations for robustness
    { name: 'photos', maxCount: 10 },
    { name: 'image', maxCount: 10 },
    { name: 'images', maxCount: 10 },
    { name: 'checkOutGeoImage', maxCount: 10 },
    { name: 'activityPhotos', maxCount: 10 },
    { name: 'activityVideos', maxCount: 10 },
    { name: 'checkOutSignature', maxCount: 1 }
]);

// Upload middleware for manual attendance (optional image)
const uploadManual = multer({
    storage: imageStorage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024
    }
}).single('image');

module.exports = {
    uploadAttendance,
    uploadManual
};
