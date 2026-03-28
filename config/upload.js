const multer = require('multer');
const path = require('path');
const fs = require('fs');

const ATTENDANCE_PDF_FIELDS = new Set(['attendancePdf']);
const ATTENDANCE_EXCEL_FIELDS = new Set(['attendanceExcel']);
const GEO_IMAGE_FIELDS = new Set([
    'studentsPhoto',
    'signature',
    'photo',
    'photos',
    'image',
    'images',
    'checkOutGeoImage',
    'activityPhotos',
    'checkOutSignature'
]);
const GEO_VIDEO_FIELDS = new Set(['activityVideos']);

const PDF_EXTENSIONS = new Set(['.pdf']);
const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_EXTENSIONS = new Set(['.mp4']);

const PDF_MIME_TYPES = new Set(['application/pdf']);
const EXCEL_MIME_TYPES = new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
]);
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const VIDEO_MIME_TYPES = new Set(['video/mp4']);

// Ensure upload directories exist
const uploadDir = './uploads/attendance';
const imageDir = path.join(uploadDir, 'images');
const signatureDir = path.join(uploadDir, 'signatures');
const pdfDir = path.join(uploadDir, 'pdfs');
const videoDir = path.join(uploadDir, 'videos');
const photoDir = path.join(uploadDir, 'photos');
const excelDir = path.join(uploadDir, 'excels');

[uploadDir, imageDir, signatureDir, pdfDir, videoDir, photoDir, excelDir].forEach(dir => {
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
        else if (file.fieldname === 'attendanceExcel') dir = excelDir;
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

const fileMatchesAllowedType = (file, allowedExtensions, allowedMimeTypes) => {
    const extname = path.extname(file.originalname || '').toLowerCase();
    const mimetype = String(file.mimetype || '').toLowerCase();
    return allowedExtensions.has(extname) || allowedMimeTypes.has(mimetype);
};

const resolveAllowedTypeForField = (fieldName = '') => {
    if (ATTENDANCE_PDF_FIELDS.has(fieldName)) {
        return {
            label: 'Attendance PDF',
            allowedExtensions: PDF_EXTENSIONS,
            allowedMimeTypes: PDF_MIME_TYPES
        };
    }

    if (ATTENDANCE_EXCEL_FIELDS.has(fieldName)) {
        return {
            label: 'Attendance Excel',
            allowedExtensions: EXCEL_EXTENSIONS,
            allowedMimeTypes: EXCEL_MIME_TYPES
        };
    }

    if (GEO_IMAGE_FIELDS.has(fieldName)) {
        return {
            label: 'GeoTag image',
            allowedExtensions: IMAGE_EXTENSIONS,
            allowedMimeTypes: IMAGE_MIME_TYPES
        };
    }

    if (GEO_VIDEO_FIELDS.has(fieldName)) {
        return {
            label: 'GeoTag video',
            allowedExtensions: VIDEO_EXTENSIONS,
            allowedMimeTypes: VIDEO_MIME_TYPES
        };
    }

    return null;
};

// File filter - enforce types by field purpose
const fileFilter = (req, file, cb) => {
    const fieldRule = resolveAllowedTypeForField(file.fieldname);

    if (!fieldRule) {
        return cb(new Error(`Unsupported upload field: ${file.fieldname}`));
    }

    if (fileMatchesAllowedType(file, fieldRule.allowedExtensions, fieldRule.allowedMimeTypes)) {
        return cb(null, true);
    }

    return cb(
        new Error(
            `${fieldRule.label} only allows ${Array.from(fieldRule.allowedExtensions).join(', ')} files`
        )
    );
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
    { name: 'attendanceExcel', maxCount: 1 },
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
