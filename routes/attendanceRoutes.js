const express = require('express');
const router = express.Router();
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const {
    uploadAttendance,
    uploadManual,
    uploadGeoImage,
    GEO_IMAGE_MAX_SIZE_MB,
} = require('../config/upload');
const {
    Attendance,
    Trainer,
    College,
    Company,
    Course,
    Schedule,
    User,
    Student,
    Notification,
    Department,
    ScheduleDocument
} = require('../models');
const { sendTrainingCompletionEmail } = require('../utils/emailService');
const { getGeoTagData } = require('../utils/exif');
const { extractOcrStampData } = require('../utils/ocr');
const { verifyGeoTag } = require('../utils/verify');
const {
    normalizeCollegeLocation,
    hasValidCollegeCoordinates,
    mergeCollegeLocations,
    collegeLocationsEqual,
} = require('../utils/collegeLocation');
const { sendNotification } = require('../services/notificationService');
const {
    uploadToDriveWithRetry,
    ensureDriveFolder,
    isTrainingDriveEnabled,
    ensureTrainingRootFolder,
    ensureDepartmentHierarchy,
    toDepartmentDayFolders,
} = require('../modules/drive/driveGateway');
const {
    DRIVE_DAY_SUBFOLDERS,
    buildScheduleFolderFields,
} = require('../modules/drive/driveFolderResolver');
const {
    normalizeAttendanceVerificationStatus,
    normalizeAttendancePresenceStatus,
    normalizeAttendanceFinalStatus,
    normalizeCheckOutVerificationStatus,
} = require('../utils/statusNormalizer');
const haversine = require('haversine-distance');
const { invalidateTrainerScheduleCaches } = require('../services/trainerScheduleCacheService');
const {
    enqueueFileWorkflowJob,
    registerFileWorkflowJobHandler,
} = require('../jobs/queues/fileWorkflowQueue');
const { FILE_WORKFLOW_JOB_TYPES } = require('../jobs/fileWorkflowJobTypes');
const {
    createCorrelationId,
    createStructuredLogger,
} = require('../shared/utils/structuredLogger');
const {
    getAttendanceScheduleController,
    getAttendanceLegacyDetailsController,
    getAttendanceTrainerController,
    getAttendanceCollegeController,
    getAttendanceDocumentsController,
    createVerifyAttendanceDocumentController,
    createRejectAttendanceDocumentController,
    createMarkManualAttendanceController,
    verifyGeoTagController,
    rejectGeoTagController,
} = require('../modules/attendance/attendance.controller');

const {
    syncScheduleDayState,
    emitAttendanceRealtimeUpdate,
    syncScheduleLifecycleStatusFromAttendance,
    normalizeVerificationStatus,
} = require('../modules/attendance/attendance.sideeffects');

const ALLOWED_GEO_RANGE_METERS = Math.max(
    0,
    Number.parseInt(process.env.ATTENDANCE_GEO_ALLOWED_RANGE_METERS || '300', 10) || 300
);
const CHECK_OUT_ALLOWED_GEO_RANGE_METERS = Math.max(
    0,
    Number.parseInt(process.env.ATTENDANCE_CHECK_OUT_ALLOWED_RANGE_METERS || '10000', 10) || 10000
);
const ATTENDANCE_BUSINESS_TIMEZONE = String(
    process.env.ATTENDANCE_BUSINESS_TIMEZONE || 'Asia/Kolkata'
).trim() || 'Asia/Kolkata';

const DRIVE_DEFAULT_MIME_BY_EXT = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.wmv': 'video/x-ms-wmv'
};

const GEO_TAG_FILE_FIELDS = new Set([
    'studentsPhoto',
    'signature',
    'photo',
    'photos',
    'image',
    'images',
    'checkOutGeoImage',
    'activityPhotos',
    'activityVideos',
    'checkOutSignature'
]);

let attendanceAsyncLogger;
try {
    attendanceAsyncLogger = createStructuredLogger({
        service: 'attendance',
        component: 'drive-sync',
    });
} catch (e) {
    console.warn('Attendance Async Logger failed to initialize:', e.message);
    attendanceAsyncLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

const logAttendanceAsyncTelemetry = (level, fields = {}) => {
    try {
        const method = typeof attendanceAsyncLogger[level] === 'function' ? level : 'info';
        attendanceAsyncLogger[method]({
            correlationId: fields.correlationId || null,
            stage: fields.stage || null,
            trainerId: fields.trainerId || null,
            documentId: fields.documentId || null,
            scheduleId: fields.scheduleId || null,
            attendanceId: fields.attendanceId || null,
            status: fields.status || null,
            attempt: Number.isFinite(fields.attempt) ? fields.attempt : null,
            outcome: fields.outcome || null,
            cleanupMode: fields.cleanupMode || null,
            reason: fields.reason || null,
            contextLabel: fields.contextLabel || null,
        });
    } catch (err) {
        console.warn('Telemetry logging failed:', err.message);
    }
};

const persistResolvedScheduleCollegeLocation = async (schedule, resolvedCollegeLocation) => {
    if (!schedule?._id || !resolvedCollegeLocation) return;

    const normalizedScheduleLocation = normalizeCollegeLocation(schedule.collegeLocation);
    if (collegeLocationsEqual(normalizedScheduleLocation, resolvedCollegeLocation)) return;

    try {
        await Schedule.updateOne(
            { _id: schedule._id },
            { $set: { collegeLocation: resolvedCollegeLocation } }
        );
        schedule.collegeLocation = resolvedCollegeLocation;
    } catch (error) {
        logAttendanceAsyncTelemetry('warn', {
            correlationId: createCorrelationId('attendance_geo'),
            stage: 'schedule_college_location_sync_failed',
            scheduleId: schedule?._id ? String(schedule._id) : null,
            status: 'location_sync',
            outcome: 'failed',
            reason: error.message,
        });
    }
};

const resolveScheduleCollegeLocation = async (schedule) => {
    const normalizedScheduleLocation = normalizeCollegeLocation(schedule?.collegeLocation);

    if (!schedule?.collegeId) {
        return normalizedScheduleLocation;
    }

    const college = await College.findById(schedule.collegeId)
        .select('address mapUrl latitude longitude location');
    const normalizedCollegeLocation = normalizeCollegeLocation(college);
    const resolvedCollegeLocation = mergeCollegeLocations(
        normalizedCollegeLocation,
        normalizedScheduleLocation
    );

    if (resolvedCollegeLocation) {
        await persistResolvedScheduleCollegeLocation(schedule, resolvedCollegeLocation);
    }

    return resolvedCollegeLocation;
};

const getFileMimeType = (file) => {
    if (file?.mimetype) return file.mimetype;
    const ext = path.extname(file?.originalname || file?.path || '').toLowerCase();
    return DRIVE_DEFAULT_MIME_BY_EXT[ext] || 'application/octet-stream';
};

const dedupeDriveAssetEntries = (entries = []) => {
    const deduped = new Map();

    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry !== 'object') continue;

        const identity = entry.fileId
            || [
                entry.folderId || '',
                entry.folderType || '',
                entry.fieldName || '',
                entry.fileName || '',
                entry.localPath || entry.fileUrl || entry.webViewLink || ''
            ].join('|');

        if (!identity.replace(/\|/g, '').trim()) continue;
        if (deduped.has(identity)) {
            deduped.delete(identity);
        }
        deduped.set(identity, entry);
    }

    return Array.from(deduped.values());
};

const mergeDriveAssets = (existingAssets, syncResult) => {
    const baseAssets = existingAssets && typeof existingAssets === 'object' ? existingAssets : {};
    const existingByField = baseAssets.filesByField && typeof baseAssets.filesByField === 'object'
        ? baseAssets.filesByField
        : {};
    const mergedByField = { ...existingByField };

    for (const [fieldName, uploadedFiles] of Object.entries(syncResult.filesByField || {})) {
        if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) continue;
        const existingFiles = Array.isArray(mergedByField[fieldName]) ? mergedByField[fieldName] : [];
        mergedByField[fieldName] = dedupeDriveAssetEntries([...existingFiles, ...uploadedFiles]);
    }

    const existingFlatFiles = Array.isArray(baseAssets.files) ? baseAssets.files : [];

    return {
        ...baseAssets,
        folderId: syncResult.dayFolderId || syncResult.folderId || baseAssets.folderId || null,
        dayFolderId: syncResult.dayFolderId || baseAssets.dayFolderId || null,
        subFolders: syncResult.subFolders || baseAssets.subFolders || null,
        filesByField: mergedByField,
        files: dedupeDriveAssetEntries([...existingFlatFiles, ...(syncResult.files || [])]),
        lastSyncedAt: syncResult.syncedAt,
        lastSyncError: null,
        lastSyncErrorAt: null
    };
};

const markDriveSyncError = (existingAssets, error) => {
    const baseAssets = existingAssets && typeof existingAssets === 'object' ? existingAssets : {};
    return {
        ...baseAssets,
        lastSyncError: error?.message || 'Drive sync failed',
        lastSyncErrorAt: new Date().toISOString()
    };
};

const resolveDriveSubFolderType = (fieldName) =>
    GEO_TAG_FILE_FIELDS.has(fieldName) ? 'geoTag' : 'attendance';

const DEFAULT_ATTENDANCE_PAGE_LIMIT = 20;
const MAX_ATTENDANCE_PAGE_LIMIT = 100;
const ATTENDANCE_LIST_CHECK_OUT_SELECT_FIELDS = [
    'checkOut.time',
    'checkOut.finalStatus',
    'checkOut.location.lat',
    'checkOut.location.lng',
    'checkOut.location.accuracy',
    'checkOut.location.address',
    'checkOut.location.distanceFromCollege',
    'checkOut.photos.url',
    'checkOut.photos.uploadedAt',
    'checkOut.photos.validationStatus',
    'checkOut.photos.validationReason',
    'checkOut.photos.latitude',
    'checkOut.photos.longitude',
    'checkOut.photos.capturedAt',
    'checkOut.photos.distanceKm',
    'checkOut.photos.validationSource',
];

const escapeRegex = (value = '') =>
    String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parsePositiveInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseAttendanceDateBoundary = (value, boundary = 'start') => {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return null;
    }

    const parsedDate = new Date(normalized);
    if (Number.isNaN(parsedDate.getTime())) {
        return null;
    }

    if (boundary === 'end') {
        parsedDate.setHours(23, 59, 59, 999);
    } else {
        parsedDate.setHours(0, 0, 0, 0);
    }

    return parsedDate;
};

const shouldPaginateAttendance = (query = {}) =>
    Object.prototype.hasOwnProperty.call(query, 'page')
    || Object.prototype.hasOwnProperty.call(query, 'limit');

const buildAttendanceSearchFilters = async (search = '') => {
    const normalizedSearch = String(search || '').trim();
    if (!normalizedSearch) {
        return [];
    }

    const regex = new RegExp(escapeRegex(normalizedSearch), 'i');

    const [users, trainers, companies, colleges, courses, schedules] = await Promise.all([
        User.find({
            $or: [
                { name: regex },
                { email: regex }
            ]
        }).select('_id').lean(),
        Trainer.find({
            $or: [
                { name: regex },
                { email: regex },
                { trainerId: regex }
            ]
        }).select('_id').lean(),
        Company.find({ name: regex }).select('_id').lean(),
        College.find({ name: regex }).select('_id').lean(),
        Course.find({
            $or: [
                { name: regex },
                { title: regex }
            ]
        }).select('_id').lean(),
        Schedule.find({ subject: regex }).select('_id').lean(),
    ]);

    const userIds = users.map((item) => item._id);
    const directTrainerIds = trainers.map((item) => item._id);
    const companyIds = companies.map((item) => item._id);
    const directCollegeIds = colleges.map((item) => item._id);
    const courseIds = courses.map((item) => item._id);
    const directScheduleIds = schedules.map((item) => item._id);

    let trainerIds = directTrainerIds;
    if (userIds.length) {
        const trainersByUser = await Trainer.find({
            userId: { $in: userIds }
        }).select('_id').lean();
        trainerIds = Array.from(
            new Set([
                ...directTrainerIds.map(String),
                ...trainersByUser.map((item) => String(item._id))
            ])
        ).map((value) => new mongoose.Types.ObjectId(value));
    }

    let collegeIds = directCollegeIds;
    if (companyIds.length) {
        const collegesByCompany = await College.find({
            companyId: { $in: companyIds }
        }).select('_id').lean();
        collegeIds = Array.from(
            new Set([
                ...directCollegeIds.map(String),
                ...collegesByCompany.map((item) => String(item._id))
            ])
        ).map((value) => new mongoose.Types.ObjectId(value));
    }

    let scheduleIds = directScheduleIds;
    if (courseIds.length) {
        const schedulesByCourse = await Schedule.find({
            courseId: { $in: courseIds }
        }).select('_id').lean();
        scheduleIds = Array.from(
            new Set([
                ...directScheduleIds.map(String),
                ...schedulesByCourse.map((item) => String(item._id))
            ])
        ).map((value) => new mongoose.Types.ObjectId(value));
    }

    const filters = [{ syllabus: regex }];

    if (trainerIds.length) {
        filters.push({ trainerId: { $in: trainerIds } });
    }

    if (collegeIds.length) {
        filters.push({ collegeId: { $in: collegeIds } });
    }

    if (courseIds.length) {
        filters.push({ courseId: { $in: courseIds } });
    }

    if (scheduleIds.length) {
        filters.push({ scheduleId: { $in: scheduleIds } });
    }

    return filters;
};

const toScheduleDocumentFileType = (folderType) => {
    const normalizedType = String(folderType || '').trim().toLowerCase();
    if (normalizedType === String(DRIVE_DAY_SUBFOLDERS.geoTag).toLowerCase()) return 'geotag';
    if (normalizedType === String(DRIVE_DAY_SUBFOLDERS.attendance).toLowerCase()) return 'attendance';
    return 'other';
};

const toScheduleDocumentStatus = (status) => {
    const normalizedStatus = normalizeAttendanceVerificationStatus(status, 'pending');
    if (normalizedStatus === 'approved') return 'verified';
    if (normalizedStatus === 'rejected') return 'rejected';
    return 'pending';
};

const toObjectIdOrNull = (value) => {
    if (!value) return null;
    return mongoose.Types.ObjectId.isValid(value) ? value : null;
};

const toFolderAssetPayload = (folder, type) => ({
    id: folder?.id || null,
    name: folder?.name || null,
    link: folder?.webViewLink || null,
    type
});

const toDayNumber = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
};

const toZonedDateKey = (value, timeZone = ATTENDANCE_BUSINESS_TIMEZONE) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const year = parts.find((item) => item.type === 'year')?.value;
    const month = parts.find((item) => item.type === 'month')?.value;
    const day = parts.find((item) => item.type === 'day')?.value;

    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
};

const normalizeAssignedDateInput = (value) => {
    if (!value) return null;
    const normalized = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
        return normalized;
    }
    return toZonedDateKey(normalized);
};

const toIdString = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
        // Handle Mongoose ObjectId vs standard object vs populated nested forms
        const idValue = value._id || value.id || value.$oid || (typeof value.toString === 'function' ? value.toString() : null);
        if (idValue && typeof idValue === 'string') return idValue.trim();
        if (idValue && typeof idValue === 'object') return String(idValue).trim();
    }
    const normalized = String(value).trim();
    return (normalized === '[object Object]' || normalized === 'undefined' || normalized === 'null') ? '' : normalized;
};

const buildPendingCheckOutImageSlot = () => ({
    image: null,
    latitude: null,
    longitude: null,
    distance: null,
    status: 'PENDING'
});

const buildPendingCheckOutPhotoSlot = () => ({
    url: null,
    uploadedAt: null,
    validationStatus: 'pending',
    validationReason: null,
    latitude: null,
    longitude: null,
    capturedAt: null,
    distanceKm: null,
    validationSource: null,
    verificationReport: null,
});

const buildVerificationReportPayload = (validation) => {
    if (!validation?.report || typeof validation.report !== 'object') return null;

    const report = validation.report;
    const exifTimestamp = Number.isFinite(report?.exif?.timestamp)
        ? new Date(report.exif.timestamp * 1000)
        : null;
    const ocrTimestamp = Number.isFinite(report?.ocr?.timestamp)
        ? new Date(report.ocr.timestamp * 1000)
        : null;

    return {
        source: report.source || validation.validationSource || null,
        reason: validation.reason || null,
        reasonCode: validation.reasonCode || null,
        missingFields: Array.isArray(validation.missingFields) ? validation.missingFields : [],
        exif: {
            latitude: Number.isFinite(report?.exif?.latitude) ? report.exif.latitude : null,
            longitude: Number.isFinite(report?.exif?.longitude) ? report.exif.longitude : null,
            capturedAt: exifTimestamp && !Number.isNaN(exifTimestamp.getTime()) ? exifTimestamp : null,
        },
        ocr: {
            latitude: Number.isFinite(report?.ocr?.latitude) ? report.ocr.latitude : null,
            longitude: Number.isFinite(report?.ocr?.longitude) ? report.ocr.longitude : null,
            capturedAt: ocrTimestamp && !Number.isNaN(ocrTimestamp.getTime()) ? ocrTimestamp : null,
            text: report?.ocr?.text || null,
        },
        comparisons: {
            geoMatch: typeof report?.comparisons?.geoMatch === 'boolean' ? report.comparisons.geoMatch : null,
            timeMatch: typeof report?.comparisons?.timeMatch === 'boolean' ? report.comparisons.timeMatch : null,
            distanceKm: Number.isFinite(report?.comparisons?.distanceKm) ? report.comparisons.distanceKm : null,
            collegeLatitude: report?.comparisons?.collegeLatitude ?? null,
            collegeLongitude: report?.comparisons?.collegeLongitude ?? null,
            assignedDate: report?.comparisons?.assignedDate || null,
            detectedDate: report?.comparisons?.detectedDate || null,
        },
    };
};

const CHECK_OUT_REQUIRED_IMAGE_COUNT = 3;
const CHECK_OUT_ALLOWED_RANGE_KM = CHECK_OUT_ALLOWED_GEO_RANGE_METERS / 1000;

const toDateOrNull = (value) => {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toCheckOutEvidenceItem = ({
    status = 'PENDING',
    reason = null,
    report = null,
    distanceKm = null,
    latitude = null,
    longitude = null,
    capturedAt = null,
} = {}) => {
    const normalizedStatus = String(status || '').trim().toUpperCase();
    const exifLatitude = Number.isFinite(report?.exif?.latitude) ? report.exif.latitude : null;
    const exifLongitude = Number.isFinite(report?.exif?.longitude) ? report.exif.longitude : null;
    const exifCapturedAt = toDateOrNull(report?.exif?.capturedAt);
    const assignedDate = String(report?.comparisons?.assignedDate || '').trim() || null;
    const detectedDate = String(report?.comparisons?.detectedDate || '').trim() || null;
    const resolvedDistanceKm = Number.isFinite(distanceKm)
        ? distanceKm
        : (Number.isFinite(report?.comparisons?.distanceKm) ? report.comparisons.distanceKm : null);
    const resolvedLatitude = Number.isFinite(latitude)
        ? latitude
        : (Number.isFinite(report?.ocr?.latitude) ? report.ocr.latitude : null);
    const resolvedLongitude = Number.isFinite(longitude)
        ? longitude
        : (Number.isFinite(report?.ocr?.longitude) ? report.ocr.longitude : null);
    const resolvedCapturedAt = toDateOrNull(capturedAt)
        || toDateOrNull(report?.ocr?.capturedAt)
        || exifCapturedAt;
    const distanceMeters = Number.isFinite(resolvedDistanceKm)
        ? resolvedDistanceKm * 1000
        : null;

    return {
        completed: normalizedStatus === 'COMPLETED' || normalizedStatus === 'VERIFIED',
        reason: String(reason || '').trim() || null,
        exifLatitude,
        exifLongitude,
        exifCapturedAt,
        latitude: resolvedLatitude,
        longitude: resolvedLongitude,
        capturedAt: resolvedCapturedAt,
        distanceMeters,
        dateMatched: assignedDate && detectedDate
            ? assignedDate === detectedDate
            : null,
        radiusMatched: Number.isFinite(distanceMeters)
            ? distanceMeters <= CHECK_OUT_ALLOWED_GEO_RANGE_METERS
            : null,
    };
};

const buildCheckOutVerificationResult = ({
    evidenceItems = [],
    fallbackReasons = [],
}) => {
    const normalizedEvidence = Array.isArray(evidenceItems)
        ? evidenceItems.filter(Boolean)
        : [];
    const normalizedFallbackReasons = Array.isArray(fallbackReasons)
        ? fallbackReasons.filter(Boolean).map((item) => String(item).trim())
        : [];

    const collectedReasons = [...normalizedFallbackReasons];
    const uniqueReasonSet = new Set();
    const collectReason = (value) => {
        const normalized = String(value || '').trim();
        if (!normalized || uniqueReasonSet.has(normalized)) return;
        uniqueReasonSet.add(normalized);
        collectedReasons.push(normalized);
    };

    if (normalizedEvidence.length < CHECK_OUT_REQUIRED_IMAGE_COUNT) {
        collectReason(`Awaiting ${CHECK_OUT_REQUIRED_IMAGE_COUNT} checkout images`);
        return {
            status: normalizeCheckOutVerificationStatus('pending_checkout'),
            reason: collectedReasons.join(' ') || null,
            capturedAt: null,
            latitude: null,
            longitude: null,
            distanceMeters: null,
        };
    }

    const missingExifIndexes = [];
    const incompleteIndexes = [];
    const dateMismatchIndexes = [];
    const radiusMismatchIndexes = [];

    normalizedEvidence.forEach((item, index) => {
        const oneBased = index + 1;
        const hasExif =
            Number.isFinite(item?.exifLatitude)
            && Number.isFinite(item?.exifLongitude)
            && item?.exifCapturedAt instanceof Date;

        if (!item?.completed) {
            incompleteIndexes.push(oneBased);
            collectReason(item?.reason || `Image ${oneBased}: validation incomplete`);
        }

        if (!hasExif) {
            missingExifIndexes.push(oneBased);
            collectReason(`Image ${oneBased}: missing EXIF date/latitude/longitude metadata`);
        }

        if (item?.dateMatched !== true) {
            dateMismatchIndexes.push(oneBased);
            collectReason(`Image ${oneBased}: schedule date mismatch`);
        }

        if (item?.radiusMatched !== true) {
            radiusMismatchIndexes.push(oneBased);
            collectReason(`Image ${oneBased}: location outside allowed radius`);
        }
    });

    const autoVerified =
        incompleteIndexes.length === 0
        && missingExifIndexes.length === 0
        && dateMismatchIndexes.length === 0
        && radiusMismatchIndexes.length === 0;

    const preferredEvidence =
        normalizedEvidence.find((item) =>
            Number.isFinite(item?.exifLatitude)
            && Number.isFinite(item?.exifLongitude)
            && item?.exifCapturedAt instanceof Date,
        )
        || normalizedEvidence.find((item) =>
            Number.isFinite(item?.latitude) && Number.isFinite(item?.longitude),
        )
        || null;

    const status = normalizeCheckOutVerificationStatus(
        autoVerified ? 'auto_verified' : 'manual_review_required',
        'MANUAL_REVIEW_REQUIRED',
    );

    return {
        status,
        reason: autoVerified ? null : (collectedReasons.join(' ') || 'Manual review required'),
        capturedAt: preferredEvidence?.exifCapturedAt || preferredEvidence?.capturedAt || null,
        latitude: Number.isFinite(preferredEvidence?.exifLatitude)
            ? preferredEvidence.exifLatitude
            : (Number.isFinite(preferredEvidence?.latitude) ? preferredEvidence.latitude : null),
        longitude: Number.isFinite(preferredEvidence?.exifLongitude)
            ? preferredEvidence.exifLongitude
            : (Number.isFinite(preferredEvidence?.longitude) ? preferredEvidence.longitude : null),
        distanceMeters: Number.isFinite(preferredEvidence?.distanceMeters)
            ? preferredEvidence.distanceMeters
            : null,
    };
};

const applyCheckOutVerificationResult = ({
    attendance,
    verificationResult,
}) => {
    if (!attendance || !verificationResult) return false;

    const normalizedStatus = normalizeCheckOutVerificationStatus(
        verificationResult.status,
        'PENDING_CHECKOUT',
    );
    const autoVerified = normalizedStatus === 'AUTO_VERIFIED';
    const verificationTimestamp = autoVerified ? new Date() : null;

    attendance.checkOutVerificationStatus = normalizedStatus;
    attendance.checkOutVerificationMode = 'AUTO';
    attendance.checkOutVerificationReason = autoVerified
        ? null
        : (verificationResult.reason || 'Manual review required');
    attendance.geoValidationComment = autoVerified
        ? null
        : (verificationResult.reason || 'Manual review required');
    attendance.checkOutCapturedAt = verificationResult.capturedAt || null;
    attendance.checkOutLatitude = Number.isFinite(verificationResult.latitude)
        ? verificationResult.latitude
        : null;
    attendance.checkOutLongitude = Number.isFinite(verificationResult.longitude)
        ? verificationResult.longitude
        : null;
    attendance.checkOutGeoDistanceMeters = Number.isFinite(verificationResult.distanceMeters)
        ? verificationResult.distanceMeters
        : null;
    attendance.checkOutVerifiedAt = verificationTimestamp;
    attendance.checkOutVerifiedBy = null;
    attendance.geoVerificationStatus = normalizeVerificationStatus(
        autoVerified ? 'approved' : 'pending',
        'pending',
    );
    attendance.finalStatus = normalizeAttendanceFinalStatus(
        autoVerified ? 'completed' : 'pending',
        'PENDING',
    );
    attendance.completedAt = verificationTimestamp;

    return autoVerified;
};

const ensureFixedLengthSlotArray = (items, slotCount, buildDefaultSlot) => (
    Array.from({ length: slotCount }, (_, index) => {
        const existing = Array.isArray(items) ? items[index] : null;
        return existing && typeof existing === 'object'
            ? { ...buildDefaultSlot(), ...existing }
            : buildDefaultSlot();
    })
);

const deriveUploadedImageFinalStatus = (images = []) => {
    const normalizedImages = ensureFixedLengthSlotArray(images, 3, buildPendingCheckOutImageSlot);
    const hasAllImages = normalizedImages.every((item) => String(item?.image || '').trim());
    const allVerified = hasAllImages
        && normalizedImages.every((item) => String(item?.status || 'PENDING').trim().toUpperCase() === 'VERIFIED');

    return allVerified ? 'COMPLETED' : 'PENDING';
};

const saveUploadedGeoImageSlot = async ({
    attendanceId,
    assignedDate,
    imageIndex,
    normalizedImageData,
    uploadedPhotoPayload
}) => {
    let lastVersionError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const latestAttendance = await Attendance.findById(attendanceId);

        if (!latestAttendance) {
            const notFoundError = new Error('Attendance record not found for this trainer and date');
            notFoundError.statusCode = 404;
            throw notFoundError;
        }

        if (normalizeVerificationStatus(latestAttendance?.verificationStatus, '') !== 'approved') {
            const approvalError = new Error('Check-in must be approved by SPOC before GeoTag upload is allowed.');
            approvalError.statusCode = 400;
            throw approvalError;
        }

        const latestCheckOut = latestAttendance.checkOut && typeof latestAttendance.checkOut.toObject === 'function'
            ? latestAttendance.checkOut.toObject()
            : (latestAttendance.checkOut || {});
        const imageSlots = ensureFixedLengthSlotArray(
            Array.isArray(latestAttendance.images) && latestAttendance.images.length
                ? latestAttendance.images
                : latestCheckOut.images,
            3,
            buildPendingCheckOutImageSlot
        );
        const photoSlots = ensureFixedLengthSlotArray(
            latestCheckOut.photos,
            3,
            buildPendingCheckOutPhotoSlot
        );

        const existingImageSlot = imageSlots[imageIndex];
        if (
            String(existingImageSlot?.status || '').trim().toUpperCase() === 'VERIFIED'
            && String(existingImageSlot?.image || '').trim()
        ) {
            const lockedError = new Error(`Image ${imageIndex + 1} is already verified and cannot be replaced`);
            lockedError.statusCode = 409;
            throw lockedError;
        }

        imageSlots[imageIndex] = normalizedImageData;
        photoSlots[imageIndex] = uploadedPhotoPayload;

        const uploadedPhotoUrls = photoSlots
            .map((item) => item?.url)
            .filter((value) => typeof value === 'string' && value.trim());
        const firstImageWithLocation = photoSlots.find(
            (item) => Number.isFinite(item?.latitude) && Number.isFinite(item?.longitude)
        );
        const pendingReasons = photoSlots
            .map((item, index) => {
                if (!String(item?.url || '').trim()) {
                    return `Image ${index + 1}: Upload required`;
                }

                return String(item?.validationStatus || '').trim().toLowerCase() === 'verified'
                    ? null
                    : `Image ${index + 1}: ${item?.validationReason || 'Pending verification'}`;
            })
            .filter(Boolean);
        const evidenceItems = photoSlots.map((item, index) => {
            const imageSlot = imageSlots[index] || {};
            const imageStatus = String(imageSlot?.status || '').trim().toUpperCase();
            const photoStatus = String(item?.validationStatus || '').trim().toLowerCase();
            const status = imageStatus === 'VERIFIED' || photoStatus === 'verified'
                ? 'COMPLETED'
                : 'PENDING';
            return toCheckOutEvidenceItem({
                status,
                reason: item?.validationReason || null,
                report: item?.verificationReport || null,
                distanceKm: Number.isFinite(item?.distanceKm)
                    ? item.distanceKm
                    : (Number.isFinite(imageSlot?.distance) ? imageSlot.distance : null),
                latitude: Number.isFinite(item?.latitude)
                    ? item.latitude
                    : (Number.isFinite(imageSlot?.latitude) ? imageSlot.latitude : null),
                longitude: Number.isFinite(item?.longitude)
                    ? item.longitude
                    : (Number.isFinite(imageSlot?.longitude) ? imageSlot.longitude : null),
                capturedAt: item?.capturedAt || null,
            });
        });
        const checkOutVerificationResult = buildCheckOutVerificationResult({
            evidenceItems,
            fallbackReasons: pendingReasons,
        });
        applyCheckOutVerificationResult({
            attendance: latestAttendance,
            verificationResult: checkOutVerificationResult,
        });

        latestAttendance.assignedDate = assignedDate;
        latestAttendance.images = imageSlots;
        latestAttendance.checkOutGeoImageUrl = uploadedPhotoUrls[0] || null;
        latestAttendance.checkOutGeoImageUrls = uploadedPhotoUrls;
        latestAttendance.driveSyncStatus = 'PENDING';
        latestAttendance.checkOut = {
            ...latestCheckOut,
            finalStatus: normalizeAttendanceFinalStatus(latestAttendance.finalStatus, 'PENDING'),
            location: {
                ...(latestCheckOut?.location || {}),
                lat: Number.isFinite(firstImageWithLocation?.latitude)
                    ? firstImageWithLocation.latitude
                    : (latestCheckOut?.location?.lat ?? null),
                lng: Number.isFinite(firstImageWithLocation?.longitude)
                    ? firstImageWithLocation.longitude
                    : (latestCheckOut?.location?.lng ?? null),
                accuracy: Number.isFinite(firstImageWithLocation?.latitude) && Number.isFinite(firstImageWithLocation?.longitude)
                    ? null
                    : (latestCheckOut?.location?.accuracy ?? null),
                address: Number.isFinite(firstImageWithLocation?.latitude) && Number.isFinite(firstImageWithLocation?.longitude)
                    ? 'Geo-tag image location'
                    : (latestCheckOut?.location?.address || null),
                distanceFromCollege: Number.isFinite(firstImageWithLocation?.distanceKm)
                    ? firstImageWithLocation.distanceKm * 1000
                    : (latestCheckOut?.location?.distanceFromCollege ?? null),
            },
            images: imageSlots,
            photos: photoSlots
        };
        latestAttendance.markModified('images');
        latestAttendance.markModified('checkOut');
        latestAttendance.markModified('checkOutGeoImageUrl');
        latestAttendance.markModified('checkOutGeoImageUrls');
        latestAttendance.markModified('checkOutVerificationStatus');
        latestAttendance.markModified('checkOutVerificationMode');
        latestAttendance.markModified('checkOutVerificationReason');
        latestAttendance.markModified('checkOutCapturedAt');
        latestAttendance.markModified('checkOutLatitude');
        latestAttendance.markModified('checkOutLongitude');
        latestAttendance.markModified('checkOutGeoDistanceMeters');
        latestAttendance.markModified('checkOutVerifiedAt');
        latestAttendance.markModified('checkOutVerifiedBy');
        latestAttendance.markModified('driveSyncStatus');

        try {
            await latestAttendance.save();
            return latestAttendance;
        } catch (error) {
            if (error?.name === 'VersionError') {
                lastVersionError = error;
                continue;
            }
            throw error;
        }
    }

    throw lastVersionError || new Error('Failed to save GeoTag image after retrying concurrent updates.');
};



const validateAssignedScheduleUpload = ({ schedule, trainerId, collegeId, dayNumber, correlationId = null }) => {
    if (!schedule) {
        return { status: 404, message: 'Schedule not found' };
    }

    if (schedule.isActive === false) {
        logAttendanceAsyncTelemetry('warn', {
            correlationId,
            stage: 'checkin_validation_rejection',
            trainerId: toIdString(trainerId),
            scheduleId: toIdString(schedule._id),
            collegeId: toIdString(collegeId),
            status: 'rejection',
            outcome: 'denied',
            contextLabel: 'validateAssignedScheduleUpload',
            reason: `BRANCH=attendanceRoutes_validateAssignedScheduleUpload_inactive;rejectionEnum=INACTIVE_SCHEDULE`
        });
        return { status: 403, message: 'This schedule is inactive and cannot be modified' };
    }

    const rawStatus = String(schedule.status || '').toLowerCase();
    if (rawStatus === 'cancelled') {
        logAttendanceAsyncTelemetry('warn', {
            correlationId,
            stage: 'checkin_validation_rejection',
            trainerId: toIdString(trainerId),
            scheduleId: toIdString(schedule._id),
            collegeId: toIdString(collegeId),
            status: 'rejection',
            outcome: 'denied',
            contextLabel: 'validateAssignedScheduleUpload',
            reason: `BRANCH=attendanceRoutes_validateAssignedScheduleUpload_cancelled;rejectionEnum=CANCELLED_SCHEDULE`
        });
        return { status: 403, message: 'This training session is cancelled and no longer actionable' };
    }

    if (rawStatus === 'completed') {
        logAttendanceAsyncTelemetry('warn', {
            correlationId,
            stage: 'checkin_validation_rejection',
            trainerId: toIdString(trainerId),
            scheduleId: toIdString(schedule._id),
            collegeId: toIdString(collegeId),
            status: 'rejection',
            outcome: 'denied',
            contextLabel: 'validateAssignedScheduleUpload',
            reason: `BRANCH=attendanceRoutes_validateAssignedScheduleUpload_completed;rejectionEnum=COMPLETED_SCHEDULE`
        });
        return { status: 403, message: 'This training day is already marked as COMPLETED. No further edits allowed.' };
    }

    const expectedTrainerId = toIdString(schedule.trainerId);
    const providedTrainerId = toIdString(trainerId);
    const expectedCollegeId = toIdString(schedule.collegeId);
    const providedCollegeId = toIdString(collegeId);
    const expectedDayNumber = toDayNumber(schedule.dayNumber);
    const providedDayNumber = toDayNumber(dayNumber);

    if (!expectedTrainerId) {
        return { status: 403, message: 'This day is not assigned to any trainer yet' };
    }

    // Role-based/Assigned Trainer Validation
    if (providedTrainerId && expectedTrainerId !== providedTrainerId) {
        logAttendanceAsyncTelemetry('warn', {
            correlationId,
            stage: 'validate_upload_access',
            status: 'auth_failure',
            trainerId: providedTrainerId,
            scheduleId: toIdString(schedule._id),
            outcome: 'forbidden',
            reason: `Trainer Mismatch: provided=${providedTrainerId}, expected=${expectedTrainerId}`,
            contextLabel: 'UPLOAD_ACCESS_ERROR'
        });
        // HIGH-SIGNAL DIAGNOSTICS: Capture precisely why this is failing.
        logAttendanceAsyncTelemetry('warn', {
            correlationId,
            stage: 'checkin_validation_rejection',
            trainerId: providedTrainerId,
            scheduleId: toIdString(schedule?._id),
            collegeId: providedCollegeId,
            status: 'rejection',
            outcome: 'denied',
            contextLabel: 'validateAssignedScheduleUpload',
            reason: `BRANCH=attendanceRoutes_validateAssignedScheduleUpload;` +
                   `providedTrainer=${providedTrainerId};type=${typeof trainerId};` +
                   `expectedTrainer=${toIdString(schedule.trainerId)};type=${typeof schedule.trainerId};` +
                   `providedCollege=${providedCollegeId};type=${typeof collegeId};` +
                   `expectedCollege=${toIdString(schedule.collegeId)};type=${typeof schedule.collegeId};` +
                   `providedDay=${providedDayNumber};type=${typeof dayNumber};` +
                   `expectedDay=${toDayNumber(schedule.dayNumber)};type=${typeof schedule.dayNumber};` +
                   `rejectionEnum=${
                    toIdString(schedule.trainerId) !== providedTrainerId ? 'TRAINER_MISMATCH' :
                    toIdString(schedule.collegeId) !== providedCollegeId ? 'COLLEGE_MISMATCH' :
                    toDayNumber(schedule.dayNumber) !== providedDayNumber ? 'DAY_MISMATCH' :
                    'UNKNOWN_BRANCH'
                   }`
        });

        return { status: 403, message: 'Trainer can only upload for the assigned day and batch' };
    }

    // College/Batch Validation
    if (providedCollegeId && expectedCollegeId && expectedCollegeId !== providedCollegeId) {
        // HIGH-SIGNAL DIAGNOSTICS: Capture precisely why this is failing.
        logAttendanceAsyncTelemetry('warn', {
            correlationId,
            stage: 'checkin_validation_rejection',
            trainerId: providedTrainerId,
            scheduleId: toIdString(schedule?._id),
            collegeId: providedCollegeId,
            status: 'rejection',
            outcome: 'denied',
            contextLabel: 'validateAssignedScheduleUpload',
            reason: `BRANCH=attendanceRoutes_validateAssignedScheduleUpload_college;` +
                   `providedTrainer=${providedTrainerId};` +
                   `expectedTrainer=${expectedTrainerId};` +
                   `providedCollege=${providedCollegeId};type=${typeof collegeId};` +
                   `expectedCollege=${expectedCollegeId};type=${typeof schedule.collegeId};` +
                   `rejectionEnum=COLLEGE_MISMATCH`
        });
        return { status: 403, message: 'Trainer can only upload for the assigned batch and college' };
    }

    // Day Number Validation
    if (providedDayNumber && expectedDayNumber && expectedDayNumber !== providedDayNumber) {
        // HIGH-SIGNAL DIAGNOSTICS: Capture precisely why this is failing.
        logAttendanceAsyncTelemetry('warn', {
            correlationId,
            stage: 'checkin_validation_rejection',
            trainerId: providedTrainerId,
            scheduleId: toIdString(schedule?._id),
            collegeId: providedCollegeId,
            status: 'rejection',
            outcome: 'denied',
            contextLabel: 'validateAssignedScheduleUpload',
            reason: `BRANCH=attendanceRoutes_validateAssignedScheduleUpload_day;` +
                   `providedTrainer=${providedTrainerId};` +
                   `providedDay=${providedDayNumber};type=${typeof dayNumber};` +
                   `expectedDay=${expectedDayNumber};type=${typeof schedule.dayNumber};` +
                   `rejectionEnum=DAY_MISMATCH`
        });
        
        logAttendanceAsyncTelemetry('warn', {
            correlationId,
            stage: 'validate_upload_access',
            status: 'day_failure',
            trainerId: providedTrainerId,
            dayNumber: providedDayNumber,
            scheduleId: toIdString(schedule._id),
            outcome: 'forbidden',
            reason: `Day Mismatch: provided=${providedDayNumber}, expected=${expectedDayNumber}`,
            contextLabel: 'UPLOAD_ACCESS_ERROR'
        });
        return { status: 403, message: 'Trainer can only upload for the assigned day' };
    }

    return null;
};

const validateCheckOutSessionState = ({ attendance, mode = 'check-out' } = {}) => {
    if (!attendance) {
        return { status: 404, message: 'Attendance record not found for this schedule' };
    }

    const attendanceStatusToken = String(attendance?.status || '').trim().toLowerCase();
    if (attendanceStatusToken === 'cancelled' || attendanceStatusToken === 'canceled') {
        return {
            status: 400,
            message: mode === 'geo-upload'
                ? 'Attendance session is cancelled and cannot accept GeoTag uploads.'
                : 'Attendance session is cancelled and cannot be checked out.'
        };
    }

    const normalizedCheckOutStatus = normalizeCheckOutVerificationStatus(
        attendance?.checkOutVerificationStatus,
        '',
    );
    if (normalizedCheckOutStatus === 'AUTO_VERIFIED') {
        return {
            status: 400,
            message: mode === 'geo-upload'
                ? 'Check-out is already completed for this schedule. GeoTag upload is locked.'
                : 'Check-out is already completed for this schedule.'
        };
    }

    const normalizedFinalStatus = normalizeAttendanceFinalStatus(
        attendance?.finalStatus,
        '',
    );
    if (normalizedFinalStatus === 'COMPLETED') {
        return {
            status: 400,
            message: mode === 'geo-upload'
                ? 'Check-out is already completed for this schedule. GeoTag upload is locked.'
                : 'Check-out is already completed for this schedule.'
        };
    }

    return null;
};

const buildAllocatedDrivePathForSchedule = async (scheduleId) => {
    if (!scheduleId) return null;

    const schedule = await Schedule.findById(scheduleId)
        .select('companyId courseId collegeId departmentId dayNumber dayFolderName attendanceFolderName geoTagFolderName')
        .populate('companyId', 'name')
        .populate('courseId', 'title')
        .populate('collegeId', 'name')
        .populate('departmentId', 'name');

    if (!schedule) return null;

    const companyName = String(schedule?.companyId?.name || '').trim() || 'Company';
    const courseName = String(schedule?.courseId?.title || '').trim() || 'Course';
    const collegeName = String(schedule?.collegeId?.name || '').trim() || 'College';
    const departmentName = String(schedule?.departmentId?.name || '').trim() || 'Department';
    const safeDayNumber = toDayNumber(schedule?.dayNumber);
    const dayName = String(schedule?.dayFolderName || '').trim() || (safeDayNumber ? `Day_${safeDayNumber}` : 'Day');
    const attendanceFolderName = String(schedule?.attendanceFolderName || '').trim() || DRIVE_DAY_SUBFOLDERS.attendance;
    const geoTagFolderName = String(schedule?.geoTagFolderName || '').trim() || DRIVE_DAY_SUBFOLDERS.geoTag;

    const basePath = [companyName, courseName, collegeName, departmentName, dayName];
    return {
        basePath: basePath.join(' > '),
        attendancePath: [...basePath, attendanceFolderName].join(' > '),
        geoTagPath: [...basePath, geoTagFolderName].join(' > ')
    };
};

const resolveTrainerDriveCode = async (attendance) => {
    const rawTrainerId = attendance?.trainerId;
    if (!rawTrainerId) return 'TRAINER';

    if (typeof rawTrainerId === 'object' && rawTrainerId?.trainerId) {
        return String(rawTrainerId.trainerId).trim() || 'TRAINER';
    }

    const trainerLookupId = typeof rawTrainerId === 'object'
        ? (rawTrainerId._id || rawTrainerId.id || rawTrainerId)
        : rawTrainerId;
    const trainerDoc = await Trainer.findById(trainerLookupId).select('trainerId');
    return String(trainerDoc?.trainerId || '').trim() || `TRN_${toIdString(trainerLookupId).slice(-6)}`;
};

const buildDriveUploadFileName = ({ trainerCode, dayNumber, fieldName, file, index = 0 }) => {
    const safeTrainerCode = String(trainerCode || 'TRAINER').trim() || 'TRAINER';
    const safeDayNumber = toDayNumber(dayNumber) || 0;
    const extension = path.extname(file?.originalname || file?.path || '').toLowerCase() || '';
    const fieldNameToKindMap = {
        attendancePdf: 'Attendance',
        attendanceExcel: 'AttendanceSheet',
        studentsPhoto: 'StudentsPhoto',
        signature: 'CheckInSignature',
        photo: 'GeoProof',
        photos: 'GeoProof',
        image: 'GeoProof',
        images: 'GeoProof',
        checkOutGeoImage: 'GeoProof',
        activityPhotos: 'ActivityPhoto',
        activityVideos: 'ActivityVideo',
        checkOutSignature: 'CheckOutSignature'
    };
    const fileKind = fieldNameToKindMap[fieldName]
        || (resolveDriveSubFolderType(fieldName) === 'attendance' ? 'Attendance' : 'Geo');
    const suffix = index > 0 ? `_${index + 1}` : '';
    return `${safeTrainerCode}_Day${safeDayNumber}_${fileKind}${suffix}${extension}`;
};

const resolveBatchFolderNameFromSchedule = ({ college, department, course, fullSchedule }) => {
    const departmentName = String(department?.name || '').trim();
    const collegeName = String(college?.name || '').trim();
    const courseName = String(course?.title || '').trim();
    if (departmentName && collegeName) return `${collegeName}-${departmentName}`;
    if (departmentName) return departmentName;
    if (collegeName && courseName) return `${collegeName}-${courseName}`;
    if (collegeName) return `Batch_${collegeName}`;
    return `Batch_${fullSchedule?.departmentId || fullSchedule?.collegeId || 'GENERAL'}`;
};

const readDayFolderEntryFromDepartment = async ({ departmentId, dayNumber }) => {
    if (!departmentId || !dayNumber) return { department: null, dayEntry: null };

    const department = await Department.findById(departmentId).select('dayFolders');
    if (!department) return { department: null, dayEntry: null };

    const dayEntry = Array.isArray(department.dayFolders)
        ? department.dayFolders.find((item) => Number(item?.day) === Number(dayNumber)) || null
        : null;

    return { department, dayEntry };
};

const persistDepartmentDayFolderEntry = async ({
    department,
    dayNumber,
    dayFolder,
    attendanceFolder,
    geoTagFolder
}) => {
    if (!department || !dayNumber) return;

    const current = Array.isArray(department.dayFolders)
        ? department.dayFolders.map((item) => (typeof item?.toObject === 'function' ? item.toObject() : { ...item }))
        : [];
    const existingIndex = current.findIndex((item) => Number(item?.day) === Number(dayNumber));
    const existing = existingIndex >= 0 ? current[existingIndex] : {};

    const nextEntry = {
        ...existing,
        day: dayNumber,
        folderId: dayFolder?.id || existing.folderId || null,
        folderName: dayFolder?.name || existing.folderName || null,
        folderLink: dayFolder?.link || existing.folderLink || null,
        attendanceFolderId: attendanceFolder?.id || existing.attendanceFolderId || null,
        attendanceFolderName: attendanceFolder?.name || existing.attendanceFolderName || null,
        attendanceFolderLink: attendanceFolder?.link || existing.attendanceFolderLink || null,
        geoTagFolderId: geoTagFolder?.id || existing.geoTagFolderId || null,
        geoTagFolderName: geoTagFolder?.name || existing.geoTagFolderName || null,
        geoTagFolderLink: geoTagFolder?.link || existing.geoTagFolderLink || null
    };

    if (existingIndex >= 0) {
        current[existingIndex] = nextEntry;
    } else {
        current.push(nextEntry);
    }

    current.sort((a, b) => Number(a.day || 0) - Number(b.day || 0));
    department.dayFolders = current;
    await department.save();
};

const ensureScheduleDriveFolders = async ({ scheduleId, scheduleDoc }) => {
    if (!scheduleId) return null;

    const fullSchedule = scheduleDoc?.departmentId && scheduleDoc?.collegeId
        ? scheduleDoc
        : await Schedule.findById(scheduleId).select('companyId courseId collegeId departmentId dayNumber dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink');
    if (!fullSchedule?.collegeId) return null;

    const dayNumber = toDayNumber(fullSchedule.dayNumber);
    if (!Number.isFinite(dayNumber) || dayNumber <= 0) return null;

    const department = fullSchedule.departmentId
        ? await Department.findById(fullSchedule.departmentId).select('_id name companyId courseId collegeId dayFolders driveFolderId driveFolderName driveFolderLink')
        : null;
    const college = await College.findById(fullSchedule.collegeId).select('_id name companyId courseId driveFolderId driveFolderName driveFolderLink');
    if (!college) return null;

    const { Company, Course } = require('../models');
    const companyIdForLookup = department?.companyId || college?.companyId || fullSchedule?.companyId || null;
    const courseIdForLookup = department?.courseId || college?.courseId || fullSchedule?.courseId || null;
    const company = companyIdForLookup
        ? await Company.findById(companyIdForLookup).select('_id name driveFolderId driveFolderName driveFolderLink')
        : null;
    const course = courseIdForLookup
        ? await Course.findById(courseIdForLookup).select('_id title driveFolderId driveFolderName driveFolderLink')
        : null;

    const hierarchy = department?._id
        ? await ensureDepartmentHierarchy({
            company: company || { _id: companyIdForLookup, name: `Company_${companyIdForLookup}` },
            course: course || null,
            college,
            department,
            totalDays: 12,
        })
        : null;

    if (hierarchy?.departmentFolder?.id) {
        const dayFolders = toDepartmentDayFolders(hierarchy?.dayFoldersByDayNumber || {});
        if (dayFolders.length) {
            department.dayFolders = dayFolders;
        }
        department.driveFolderId = hierarchy.departmentFolder.id;
        department.driveFolderName = hierarchy.departmentFolder.name;
        department.driveFolderLink = hierarchy.departmentFolder.link;
        await department.save();

        const dayEntry = dayFolders.find((item) => Number(item.day) === dayNumber) || null;
        if (!dayEntry?.folderId) return null;

        const scheduleFolderState = {
            dayFolderId: dayEntry.folderId,
            dayFolderName: dayEntry.folderName || null,
            dayFolderLink: dayEntry.folderLink || null,
            attendanceFolderId: dayEntry.attendanceFolderId || null,
            attendanceFolderName: dayEntry.attendanceFolderName || null,
            attendanceFolderLink: dayEntry.attendanceFolderLink || null,
            geoTagFolderId: dayEntry.geoTagFolderId || null,
            geoTagFolderName: dayEntry.geoTagFolderName || null,
            geoTagFolderLink: dayEntry.geoTagFolderLink || null,
            driveFolderId: dayEntry.folderId,
            driveFolderName: dayEntry.folderName || null,
            driveFolderLink: dayEntry.folderLink || null,
        };

        await Schedule.findByIdAndUpdate(scheduleId, { $set: scheduleFolderState });
        return { ...scheduleFolderState, departmentId: fullSchedule.departmentId, dayNumber };
    }

    // Fallback path for legacy schedules that are missing department mapping.
    const rootFolder = await ensureTrainingRootFolder();
    if (!rootFolder?.id) return null;

    const companyFolder = await ensureDriveFolder({
        folderName: company?.name || `Company_${fullSchedule.companyId || college.companyId || 'UNASSIGNED'}`,
        parentFolderId: rootFolder.id,
    });
    const courseFolder = await ensureDriveFolder({
        folderName: course?.title || `Course_${fullSchedule.courseId || college.courseId || 'GENERAL'}`,
        parentFolderId: companyFolder.id,
    });
    const collegeFolder = await ensureDriveFolder({
        folderName: college?.name || `College_${fullSchedule.collegeId || 'GENERAL'}`,
        parentFolderId: courseFolder.id,
    });
    const batchFolder = await ensureDriveFolder({
        folderName: resolveBatchFolderNameFromSchedule({ college, department, course, fullSchedule }),
        parentFolderId: collegeFolder.id,
    });
    const dayFolder = await ensureDriveFolder({
        folderName: `Day_${dayNumber}`,
        parentFolderId: batchFolder.id,
    });
    const attendanceFolder = await ensureDriveFolder({
        folderName: DRIVE_DAY_SUBFOLDERS.attendance,
        parentFolderId: dayFolder.id,
    });
    const geoTagFolder = await ensureDriveFolder({
        folderName: DRIVE_DAY_SUBFOLDERS.geoTag,
        parentFolderId: dayFolder.id,
    });

    const scheduleFolderState = {
        dayFolderId: dayFolder.id,
        dayFolderName: dayFolder.name || `Day_${dayNumber}`,
        dayFolderLink: dayFolder.webViewLink || null,
        attendanceFolderId: attendanceFolder.id,
        attendanceFolderName: attendanceFolder.name || DRIVE_DAY_SUBFOLDERS.attendance,
        attendanceFolderLink: attendanceFolder.webViewLink || null,
        geoTagFolderId: geoTagFolder.id,
        geoTagFolderName: geoTagFolder.name || DRIVE_DAY_SUBFOLDERS.geoTag,
        geoTagFolderLink: geoTagFolder.webViewLink || null,
        driveFolderId: dayFolder.id,
        driveFolderName: dayFolder.name || `Day_${dayNumber}`,
        driveFolderLink: dayFolder.webViewLink || null,
    };

    if (department) {
        await persistDepartmentDayFolderEntry({
            department,
            dayNumber,
            dayFolder: { id: scheduleFolderState.dayFolderId, name: scheduleFolderState.dayFolderName, link: scheduleFolderState.dayFolderLink },
            attendanceFolder: { id: scheduleFolderState.attendanceFolderId, name: scheduleFolderState.attendanceFolderName, link: scheduleFolderState.attendanceFolderLink },
            geoTagFolder: { id: scheduleFolderState.geoTagFolderId, name: scheduleFolderState.geoTagFolderName, link: scheduleFolderState.geoTagFolderLink },
        });
    }

    await Schedule.findByIdAndUpdate(scheduleId, { $set: scheduleFolderState });
    return { ...scheduleFolderState, departmentId: fullSchedule.departmentId, dayNumber };
};

const uploadAttendanceFilesToDrive = async ({
    filesByField,
    getTargetFolder,
    buildFileName,
    correlationId = null,
    attempt = null,
    scheduleId = null,
    attendanceId = null,
    contextLabel = null,
}) => {
    const uploadedByField = {};
    const uploadedFiles = [];

    for (const [fieldName, fieldFiles] of Object.entries(filesByField || {})) {
        const normalizedFiles = Array.isArray(fieldFiles)
            ? fieldFiles.filter(file => file?.path)
            : [];
        if (!normalizedFiles.length) continue;
        const targetFolder = getTargetFolder(fieldName);
        if (!targetFolder?.id) continue;

        const fieldUploads = [];
        for (const [index, file] of normalizedFiles.entries()) {
            logAttendanceAsyncTelemetry('debug', {
                correlationId,
                stage: 'drive_file_upload_started',
                scheduleId: scheduleId ? String(scheduleId) : null,
                attendanceId: attendanceId ? String(attendanceId) : null,
                status: 'drive_sync',
                outcome: 'started',
                attempt: Number.isFinite(attempt) ? attempt : null,
                cleanupMode: 'drive_upload',
                reason: `field=${fieldName};file=${file.originalname || path.basename(file.path)};folder=${targetFolder.id}`,
                contextLabel,
            });
            const fileBuffer = await fs.promises.readFile(file.path);
            const uploaded = await uploadToDriveWithRetry({
                fileBuffer,
                mimeType: getFileMimeType(file),
                originalName: file.originalname || path.basename(file.path),
                folderId: targetFolder.id,
                fileName: typeof buildFileName === 'function'
                    ? buildFileName({ fieldName, file, index })
                    : undefined
            }, { attempts: 3, initialDelayMs: 500 });
            const driveAsset = {
                ...uploaded,
                fieldName,
                folderType: targetFolder.type,
                mimeType: getFileMimeType(file),
                originalName: file.originalname || null,
                localPath: file.path,
                uploadedAt: new Date().toISOString()
            };
            fieldUploads.push(driveAsset);
            uploadedFiles.push(driveAsset);
        }

        uploadedByField[fieldName] = fieldUploads;
    }

    return {
        syncedAt: new Date().toISOString(),
        filesByField: uploadedByField,
        files: uploadedFiles
    };
};

const persistScheduleDocumentsForDriveAssets = async ({ attendance, scheduleId, files }) => {
    if (!attendance || !scheduleId || !Array.isArray(files) || !files.length) return;
    const trainerId = attendance.trainerId || null;
    if (!trainerId) return;

    const scheduleObjectId = toObjectIdOrNull(scheduleId);
    const attendanceObjectId = toObjectIdOrNull(attendance._id);
    const trainerObjectId = toObjectIdOrNull(trainerId);
    if (!scheduleObjectId || !trainerObjectId) return;

    for (const file of files) {
        if (!file?.fileId) continue;
        const fileLink = file.webViewLink || file.fileUrl || file.downloadLink || null;
        if (!fileLink) continue;

        const updatePayload = {
            scheduleId: scheduleObjectId,
            attendanceId: attendanceObjectId,
            trainerId: trainerObjectId,
            fileType: toScheduleDocumentFileType(file.folderType),
            fileField: file.fieldName || null,
            fileName: file.fileName || file.originalName || null,
            fileUrl: fileLink
        };

        await ScheduleDocument.findOneAndUpdate(
            { driveFileId: file.fileId },
            {
                $set: updatePayload,
                $setOnInsert: {
                    driveFileId: file.fileId,
                    status: 'pending',
                    verifiedBy: null,
                    verifiedAt: null,
                    rejectReason: null
                }
            },
            {
                new: true,
                upsert: true,
                setDefaultsOnInsert: true
            }
        );
    }
};

const updateScheduleDocumentsVerificationStatus = async ({
    attendance,
    fileType,
    verificationStatus,
    verifiedBy,
    rejectReason
}) => {
    if (!attendance?.scheduleId || !fileType) return;
    const scheduleObjectId = toObjectIdOrNull(attendance.scheduleId);
    if (!scheduleObjectId) return;

    const status = toScheduleDocumentStatus(verificationStatus);
    const updatePayload = {
        status,
        verifiedAt: status === 'pending' ? null : new Date(),
        rejectReason: status === 'rejected' ? (rejectReason || null) : null
    };
    if (verifiedBy && mongoose.Types.ObjectId.isValid(verifiedBy)) {
        updatePayload.verifiedBy = verifiedBy;
    } else if (status === 'pending') {
        updatePayload.verifiedBy = null;
    }

    await ScheduleDocument.updateMany(
        { scheduleId: scheduleObjectId, fileType },
        { $set: updatePayload }
    );
};

const normalizeStoredLocalPath = (storedPath) => {
    if (!storedPath || typeof storedPath !== 'string') return null;
    const trimmed = storedPath.trim();
    if (!trimmed) return null;

    const absoluteCandidate = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(process.cwd(), trimmed);
    if (fs.existsSync(absoluteCandidate)) return absoluteCandidate;

    const serverRelativeCandidate = path.resolve(__dirname, '..', trimmed.replace(/^[\\/]+/, ''));
    if (fs.existsSync(serverRelativeCandidate)) return serverRelativeCandidate;

    return null;
};

const toStoredFileObject = (storedPath, overrides = {}) => {
    const resolvedPath = normalizeStoredLocalPath(storedPath);
    if (!resolvedPath) return null;
    return {
        path: resolvedPath,
        originalname: overrides.originalname || path.basename(resolvedPath),
        mimetype: overrides.mimetype || undefined
    };
};

const collectAttendanceFilesForDriveSync = (attendance) => {
    if (!attendance) return {};

    const existingFiles = Array.isArray(attendance?.driveAssets?.files)
        ? attendance.driveAssets.files
        : [];
    const alreadySyncedLocalPaths = new Set(
        existingFiles
            .map((item) => normalizeStoredLocalPath(item?.localPath || item?.path || ''))
            .filter(Boolean)
    );
    const queuedLocalPaths = new Set();
    const isNotSyncedYet = (fileObj) => {
        const normalizedPath = normalizeStoredLocalPath(fileObj?.path || '');
        if (!normalizedPath) return false;
        if (alreadySyncedLocalPaths.has(normalizedPath)) return false;
        if (queuedLocalPaths.has(normalizedPath)) return false;
        queuedLocalPaths.add(normalizedPath);
        return true;
    };

    const filesByField = {};
    const pushFile = (fieldName, storedPath, overrides = {}) => {
        const fileObj = toStoredFileObject(storedPath, overrides);
        if (!fileObj || !isNotSyncedYet(fileObj)) return;
        if (!filesByField[fieldName]) filesByField[fieldName] = [];
        filesByField[fieldName].push(fileObj);
    };
    const pushMany = (fieldName, storedPaths, overrides = {}) => {
        if (!Array.isArray(storedPaths)) return;
        storedPaths.forEach((storedPath) => pushFile(fieldName, storedPath, overrides));
    };

    pushFile('attendancePdf', attendance.attendancePdfUrl, { mimetype: 'application/pdf' });
    pushFile('signature', attendance.signatureUrl);

    if (Array.isArray(attendance.studentsPhotoUrl)) {
        pushMany('studentsPhoto', attendance.studentsPhotoUrl);
    } else {
        pushFile('studentsPhoto', attendance.studentsPhotoUrl);
    }

    pushMany('checkOutGeoImage', attendance.checkOutGeoImageUrls);
    pushFile('checkOutGeoImage', attendance.checkOutGeoImageUrl);
    pushMany('activityPhotos', attendance.activityPhotos);
    pushMany('activityVideos', attendance.activityVideos);
    pushFile('checkOutSignature', attendance.checkOutSignatureUrl);

    if (attendance.attendanceExcelUrl) {
        const excelRef = String(attendance.attendanceExcelUrl).trim();
        const excelPath = normalizeStoredLocalPath(excelRef)
            || path.resolve(__dirname, '../uploads/attendance-sheets', excelRef);
        pushFile('attendanceExcel', excelPath, {
            originalname: path.basename(excelRef),
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
    }

    return filesByField;
};

const syncStoredAttendanceFilesToDrive = async (
    attendance,
    contextLabel,
    options = {}
) => {
    if (!attendance?.scheduleId) return;
    const correlationId = options?.correlationId || createCorrelationId('attendance_drive_sync');
    const attempt = Number.parseInt(options?.attempt || '1', 10) || 1;

    const filesByField = collectAttendanceFilesForDriveSync(attendance);
    if (!Object.keys(filesByField).length) {
        attendance.driveSyncStatus = 'PENDING';
        await attendance.save();
        logAttendanceAsyncTelemetry('info', {
            correlationId,
            stage: 'drive_sync_skipped_no_files',
            scheduleId: attendance?.scheduleId ? String(attendance.scheduleId) : null,
            attendanceId: attendance?._id ? String(attendance._id) : null,
            status: 'drive_sync',
            outcome: 'skipped',
            attempt,
            contextLabel,
        });
        return;
    }

    try {
        await syncAttendanceFilesToDrive({
            attendance,
            scheduleId: attendance.scheduleId,
            filesByField,
            contextLabel,
            correlationId,
            attempt,
        });
        attendance.driveSyncStatus = attendance?.driveAssets?.lastSyncError
            ? 'FAILED'
            : 'SYNCED';
        logAttendanceAsyncTelemetry('info', {
            correlationId,
            stage: 'drive_sync_completed',
            scheduleId: attendance?.scheduleId ? String(attendance.scheduleId) : null,
            attendanceId: attendance?._id ? String(attendance._id) : null,
            status: 'drive_sync',
            outcome: attendance?.driveAssets?.lastSyncError ? 'failed' : 'succeeded',
            attempt,
            contextLabel,
            reason: attendance?.driveAssets?.lastSyncError || null,
        });
    } catch (error) {
        attendance.driveSyncStatus = 'FAILED';
        logAttendanceAsyncTelemetry('error', {
            correlationId,
            stage: 'drive_sync_failed',
            scheduleId: attendance?.scheduleId ? String(attendance.scheduleId) : null,
            attendanceId: attendance?._id ? String(attendance._id) : null,
            status: 'drive_sync',
            outcome: 'failed',
            attempt,
            contextLabel,
            reason: error.message,
        });
    }

    await attendance.save();
};

let attendanceDriveSyncJobRegistered = false;
const ensureAttendanceDriveSyncJobRegistration = () => {
    if (attendanceDriveSyncJobRegistered) return;

    registerFileWorkflowJobHandler(
        FILE_WORKFLOW_JOB_TYPES.ATTENDANCE_DRIVE_SYNC,
        async (payload = {}, job = {}) => {
            const attendanceId = payload.attendanceId;
            const contextLabel = payload.contextLabel || 'attendance-drive-sync';
            const correlationId = payload.correlationId || createCorrelationId('attendance_drive_sync');
            const attempt = Number.parseInt(job?.attempt || '0', 10) + 1;

            if (!attendanceId) return;
            const latestAttendance = await Attendance.findById(attendanceId);
            if (!latestAttendance) return;

            await syncStoredAttendanceFilesToDrive(latestAttendance, contextLabel, {
                correlationId,
                attempt,
            });
        }
    );

    attendanceDriveSyncJobRegistered = true;
};

const queueStoredAttendanceDriveSync = ({
    attendanceId,
    contextLabel,
    correlationId = null,
}) => {
    if (!attendanceId || !isTrainingDriveEnabled()) return false;
    const resolvedCorrelationId = correlationId || createCorrelationId('attendance_drive_sync');

    ensureAttendanceDriveSyncJobRegistration();
    Attendance.updateOne(
        { _id: attendanceId },
        { $set: { driveSyncStatus: 'QUEUED' } },
    ).catch((error) => {
        logAttendanceAsyncTelemetry('warn', {
            correlationId: resolvedCorrelationId,
            stage: 'drive_sync_mark_queued_failed',
            attendanceId: String(attendanceId),
            status: 'drive_sync',
            outcome: 'failed',
            cleanupMode: 'queue_mark',
            reason: error.message,
            contextLabel,
        });
    });
    enqueueFileWorkflowJob({
        type: FILE_WORKFLOW_JOB_TYPES.ATTENDANCE_DRIVE_SYNC,
        payload: {
            attendanceId: String(attendanceId),
            contextLabel: contextLabel || 'attendance-drive-sync',
            correlationId: resolvedCorrelationId,
        },
        maxAttempts: 3,
    }).catch((error) => {
        Attendance.updateOne(
            { _id: attendanceId },
            { $set: { driveSyncStatus: 'FAILED' } },
        ).catch((statusUpdateError) => {
            logAttendanceAsyncTelemetry('error', {
                correlationId: resolvedCorrelationId,
                stage: 'drive_sync_mark_failed_after_enqueue_error',
                attendanceId: String(attendanceId),
                status: 'drive_sync',
                outcome: 'failed',
                cleanupMode: 'queue_mark',
                reason: statusUpdateError.message,
                contextLabel,
            });
        });
        logAttendanceAsyncTelemetry('error', {
            correlationId: resolvedCorrelationId,
            stage: 'drive_sync_enqueue_failed',
            attendanceId: String(attendanceId),
            status: 'drive_sync',
            outcome: 'failed',
            cleanupMode: 'queue_enqueue',
            reason: error.message,
            contextLabel,
        });
    });

    logAttendanceAsyncTelemetry('info', {
        correlationId: resolvedCorrelationId,
        stage: 'drive_sync_enqueued',
        attendanceId: String(attendanceId),
        status: 'drive_sync',
        outcome: 'queued',
        attempt: 1,
        cleanupMode: 'queue_enqueue',
        contextLabel,
    });

    return true;
};

const resolveCanonicalUploadFolders = async ({
    scheduleDoc,
    dayEntry,
    dayFolderId,
    ensureDriveFolderLoader = ensureDriveFolder,
}) => {
    if (!dayFolderId) return null;

    const preferredDayEntry = {
        ...(dayEntry || {}),
    };
    if (scheduleDoc?.attendanceFolderId) {
        delete preferredDayEntry.attendanceFolderId;
        delete preferredDayEntry.attendanceFolderName;
        delete preferredDayEntry.attendanceFolderLink;
        delete preferredDayEntry.attendanceFolder;
    }
    if (scheduleDoc?.geoTagFolderId) {
        delete preferredDayEntry.geoTagFolderId;
        delete preferredDayEntry.geoTagFolderName;
        delete preferredDayEntry.geoTagFolderLink;
        delete preferredDayEntry.geoTagFolder;
    }

    const resolvedFolderFields = buildScheduleFolderFields({
        dayEntry: preferredDayEntry,
        fallbackDayFolderId: scheduleDoc?.dayFolderId || scheduleDoc?.driveFolderId || null,
        fallbackDayFolderName: scheduleDoc?.dayFolderName || scheduleDoc?.driveFolderName || null,
        fallbackDayFolderLink: scheduleDoc?.dayFolderLink || scheduleDoc?.driveFolderLink || null,
        fallbackAttendanceFolderId: scheduleDoc?.attendanceFolderId || null,
        fallbackAttendanceFolderName: scheduleDoc?.attendanceFolderName || null,
        fallbackAttendanceFolderLink: scheduleDoc?.attendanceFolderLink || null,
        fallbackGeoTagFolderId: scheduleDoc?.geoTagFolderId || null,
        fallbackGeoTagFolderName: scheduleDoc?.geoTagFolderName || null,
        fallbackGeoTagFolderLink: scheduleDoc?.geoTagFolderLink || null,
    });

    const attendanceFolder = resolvedFolderFields.attendanceFolderId
        ? {
            id: resolvedFolderFields.attendanceFolderId,
            name: resolvedFolderFields.attendanceFolderName || DRIVE_DAY_SUBFOLDERS.attendance,
            webViewLink: resolvedFolderFields.attendanceFolderLink || null
        }
        : await ensureDriveFolderLoader({
            folderName: DRIVE_DAY_SUBFOLDERS.attendance,
            parentFolderId: dayFolderId
        });

    const geoTagFolder = resolvedFolderFields.geoTagFolderId
        ? {
            id: resolvedFolderFields.geoTagFolderId,
            name: resolvedFolderFields.geoTagFolderName || DRIVE_DAY_SUBFOLDERS.geoTag,
            webViewLink: resolvedFolderFields.geoTagFolderLink || null
        }
        : await ensureDriveFolderLoader({
            folderName: DRIVE_DAY_SUBFOLDERS.geoTag,
            parentFolderId: dayFolderId
        });

    return {
        attendanceFolder,
        geoTagFolder,
        resolvedFolderFields
    };
};

const syncAttendanceFilesToDrive = async ({
    attendance,
    scheduleId,
    schedule,
    filesByField,
    contextLabel = 'attendance upload',
    correlationId = null,
    attempt = null,
}) => {
    if (!attendance || !filesByField || !Object.keys(filesByField).length) return;
    if (!isTrainingDriveEnabled()) return;
    const resolvedCorrelationId = correlationId || createCorrelationId('attendance_drive_sync');
    const resolvedAttempt = Number.parseInt(attempt || '1', 10) || 1;

    const scheduleDoc = schedule?.driveFolderId || schedule?.dayFolderId
        ? schedule
        : await Schedule.findById(scheduleId).select('dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink departmentId dayNumber');
    const scheduleDayNumber = toDayNumber(scheduleDoc?.dayNumber);
    const hasScheduleFolderRefs = Boolean(
        scheduleDoc?.attendanceFolderId
        && scheduleDoc?.geoTagFolderId
        && (scheduleDoc?.dayFolderId || scheduleDoc?.driveFolderId)
    );
    const { department, dayEntry } = hasScheduleFolderRefs
        ? { department: null, dayEntry: null }
        : await readDayFolderEntryFromDepartment({
            departmentId: scheduleDoc?.departmentId,
            dayNumber: scheduleDayNumber
        });

    let dayFolderId = scheduleDoc?.dayFolderId || scheduleDoc?.driveFolderId || dayEntry?.folderId || null;
    if (scheduleId) {
        try {
            const ensured = await ensureScheduleDriveFolders({ scheduleId, scheduleDoc });
            if (ensured?.dayFolderId) {
                dayFolderId = ensured.dayFolderId;
                scheduleDoc.dayFolderId = ensured.dayFolderId;
                scheduleDoc.dayFolderName = ensured.dayFolderName;
                scheduleDoc.dayFolderLink = ensured.dayFolderLink;
                scheduleDoc.attendanceFolderId = ensured.attendanceFolderId;
                scheduleDoc.attendanceFolderName = ensured.attendanceFolderName;
                scheduleDoc.attendanceFolderLink = ensured.attendanceFolderLink;
                scheduleDoc.geoTagFolderId = ensured.geoTagFolderId;
                scheduleDoc.geoTagFolderName = ensured.geoTagFolderName;
                scheduleDoc.geoTagFolderLink = ensured.geoTagFolderLink;
                scheduleDoc.driveFolderId = ensured.dayFolderId;
                scheduleDoc.driveFolderName = ensured.dayFolderName;
                scheduleDoc.driveFolderLink = ensured.dayFolderLink;
            }
        } catch (ensureError) {
            logAttendanceAsyncTelemetry('warn', {
                correlationId: resolvedCorrelationId,
                stage: 'ensure_schedule_drive_folders_failed',
                scheduleId: scheduleId ? String(scheduleId) : null,
                attendanceId: attendance?._id ? String(attendance._id) : null,
                status: 'drive_sync',
                outcome: 'failed',
                attempt: resolvedAttempt,
                reason: ensureError.message,
                contextLabel,
            });
        }
    }
    if (!dayFolderId) return;

    attendance.driveFolderId = dayFolderId;

    try {
        const resolvedFolders = await resolveCanonicalUploadFolders({
            scheduleDoc,
            dayEntry,
            dayFolderId,
            ensureDriveFolderLoader: ensureDriveFolder,
        });
        if (!resolvedFolders) return;
        const { attendanceFolder, geoTagFolder } = resolvedFolders;
        const foldersByType = {
            attendance: toFolderAssetPayload(attendanceFolder, DRIVE_DAY_SUBFOLDERS.attendance),
            geoTag: toFolderAssetPayload(geoTagFolder, DRIVE_DAY_SUBFOLDERS.geoTag)
        };

        if (!hasScheduleFolderRefs) {
            await persistDepartmentDayFolderEntry({
                department,
                dayNumber: scheduleDayNumber,
                dayFolder: {
                    id: dayFolderId,
                    name: scheduleDoc?.dayFolderName || scheduleDoc?.driveFolderName || dayEntry?.folderName || null,
                    link: scheduleDoc?.dayFolderLink || scheduleDoc?.driveFolderLink || dayEntry?.folderLink || null
                },
                attendanceFolder: foldersByType.attendance,
                geoTagFolder: foldersByType.geoTag
            });
        }

        const nextScheduleFolderState = {
            dayFolderId,
            dayFolderName: scheduleDoc?.dayFolderName || scheduleDoc?.driveFolderName || dayEntry?.folderName || null,
            dayFolderLink: scheduleDoc?.dayFolderLink || scheduleDoc?.driveFolderLink || dayEntry?.folderLink || null,
            attendanceFolderId: foldersByType.attendance.id || null,
            attendanceFolderName: foldersByType.attendance.name || null,
            attendanceFolderLink: foldersByType.attendance.link || null,
            geoTagFolderId: foldersByType.geoTag.id || null,
            geoTagFolderName: foldersByType.geoTag.name || null,
            geoTagFolderLink: foldersByType.geoTag.link || null,
            driveFolderId: dayFolderId,
            driveFolderName: scheduleDoc?.driveFolderName || scheduleDoc?.dayFolderName || dayEntry?.folderName || null,
            driveFolderLink: scheduleDoc?.driveFolderLink || scheduleDoc?.dayFolderLink || dayEntry?.folderLink || null,
        };

        const shouldBackfillSchedule = !scheduleDoc?.dayFolderId
            || !scheduleDoc?.attendanceFolderId
            || !scheduleDoc?.geoTagFolderId
            || scheduleDoc?.driveFolderId !== nextScheduleFolderState.driveFolderId
            || scheduleDoc?.attendanceFolderId !== nextScheduleFolderState.attendanceFolderId
            || scheduleDoc?.geoTagFolderId !== nextScheduleFolderState.geoTagFolderId;

        if (shouldBackfillSchedule && scheduleId) {
            await Schedule.findByIdAndUpdate(scheduleId, { $set: nextScheduleFolderState });
        }

        const trainerCode = await resolveTrainerDriveCode(attendance);
        const syncResult = await uploadAttendanceFilesToDrive({
            filesByField,
            getTargetFolder: (fieldName) => foldersByType[resolveDriveSubFolderType(fieldName)] || null,
            buildFileName: ({ fieldName, file, index }) => buildDriveUploadFileName({
                trainerCode,
                dayNumber: scheduleDayNumber,
                fieldName,
                file,
                index
            }),
            correlationId: resolvedCorrelationId,
            attempt: resolvedAttempt,
            scheduleId: scheduleId ? String(scheduleId) : null,
            attendanceId: attendance?._id ? String(attendance._id) : null,
            contextLabel,
        });

        if (!syncResult.files?.length) return;
        await persistScheduleDocumentsForDriveAssets({
            attendance,
            scheduleId,
            files: syncResult.files
        });
        attendance.driveAssets = mergeDriveAssets(attendance.driveAssets, {
            ...syncResult,
            dayFolderId,
            subFolders: foldersByType
        });
    } catch (error) {
        logAttendanceAsyncTelemetry('error', {
            correlationId: resolvedCorrelationId,
            stage: 'drive_sync_failed',
            scheduleId: scheduleId ? String(scheduleId) : null,
            attendanceId: attendance?._id ? String(attendance._id) : null,
            status: 'drive_sync',
            outcome: 'failed',
            attempt: resolvedAttempt,
            cleanupMode: 'drive_sync',
            reason: error.message,
            contextLabel,
        });
        attendance.driveAssets = markDriveSyncError(attendance.driveAssets, error);
    }
};

// Trainer uploads attendance with image and signature
// Check In
const checkInHandler = async (req, res) => {
    let checkInStage = 'initializing request';
    const checkInCorrelationId = createCorrelationId('attendance_checkin');
    try {
        logAttendanceAsyncTelemetry('debug', {
            correlationId: checkInCorrelationId,
            stage: 'checkin_request_received',
            status: 'checkin',
            outcome: 'started',
            reason: `bodyKeys=${Object.keys(req.body || {}).join(',')}`,
            contextLabel: 'request',
        });
        
        let { trainerId, collegeId, scheduleId, dayNumber, checkInTime, latitude, longitude, studentsPresent, studentsAbsent } = req.body;
        let checkInLocation = req.body.checkInLocation;

        if (req.files) {
            logAttendanceAsyncTelemetry('debug', {
                correlationId: checkInCorrelationId,
                stage: 'checkin_files_received',
                status: 'checkin',
                outcome: 'received',
                reason: `fileKeys=${Object.keys(req.files).join(',')}`,
                contextLabel: 'request_files',
            });
            if (req.files.attendancePdf) {
                logAttendanceAsyncTelemetry('debug', {
                    correlationId: checkInCorrelationId,
                    stage: 'checkin_attendance_pdf_received',
                    status: 'checkin',
                    outcome: 'received',
                    reason: `name=${req.files.attendancePdf[0].originalname};size=${req.files.attendancePdf[0].size}`,
                    contextLabel: 'request_files',
                });
            }
        }

        // Parse checkInLocation if it's a string (from FormData)
        if (typeof checkInLocation === 'string') {
            checkInStage = 'parsing check-in location';
            try {
                checkInLocation = JSON.parse(checkInLocation);
            } catch (e) {
                logAttendanceAsyncTelemetry('warn', {
                    correlationId: checkInCorrelationId,
                    stage: 'checkin_location_parse_failed',
                    status: 'checkin',
                    outcome: 'failed',
                    reason: e.message,
                    contextLabel: checkInStage,
                });
            }
        }

        // Validate required fields
        if (!trainerId || !collegeId || !scheduleId) {
            return res.status(400).json({
                success: false,
                message: 'Trainer ID, College ID, and Schedule ID are required'
            });
        }

        const schedule = await Schedule.findById(scheduleId).select('trainerId collegeId collegeLocation dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink departmentId dayNumber status isActive');
        if (!schedule) {
            return res.status(404).json({
                success: false,
                message: 'Schedule not found'
            });
        }

        const uploadAccessError = validateAssignedScheduleUpload({
            schedule,
            trainerId,
            collegeId,
            dayNumber,
            correlationId: checkInCorrelationId
        });
        if (uploadAccessError) {
            return res.status(uploadAccessError.status).json({
                success: false,
                message: uploadAccessError.message
            });
        }

        const resolvedCollegeLocation = await resolveScheduleCollegeLocation(schedule);

        // 1. DISTANCE VALIDATION (HAIVERSINE)
        try {
            if (hasValidCollegeCoordinates(resolvedCollegeLocation)) {
                const currentLat = checkInLocation?.lat || latitude;
                const currentLng = checkInLocation?.lng || longitude;

                if (currentLat && currentLng) {
                    const trainerLoc = { latitude: parseFloat(currentLat), longitude: parseFloat(currentLng) };
                    const collegeLoc = {
                        latitude: resolvedCollegeLocation.lat,
                        longitude: resolvedCollegeLocation.lng
                    };

                    const distance = haversine(trainerLoc, collegeLoc);

                    if (distance > 300) {
                        logAttendanceAsyncTelemetry('info', {
                            correlationId: checkInCorrelationId,
                            stage: 'checkin_geo_fence_distance_recorded',
                            scheduleId: schedule?._id ? String(schedule._id) : null,
                            status: 'geo_validation',
                            outcome: 'outside_preferred_range',
                            reason: `distanceMeters=${Math.round(distance)}`,
                            contextLabel: 'distance_check',
                        });
                        // return res.status(400).json({
                        //     success: false,
                        //     message: `Access Denied: You are ${Math.round(distance)} meters away. Please be within 300m of the college campus to check in.`,
                        //     distance: Math.round(distance)
                        // });
                    }
                    
                    // Add distance to location data
                    if (checkInLocation) checkInLocation.distanceFromCollege = distance;
                }
            }
        } catch (distError) {
            logAttendanceAsyncTelemetry('warn', {
                correlationId: checkInCorrelationId,
                stage: 'checkin_distance_calculation_failed',
                scheduleId: schedule?._id ? String(schedule._id) : null,
                status: 'geo_validation',
                outcome: 'failed',
                reason: distError.message,
                contextLabel: 'distance_check',
            });
        }

        // LOCK: Prevent Check-In if Day is Completed
        // if (schedule.status === 'COMPLETED' || schedule.status === 'completed') {
        //      return res.status(400).json({
        //         success: false,
        //         message: 'This training day is already marked as COMPLETED. No further edits allowed.'
        //     });
        // }

        // Get file paths
        const attendancePdfUrl = req.files?.attendancePdf ? req.files.attendancePdf[0].path : null;
        const attendanceExcelUrl = req.files?.attendanceExcel ? req.files.attendanceExcel[0].path : null;

        // Parse student list if provided
        let students = [];
        if (req.body.studentList) {
            checkInStage = 'parsing student list';
            try {
                students = JSON.parse(req.body.studentList);
                
                // Auto-calculate counts if provided in the list
                if (students.length > 0) {
                     // Only override if not explicitly provided in body or if body has 0
                    if (!studentsPresent || parseInt(studentsPresent) === 0) {
                        studentsPresent = students.filter(s => s.status === 'Present').length;
                        studentsAbsent = students.filter(s => s.status === 'Absent').length;
                    }
                }
            } catch (e) {
                logAttendanceAsyncTelemetry('warn', {
                    correlationId: checkInCorrelationId,
                    stage: 'checkin_student_list_parse_failed',
                    status: 'checkin',
                    outcome: 'failed',
                    reason: e.message,
                    contextLabel: checkInStage,
                });
            }
        }

        // Check for existing attendance (e.g. for re-check-in after rejection)
        checkInStage = 'loading attendance record';
        let attendance = await Attendance.findOne({ scheduleId }).sort({ createdAt: -1 });

        if (attendance) {
            checkInStage = 'updating existing attendance';
            // Update existing record
            attendance.checkInTime = checkInTime || new Date().toTimeString().split(' ')[0];
            if (attendancePdfUrl) attendance.attendancePdfUrl = attendancePdfUrl;
            if (attendanceExcelUrl) attendance.attendanceExcelUrl = attendanceExcelUrl;
            if (latitude) attendance.latitude = latitude;
            if (longitude) attendance.longitude = longitude;
            
            // New Structured Location
            if (checkInLocation) {
                attendance.checkIn = {
                    time: new Date(),
                    location: checkInLocation
                };
            }

            attendance.studentsPresent = studentsPresent || 0;
            attendance.studentsAbsent = studentsAbsent || 0;
            attendance.students = students; // Save student list
            attendance.verificationStatus = 'pending'; // Reset status to pending
            attendance.geoVerificationStatus = 'pending';
            attendance.geoValidationComment = null;
            attendance.status = 'Pending';
            attendance.rejectionReason = undefined; // Clear previous rejection reason
            attendance.checkOutTime = null;
            attendance.checkOutGeoImageUrl = null;
            attendance.checkOutGeoImageUrls = [];
            attendance.activityPhotos = [];
            attendance.activityVideos = [];
            attendance.images = [];
            attendance.finalStatus = 'PENDING';
            attendance.checkOutCapturedAt = null;
            attendance.checkOutLatitude = null;
            attendance.checkOutLongitude = null;
            attendance.checkOutGeoDistanceMeters = null;
            attendance.checkOutVerificationStatus = normalizeCheckOutVerificationStatus('pending_checkout');
            attendance.checkOutVerificationMode = 'AUTO';
            attendance.checkOutVerificationReason = null;
            attendance.checkOutVerifiedAt = null;
            attendance.checkOutVerifiedBy = null;
            attendance.driveSyncStatus = 'PENDING';
            attendance.checkOut = {
                time: null,
                finalStatus: 'PENDING',
                location: {
                    lat: null,
                    lng: null,
                    accuracy: null,
                    address: null,
                    distanceFromCollege: null
                },
                images: [],
                photos: []
            };
            attendance.completedAt = null;
            if (req.body.syllabus) attendance.syllabus = req.body.syllabus; // Save syllabus
        } else {
            checkInStage = 'creating attendance';
            // Create new attendance record
            attendance = new Attendance({
                trainerId,
                collegeId,
                scheduleId,
                dayNumber: dayNumber || null,
                date: new Date(),
                checkInTime: checkInTime || new Date().toTimeString().split(' ')[0],
                checkIn: checkInLocation ? {
                    time: new Date(),
                    location: checkInLocation
                } : undefined,
                attendancePdfUrl,
                attendanceExcelUrl,
                latitude: latitude || null,
                longitude: longitude || null,
                uploadedBy: 'trainer',
                isManualEntry: false,
                status: 'Pending',
                studentsPresent: studentsPresent || 0,
                studentsAbsent: studentsAbsent || 0,
                students: students, // Save student list
                verificationStatus: 'pending',
                syllabus: req.body.syllabus || null, // Save syllabus
                checkOutVerificationStatus: normalizeCheckOutVerificationStatus('pending_checkout'),
                checkOutVerificationMode: 'AUTO',
                driveSyncStatus: 'PENDING',
            });
        }

        await attendance.save();
        const driveSyncQueued = queueStoredAttendanceDriveSync({
            attendanceId: attendance._id,
            contextLabel: 'check-in',
            correlationId: checkInCorrelationId,
        });

        checkInStage = 'updating schedule status';
        // Update Schedule status to 'inprogress' and update subject if provided
        const scheduleUpdate = { status: 'inprogress' };
        if (req.body.syllabus) {
            scheduleUpdate.subject = req.body.syllabus;
        }
        await Schedule.findByIdAndUpdate(scheduleId, scheduleUpdate);
        const dayState = await syncScheduleDayState({ scheduleId, attendance });
        emitAttendanceRealtimeUpdate(req, {
            type: 'DAY_STATUS_UPDATE',
            scheduleId,
            attendanceId: attendance._id,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Day status updated to ${dayState?.dayStatus || 'pending'}`
        });

        await invalidateTrainerScheduleCaches([
            attendance?.trainerId,
            schedule?.trainerId,
            trainerId,
        ]);

        // Notify Admins
        checkInStage = 'dispatching check-in notifications';
        try {
            const superAdmins = await User.find({ role: 'SuperAdmin' });
            const io = req.app.get('io');
            superAdmins.forEach(admin => {
                sendNotification(io, {
                    userId: admin._id,
                    role: admin.role,
                    title: 'New Attendance Check-In',
                    message: `A trainer has checked in.`,
                    type: 'Attendance',
                    link: '/dashboard/attendance' 
                });
            });
        } catch (notifyErr) {
            logAttendanceAsyncTelemetry('warn', {
                correlationId: checkInCorrelationId,
                stage: 'checkin_notification_failed',
                trainerId: attendance?.trainerId ? String(attendance.trainerId) : null,
                attendanceId: attendance?._id ? String(attendance._id) : null,
                scheduleId: scheduleId ? String(scheduleId) : null,
                status: 'checkin_notification',
                outcome: 'failed',
                reason: notifyErr.message,
                contextLabel: checkInStage,
            });
        }

        res.status(201).json({
            success: true,
            message: driveSyncQueued
                ? 'Check-in successful. Drive sync queued.'
                : 'Check-in successful',
            driveSync: {
                queued: driveSyncQueued,
                synced: false,
                error: null
            },
            data: attendance
        });
    } catch (error) {
        logAttendanceAsyncTelemetry('error', {
            correlationId: checkInCorrelationId,
            stage: 'checkin_failed',
            status: 'checkin',
            outcome: 'failed',
            reason: error?.message || 'Unknown error',
            contextLabel: checkInStage,
        });
        res.status(500).json({
            success: false,
            message: 'Failed to check in',
            error: error.message
        });
    }
};
router.post('/check-in', uploadAttendance, checkInHandler);

const uploadSingleGeoImageHandler = async (req, res) => {
    let uploadImageStage = 'initializing request';
    const uploadCorrelationId = createCorrelationId('attendance_geo_upload');

    try {
        uploadImageStage = 'reading request payload';
        const rawTrainerId = String(req.body?.trainerId || '').trim();
        const rawScheduleId = toIdString(req.body?.scheduleId);
        const assignedDateInput = normalizeAssignedDateInput(req.body?.assignedDate);
        const imageIndex = Number.parseInt(req.body?.index, 10);

        if (!req.file?.path) {
            return res.status(400).json({
                success: false,
                message: 'GeoTag image is required'
            });
        }

        if (!rawTrainerId) {
            return res.status(400).json({
                success: false,
                message: 'trainerId is required'
            });
        }

        if (!rawScheduleId && !assignedDateInput) {
            return res.status(400).json({
                success: false,
                message: 'scheduleId or assignedDate is required to resolve the training day'
            });
        }

        if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex > 2) {
            return res.status(400).json({
                success: false,
                message: 'index must be 0, 1, or 2'
            });
        }

        uploadImageStage = 'resolving trainer';
        let trainer = null;
        const trainerObjectId = toObjectIdOrNull(rawTrainerId);
        if (trainerObjectId) {
            trainer = await Trainer.findById(trainerObjectId).select('_id trainerId');
        }
        if (!trainer) {
            trainer = await Trainer.findOne({ trainerId: rawTrainerId }).select('_id trainerId');
        }

        if (!trainer) {
            return res.status(404).json({
                success: false,
                message: 'Trainer not found'
            });
        }

        uploadImageStage = 'loading assigned schedule';
        let schedule = null;
        const normalizedTrainerId = toIdString(trainer?._id);
        const scheduleObjectId = toObjectIdOrNull(rawScheduleId);

        if (rawScheduleId) {
            if (!scheduleObjectId) {
                return res.status(400).json({
                    success: false,
                    message: 'scheduleId must be a valid schedule identifier'
                });
            }

            schedule = await Schedule.findById(scheduleObjectId)
                .select('trainerId collegeId collegeLocation dayNumber status scheduledDate isActive');

            if (!schedule) {
                return res.status(404).json({
                    success: false,
                    message: 'Assigned schedule not found'
                });
            }

            if (toIdString(schedule?.trainerId) !== normalizedTrainerId) {
                return res.status(400).json({
                    success: false,
                    message: 'Selected schedule does not belong to this trainer'
                });
            }
        }

        if (!schedule) {
            const candidateSchedules = await Schedule.find({ trainerId: trainer._id })
                .select('trainerId collegeId collegeLocation dayNumber status scheduledDate isActive')
                .sort({ scheduledDate: -1 });
            schedule = candidateSchedules.find(
                (item) => toZonedDateKey(item?.scheduledDate) === assignedDateInput
            ) || null;
        }

        if (!schedule) {
            return res.status(404).json({
                success: false,
                message: 'Assigned schedule not found for this trainer and date'
            });
        }

        const uploadAccessError = validateAssignedScheduleUpload({
            schedule,
            trainerId: normalizedTrainerId,
            collegeId: schedule?.collegeId,
            dayNumber: schedule?.dayNumber,
            correlationId: uploadCorrelationId,
        });
        if (uploadAccessError) {
            return res.status(uploadAccessError.status).json({
                success: false,
                message: uploadAccessError.message,
            });
        }

        const assignedDate = toZonedDateKey(schedule?.scheduledDate) || assignedDateInput;
        if (!assignedDate) {
            return res.status(400).json({
                success: false,
                message: 'assignedDate must be a valid YYYY-MM-DD value'
            });
        }

        const resolvedCollegeLocation = await resolveScheduleCollegeLocation(schedule);

        if (!hasValidCollegeCoordinates(resolvedCollegeLocation)) {
            return res.status(400).json({
                success: false,
                message: 'College location is missing. Please ask Super Admin to save the college map location before GeoTag verification.'
            });
        }

        uploadImageStage = 'loading attendance record';
        const attendance = await Attendance.findOne({ scheduleId: schedule._id }).sort({ createdAt: -1 });
        if (!attendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found for this trainer and date'
            });
        }

        const geoUploadSessionStateError = validateCheckOutSessionState({
            attendance,
            mode: 'geo-upload',
        });
        if (geoUploadSessionStateError) {
            return res.status(geoUploadSessionStateError.status).json({
                success: false,
                message: geoUploadSessionStateError.message,
            });
        }

        if (normalizeVerificationStatus(attendance?.verificationStatus, '') !== 'approved') {
            return res.status(400).json({
                success: false,
                message: 'Check-in must be approved by SPOC before GeoTag upload is allowed.'
            });
        }

        uploadImageStage = 'extracting exif and OCR data';
        const geoData = getGeoTagData(req.file.path);
        const ocrData = await extractOcrStampData(req.file.path);
        const validation = verifyGeoTag({
            geoData,
            ocrData,
            assignedDate,
            collegeLocation: resolvedCollegeLocation,
            maxRadiusKm: CHECK_OUT_ALLOWED_GEO_RANGE_METERS / 1000,
            businessTimeZone: ATTENDANCE_BUSINESS_TIMEZONE
        });
        const verificationReport = buildVerificationReportPayload(validation);

        const exifDiagnostic = {
            hasGpsLatitude: Number.isFinite(geoData?.latitude),
            hasGpsLongitude: Number.isFinite(geoData?.longitude),
            hasCapturedAt: geoData?.capturedAt instanceof Date,
            hasGps: geoData?.hasGps === true,
            missingFields: Array.isArray(validation.missingFields) ? validation.missingFields : [],
        };

        const normalizedImageData = {
            image: path.basename(req.file.path),
            latitude: Number.isFinite(validation?.latitude) ? validation.latitude : null,
            longitude: Number.isFinite(validation?.longitude) ? validation.longitude : null,
            distance: Number.isFinite(validation?.distance) ? Number(validation.distance.toFixed(2)) : null,
            status: validation.status === 'COMPLETED' ? 'VERIFIED' : 'PENDING',
            reasonCode: validation.reasonCode || null,
        };

        const uploadedPhotoPayload = {
            url: req.file.path,
            uploadedAt: new Date(),
            validationStatus: normalizedImageData.status === 'VERIFIED' ? 'verified' : 'pending',
            validationReason: normalizedImageData.status === 'VERIFIED' ? null : (validation.reason || 'Validation pending'),
            validationCode: validation.reasonCode || null,
            latitude: normalizedImageData.latitude,
            longitude: normalizedImageData.longitude,
            capturedAt: validation?.timestamp ? new Date(validation.timestamp * 1000) : null,
            distanceKm: normalizedImageData.distance,
            validationSource: validation?.validationSource || null,
            verificationReport,
            exifDiagnostic,
        };

        uploadImageStage = 'updating attendance image slots';
        const savedAttendance = await saveUploadedGeoImageSlot({
            attendanceId: attendance._id,
            assignedDate,
            imageIndex,
            normalizedImageData,
            uploadedPhotoPayload
        });

        uploadImageStage = 'queueing uploaded geo image for Google Drive sync';
        const driveSyncQueued = queueStoredAttendanceDriveSync({
            attendanceId: savedAttendance._id,
            contextLabel: 'geo-slot-upload',
            correlationId: uploadCorrelationId,
        });

        await invalidateTrainerScheduleCaches([
            attendance?.trainerId,
            schedule?.trainerId,
            req.body?.trainerId,
        ]);

        return res.json({
            success: true,
            message: validation.reason || (normalizedImageData.status === 'VERIFIED' ? 'Image verified' : 'Image pending'),
            data: {
                ...normalizedImageData,
                reason: validation.reason,
                missingFields: exifDiagnostic.missingFields,
            },
            report: verificationReport,
            exifDiagnostic,
            images: savedAttendance.images,
            finalStatus: savedAttendance.finalStatus,
            assignedDate: savedAttendance.assignedDate || assignedDate,
            geoVerificationStatus: savedAttendance.geoVerificationStatus || null,
            geoValidationComment: savedAttendance.geoValidationComment ?? null,
            checkOutVerificationStatus: savedAttendance.checkOutVerificationStatus || null,
            checkOutVerificationMode: savedAttendance.checkOutVerificationMode || null,
            checkOutVerificationReason: savedAttendance.checkOutVerificationReason ?? null,
            checkOutCapturedAt: savedAttendance.checkOutCapturedAt || null,
            checkOutLatitude: Number.isFinite(savedAttendance.checkOutLatitude)
                ? savedAttendance.checkOutLatitude
                : null,
            checkOutLongitude: Number.isFinite(savedAttendance.checkOutLongitude)
                ? savedAttendance.checkOutLongitude
                : null,
            checkOutGeoDistanceMeters: Number.isFinite(savedAttendance.checkOutGeoDistanceMeters)
                ? savedAttendance.checkOutGeoDistanceMeters
                : null,
            driveSyncStatus: savedAttendance.driveSyncStatus || 'PENDING',
            checkOut: savedAttendance.checkOut,
            driveSync: {
                queued: driveSyncQueued,
                synced: false,
                error: null
            }
        });
    } catch (err) {
        logAttendanceAsyncTelemetry('error', {
            correlationId: uploadCorrelationId,
            stage: 'geo_upload_failed',
            status: 'geo_upload',
            outcome: 'failed',
            reason: err?.message || 'Unknown error',
            contextLabel: uploadImageStage,
        });
        if (req.file?.path && fs.existsSync(req.file.path)) {
            try {
                fs.unlinkSync(req.file.path);
            } catch (cleanupError) {
                logAttendanceAsyncTelemetry('warn', {
                    correlationId: uploadCorrelationId,
                    stage: 'geo_upload_cleanup_failed',
                    status: 'geo_upload_cleanup',
                    outcome: 'failed',
                    reason: cleanupError.message,
                    cleanupMode: 'local_file',
                    contextLabel: uploadImageStage,
                });
            }
        }
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.statusCode ? err.message : `Failed to upload image during ${uploadImageStage}`,
            error: err.message,
            stage: uploadImageStage
        });
    }
};

const uploadSingleGeoImageMiddleware = (req, res, next) => {
    uploadGeoImage(req, res, (err) => {
        if (!err) {
            next();
            return;
        }

        const isFileTooLarge = String(err?.code || '').toUpperCase() === 'LIMIT_FILE_SIZE';
        const status = isFileTooLarge ? 413 : 400;
        const message = isFileTooLarge
            ? `GeoTag image is too large. Please upload an image smaller than ${GEO_IMAGE_MAX_SIZE_MB} MB.`
            : (err?.message || 'Failed to upload GeoTag image');

        res.status(status).json({
            success: false,
            message,
            error: err?.message || null,
            code: err?.code || 'UPLOAD_ERROR',
        });
    });
};

router.post('/upload-image', uploadSingleGeoImageMiddleware, uploadSingleGeoImageHandler);

// Check Out
const checkOutHandler = async (req, res) => {
    let checkOutStage = 'initializing request';
    const checkOutCorrelationId = createCorrelationId('attendance_checkout');
    try {
        logAttendanceAsyncTelemetry('debug', {
            correlationId: checkOutCorrelationId,
            stage: 'checkout_request_received',
            status: 'checkout',
            outcome: 'started',
            contextLabel: 'request',
        });

        checkOutStage = 'reading request payload';
        const { scheduleId, trainerId, collegeId, dayNumber, checkOutTime, latitude, longitude, location } = req.body;
        let checkOutLocation = req.body.checkOutLocation;

        // Parse checkInLocation if it's a string (from FormData)
        if (typeof checkOutLocation === 'string') {
            checkOutStage = 'parsing check-out location';
            try {
                checkOutLocation = JSON.parse(checkOutLocation);
            } catch (e) {
                logAttendanceAsyncTelemetry('warn', {
                    correlationId: checkOutCorrelationId,
                    stage: 'checkout_location_parse_failed',
                    status: 'checkout',
                    outcome: 'failed',
                    reason: e.message,
                    contextLabel: checkOutStage,
                });
            }
        }

        if (!scheduleId) {
            return res.status(400).json({
                success: false,
                message: 'Schedule ID is required'
            });
        }

        checkOutStage = 'loading schedule';
        const schedule = await Schedule.findById(scheduleId).select('trainerId collegeId collegeLocation dayNumber status scheduledDate isActive');
        let currentDistanceMeters = null;
        const currentLat = req.body.lat || checkOutLocation?.lat || latitude;
        const currentLng = req.body.lng || checkOutLocation?.lng || longitude;

        const scheduleActionabilityError = validateAssignedScheduleUpload({
            schedule,
            trainerId,
            collegeId,
            dayNumber,
            correlationId: checkOutCorrelationId,
        });
        if (scheduleActionabilityError) {
            return res.status(scheduleActionabilityError.status).json({
                success: false,
                message: scheduleActionabilityError.message,
            });
        }

        if (!schedule?.scheduledDate) {
            return res.status(400).json({
                success: false,
                message: 'Assigned date is missing for this training day. Please contact admin.'
            });
        }

        const assignedDateKey = toZonedDateKey(schedule.scheduledDate);
        if (!assignedDateKey) {
            return res.status(400).json({
                success: false,
                message: 'Unable to validate the assigned date for this check-out.'
            });
        }

        const resolvedCollegeLocation = await resolveScheduleCollegeLocation(schedule);

        if (!hasValidCollegeCoordinates(resolvedCollegeLocation)) {
            return res.status(400).json({
                success: false,
                message: 'College location is missing. Please ask Super Admin to save the college map location before GeoTag verification.'
            });
        }

        if (currentLat && currentLng) {
            const trainerLoc = { latitude: parseFloat(currentLat), longitude: parseFloat(currentLng) };
            const collegeLoc = {
                latitude: resolvedCollegeLocation.lat,
                longitude: resolvedCollegeLocation.lng
            };
            currentDistanceMeters = haversine(trainerLoc, collegeLoc);

            if (!Number.isFinite(currentDistanceMeters)) {
                currentDistanceMeters = null;
            }
        }

        // LOCK: Prevent Check-Out if Day is Completed
        // if (schedule.status === 'COMPLETED' || schedule.status === 'completed') {
        //      return res.status(400).json({
        //         success: false,
        //         message: 'This training day is already marked as COMPLETED. No further edits allowed.'
        //     });
        // }

        // Find attendance record for this schedule
        checkOutStage = 'loading attendance';
        const attendance = await Attendance.findOne({ scheduleId }).sort({ createdAt: -1 });

        if (!attendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found for this schedule'
            });
        }

        const checkOutSessionStateError = validateCheckOutSessionState({
            attendance,
            mode: 'check-out',
        });
        if (checkOutSessionStateError) {
            return res.status(checkOutSessionStateError.status).json({
                success: false,
                message: checkOutSessionStateError.message,
            });
        }

        if (normalizeVerificationStatus(attendance?.verificationStatus, '') !== 'approved') {
            return res.status(400).json({
                success: false,
                message: 'Check-in must be approved by SPOC before check-out is allowed.'
            });
        }

        const uploadAccessError = validateAssignedScheduleUpload({
            schedule,
            trainerId: trainerId || attendance.trainerId,
            collegeId: collegeId || attendance.collegeId,
            dayNumber: dayNumber || attendance.dayNumber,
            correlationId: checkOutCorrelationId
        });
        if (uploadAccessError) {
            return res.status(uploadAccessError.status).json({
                success: false,
                message: uploadAccessError.message
            });
        }

        const existingCheckOut = attendance.checkOut && typeof attendance.checkOut.toObject === 'function'
            ? attendance.checkOut.toObject()
            : (attendance.checkOut || {});

        // Get file paths
        checkOutStage = 'processing uploaded geo evidence';
        const photoFiles = [...(req.files?.photo || []), ...(req.files?.checkOutGeoImage || [])].slice(0, 3);
        let photoPaths = photoFiles.map(file => file.path);
        let imageGeoValidations = [];

        if (photoPaths.length > 0 && photoPaths.length !== 3) {
            return res.status(400).json({
                success: false,
                message: 'Exactly 3 GeoTag images are required to complete check-out.'
            });
        }

        if (photoPaths.length === 0) {
            const persistedImageSlots = ensureFixedLengthSlotArray(
                Array.isArray(attendance.images) && attendance.images.length
                    ? attendance.images
                    : existingCheckOut.images,
                3,
                buildPendingCheckOutImageSlot
            );
            const legacyPersistedPhotoSlots = ensureFixedLengthSlotArray(
                Array.isArray(attendance.checkOutGeoImageUrls) && attendance.checkOutGeoImageUrls.length
                    ? attendance.checkOutGeoImageUrls.map((url) => ({ url }))
                    : (attendance.checkOutGeoImageUrl ? [{ url: attendance.checkOutGeoImageUrl }] : []),
                3,
                buildPendingCheckOutPhotoSlot
            );
            const persistedPhotoSlots = ensureFixedLengthSlotArray(
                Array.isArray(existingCheckOut.photos) && existingCheckOut.photos.length
                    ? existingCheckOut.photos
                    : legacyPersistedPhotoSlots,
                3,
                buildPendingCheckOutPhotoSlot
            ).map((item, index) => {
                const legacySlot = legacyPersistedPhotoSlots[index] || {};
                return {
                    ...legacySlot,
                    ...item,
                    url: item?.url || legacySlot?.url || null,
                };
            });
            const uploadedSlotCount = Math.max(
                persistedImageSlots.filter((item) => String(item?.image || '').trim()).length,
                persistedPhotoSlots.filter((item) => String(item?.url || '').trim()).length
            );

            if (uploadedSlotCount !== 3) {
                return res.status(400).json({
                    success: false,
                    message: `Only ${uploadedSlotCount} of 3 GeoTag images are stored for this check-out. Please upload the missing image again.`
                });
            }

            photoPaths = persistedPhotoSlots
                .map((item) => item?.url)
                .filter((value) => typeof value === 'string' && value.trim());

            imageGeoValidations = persistedImageSlots.map((item, index) => {
                const persistedPhoto = persistedPhotoSlots[index] || {};
                const normalizedStatus = String(item?.status || '').trim().toUpperCase();
                const capturedAt = persistedPhoto?.capturedAt ? new Date(persistedPhoto.capturedAt) : null;

                return {
                    imageIndex: index + 1,
                    filePath: persistedPhoto?.url || item?.image || null,
                    status: normalizedStatus === 'VERIFIED' ? 'COMPLETED' : 'PENDING',
                    reason:
                        normalizedStatus === 'VERIFIED'
                            ? 'Check-out completed'
                            : (persistedPhoto?.validationReason || 'Pending verification'),
                    distance: Number.isFinite(item?.distance) ? item.distance : (Number.isFinite(persistedPhoto?.distanceKm) ? persistedPhoto.distanceKm : null),
                    timestamp: capturedAt && !Number.isNaN(capturedAt.getTime())
                        ? Math.floor(capturedAt.getTime() / 1000)
                        : null,
                    latitude: Number.isFinite(item?.latitude) ? item.latitude : (Number.isFinite(persistedPhoto?.latitude) ? persistedPhoto.latitude : null),
                    longitude: Number.isFinite(item?.longitude) ? item.longitude : (Number.isFinite(persistedPhoto?.longitude) ? persistedPhoto.longitude : null),
                    validationSource: persistedPhoto?.validationSource || persistedPhoto?.verificationReport?.source || null,
                    report: persistedPhoto?.verificationReport || null,
                };
            });
        } else {
            imageGeoValidations = await Promise.all(photoPaths.map(async (photoPath, index) => {
                const geoData = getGeoTagData(photoPath);
                const ocrData = await extractOcrStampData(photoPath);
                const validation = verifyGeoTag({
                    geoData,
                    ocrData,
                    assignedDate: assignedDateKey,
                    collegeLocation: resolvedCollegeLocation,
                    maxRadiusKm: CHECK_OUT_ALLOWED_GEO_RANGE_METERS / 1000,
                    businessTimeZone: ATTENDANCE_BUSINESS_TIMEZONE
                });
                const verificationReport = buildVerificationReportPayload(validation);

                return {
                    imageIndex: index + 1,
                    filePath: photoPath,
                    ...validation,
                    validationSource: validation?.validationSource || verificationReport?.source || null,
                    report: verificationReport,
                };
            }));
        }
        const checkOutValidationFallbackReasons = imageGeoValidations
            .filter((item) => item.status !== 'COMPLETED')
            .map((item) => `Image ${item.imageIndex}: ${item.reason}`);
        const checkOutEvidenceItems = imageGeoValidations.map((item) =>
            toCheckOutEvidenceItem({
                status: item.status,
                reason: item.reason,
                report: item.report,
                distanceKm: Number.isFinite(item.distance) ? item.distance : null,
                latitude: Number.isFinite(item.latitude) ? item.latitude : null,
                longitude: Number.isFinite(item.longitude) ? item.longitude : null,
                capturedAt: item.timestamp ? new Date(item.timestamp * 1000) : null,
            }),
        );
        const checkOutVerificationResult = buildCheckOutVerificationResult({
            evidenceItems: checkOutEvidenceItems,
            fallbackReasons: checkOutValidationFallbackReasons,
        });
        const checkOutValidationErrors = [...checkOutValidationFallbackReasons];
        if (
            checkOutVerificationResult.reason
            && !checkOutValidationErrors.includes(checkOutVerificationResult.reason)
        ) {
            checkOutValidationErrors.push(checkOutVerificationResult.reason);
        }
        const normalizedCheckOutImages = imageGeoValidations.map((item) => ({
            image: item.filePath ? path.basename(item.filePath) : null,
            latitude: Number.isFinite(item.latitude) ? item.latitude : null,
            longitude: Number.isFinite(item.longitude) ? item.longitude : null,
            distance: Number.isFinite(item.distance) ? Number(item.distance.toFixed(2)) : null,
            status: item.status === 'COMPLETED' ? 'VERIFIED' : 'PENDING'
        }));

        // Update attendance
        checkOutStage = 'updating attendance fields';
        attendance.assignedDate = assignedDateKey;
        attendance.checkOutTime = checkOutTime || new Date().toTimeString().split(' ')[0];
        
        if (photoPaths.length > 0) {
            attendance.checkOutGeoImageUrl = photoPaths[0];
            attendance.checkOutGeoImageUrls = photoPaths;
        }


        // Handle optional activity media
        if (req.files?.activityPhotos) {
            attendance.activityPhotos = [...(attendance.activityPhotos || []), ...req.files.activityPhotos.map(f => f.path)];
        }
        if (req.files?.activityVideos) {
            attendance.activityVideos = [...(attendance.activityVideos || []), ...req.files.activityVideos.map(f => f.path)];
        }

        const checkOutAutoApproved = applyCheckOutVerificationResult({
            attendance,
            verificationResult: checkOutVerificationResult,
        });
        const firstImageWithLocation = imageGeoValidations.find(
            (item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
        );
        const parsedCurrentLat = Number.parseFloat(currentLat);
        const parsedCurrentLng = Number.parseFloat(currentLng);
        const summaryDistanceMeters = Number.isFinite(checkOutVerificationResult.distanceMeters)
            ? checkOutVerificationResult.distanceMeters
            : Number.isFinite(firstImageWithLocation?.distance)
            ? firstImageWithLocation.distance * 1000
            : Number.isFinite(currentDistanceMeters)
                ? currentDistanceMeters
                : null;

        // Structured Geo-Tag (ANTI-FAKE)
        attendance.checkOut = {
            time: new Date(),
            finalStatus: normalizeAttendanceFinalStatus(attendance.finalStatus, 'PENDING'),
            location: {
                lat: Number.isFinite(checkOutVerificationResult.latitude)
                    ? checkOutVerificationResult.latitude
                    : Number.isFinite(firstImageWithLocation?.latitude)
                    ? firstImageWithLocation.latitude
                    : (Number.isFinite(parsedCurrentLat) ? parsedCurrentLat : null),
                lng: Number.isFinite(checkOutVerificationResult.longitude)
                    ? checkOutVerificationResult.longitude
                    : Number.isFinite(firstImageWithLocation?.longitude)
                    ? firstImageWithLocation.longitude
                    : (Number.isFinite(parsedCurrentLng) ? parsedCurrentLng : null),
                accuracy: Number.isFinite(firstImageWithLocation?.latitude) && Number.isFinite(firstImageWithLocation?.longitude)
                    ? null
                    : (req.body.accuracy || checkOutLocation?.accuracy),
                address: Number.isFinite(firstImageWithLocation?.latitude) && Number.isFinite(firstImageWithLocation?.longitude)
                    ? "Geo-tag image location"
                    : (req.body.address || checkOutLocation?.address || "College Campus"),
                distanceFromCollege: summaryDistanceMeters
            },
            images: normalizedCheckOutImages,
            photos: imageGeoValidations.map((item) => ({
                url: item.filePath,
                uploadedAt: new Date(),
                validationStatus: item.status === 'COMPLETED' ? 'verified' : 'pending',
                validationReason: item.status === 'COMPLETED' ? null : item.reason,
                latitude: item.latitude,
                longitude: item.longitude,
                capturedAt: item.timestamp ? new Date(item.timestamp * 1000) : null,
                distanceKm: Number.isFinite(item.distance) ? item.distance : null,
                validationSource: item.validationSource || item.report?.source || null,
                verificationReport: item.report || null,
            }))
        };
        attendance.images = normalizedCheckOutImages;
        // Keep today's presence tied to approved check-in. Check-out validation has its own geoVerificationStatus.
        attendance.status = normalizeVerificationStatus(attendance?.verificationStatus, '') === 'approved'
            ? 'Present'
            : attendance.status;
        attendance.driveSyncStatus = 'PENDING';

        checkOutStage = 'saving attendance record';
        await attendance.save();
        checkOutStage = 'queueing persisted attendance files for Google Drive sync';
        const driveSyncQueued = queueStoredAttendanceDriveSync({
            attendanceId: attendance._id,
            contextLabel: 'check-out-finalize',
            correlationId: checkOutCorrelationId,
        });

        checkOutStage = 'updating schedule status';
        await syncScheduleLifecycleStatusFromAttendance({
            scheduleId,
            attendance
        });
        checkOutStage = 'syncing day state';
        const dayState = await syncScheduleDayState({ scheduleId, attendance });
        checkOutStage = 'emitting realtime update';
        emitAttendanceRealtimeUpdate(req, {
            type: 'DAY_STATUS_UPDATE',
            scheduleId,
            attendanceId: attendance._id,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Day status updated to ${dayState?.dayStatus || 'pending'}`
        });

        await invalidateTrainerScheduleCaches([
            attendance?.trainerId,
            schedule?.trainerId,
            trainerId,
        ]);

        // Notify Admins
        try {
            const superAdmins = await User.find({ role: 'SuperAdmin' });
            const io = req.app.get('io');
            superAdmins.forEach(admin => {
                sendNotification(io, {
                    userId: admin._id,
                    role: admin.role,
                    title: 'New Attendance Check-Out',
                    message: `A trainer has checked out.`,
                    type: 'Attendance',
                    link: '/dashboard/attendance' 
                });
            });
        } catch (notifyErr) {
            logAttendanceAsyncTelemetry('warn', {
                correlationId: checkOutCorrelationId,
                stage: 'checkout_notification_failed',
                trainerId: attendance?.trainerId ? String(attendance.trainerId) : null,
                attendanceId: attendance?._id ? String(attendance._id) : null,
                scheduleId: attendance?.scheduleId ? String(attendance.scheduleId) : null,
                status: 'checkout_notification',
                outcome: 'failed',
                reason: notifyErr.message,
                contextLabel: checkOutStage,
            });
        }

        res.json({
            success: true,
            message: `${checkOutAutoApproved ? 'Check-out auto-verified' : 'Check-out saved'}${driveSyncQueued ? '. Drive sync queued.' : '.'} Verification status: ${attendance.checkOutVerificationStatus || 'PENDING_CHECKOUT'}`,
            driveSync: {
                queued: driveSyncQueued,
                synced: false,
                error: null
            },
            autoValidation: {
                status: checkOutAutoApproved
                    ? 'completed'
                    : String(attendance.checkOutVerificationStatus || 'PENDING_CHECKOUT').toLowerCase(),
                reasons: checkOutValidationErrors,
                verifiedImages: imageGeoValidations.filter((item) => item.status === 'COMPLETED').length,
                totalImages: imageGeoValidations.length,
                imageGeoTags: imageGeoValidations.map((item) => ({
                    imageIndex: item.imageIndex,
                    status: item.status === 'COMPLETED' ? 'verified' : 'pending',
                    reason: item.reason || null,
                    timestamp: item.timestamp ?? null,
                    latitude: item.latitude,
                    longitude: item.longitude,
                    distance: item.distance,
                    validationSource: item.validationSource || item.report?.source || null,
                    report: item.report || null,
                }))
            },
            checkoutRecord: {
                trainerId: attendance.trainerId,
                assignedDate: attendance.assignedDate,
                images: attendance.images,
                finalStatus: attendance.finalStatus,
                checkOutVerificationStatus: attendance.checkOutVerificationStatus || null,
                checkOutVerificationMode: attendance.checkOutVerificationMode || null,
                checkOutVerificationReason: attendance.checkOutVerificationReason ?? null,
                checkOutCapturedAt: attendance.checkOutCapturedAt || null,
                checkOutLatitude: Number.isFinite(attendance.checkOutLatitude)
                    ? attendance.checkOutLatitude
                    : null,
                checkOutLongitude: Number.isFinite(attendance.checkOutLongitude)
                    ? attendance.checkOutLongitude
                    : null,
                checkOutGeoDistanceMeters: Number.isFinite(attendance.checkOutGeoDistanceMeters)
                    ? attendance.checkOutGeoDistanceMeters
                    : null,
                driveSyncStatus: attendance.driveSyncStatus || 'PENDING',
            },
            data: attendance
        });
    } catch (error) {
        logAttendanceAsyncTelemetry('error', {
            correlationId: checkOutCorrelationId,
            stage: 'checkout_failed',
            status: 'checkout',
            outcome: 'failed',
            reason: error?.message || 'Unknown error',
            contextLabel: checkOutStage,
        });
        res.status(500).json({
            success: false,
            message: `Failed to check out during ${checkOutStage}`,
            error: error.message,
            stage: checkOutStage
        });
    }
};
router.post('/check-out', uploadAttendance, checkOutHandler);

// Get attendance by schedule ID
router.get('/schedule/:scheduleId', getAttendanceScheduleController);

// Get attendance by trainer ID
router.get('/trainer/:trainerId', getAttendanceTrainerController);

// Get all attendance records (for SPOC Admin verification page)
router.get('/', async (req, res) => {
    try {
        const requestedView = String(req.query.view || '').trim().toLowerCase();
        const page = parsePositiveInteger(req.query.page, 1);
        const limit = Math.min(
            parsePositiveInteger(req.query.limit, DEFAULT_ATTENDANCE_PAGE_LIMIT),
            MAX_ATTENDANCE_PAGE_LIMIT
        );
        const shouldPaginate = shouldPaginateAttendance(req.query);
        const verificationStatus = String(req.query.verificationStatus || '').trim().toLowerCase();
        const geoVerificationStatus = String(req.query.geoVerificationStatus || '').trim().toLowerCase();
        const checkOutVerificationStatus = String(req.query.checkOutVerificationStatus || '').trim();
        const search = String(req.query.search || '').trim();
        const startDate = parseAttendanceDateBoundary(req.query.startDate, 'start');
        const endDate = parseAttendanceDateBoundary(req.query.endDate, 'end');
        const filters = {};

        if (requestedView === 'geo-verification') {
            filters.checkOutTime = { $exists: true, $ne: null };
        }

        if (['pending', 'approved', 'rejected'].includes(verificationStatus)) {
            filters.verificationStatus = verificationStatus;
        }

        if (['pending', 'approved', 'rejected'].includes(geoVerificationStatus)) {
            filters.geoVerificationStatus = geoVerificationStatus;
        }

        if (checkOutVerificationStatus) {
            const normalizedCheckOutStatus = normalizeCheckOutVerificationStatus(
                checkOutVerificationStatus,
                null,
            );

            if (normalizedCheckOutStatus === 'AUTO_VERIFIED') {
                filters.checkOutVerificationStatus = 'AUTO_VERIFIED';
            } else if (normalizedCheckOutStatus === 'MANUAL_REVIEW_REQUIRED') {
                filters.checkOutVerificationStatus = 'MANUAL_REVIEW_REQUIRED';
            } else if (normalizedCheckOutStatus === 'REJECTED') {
                filters.checkOutVerificationStatus = 'REJECTED';
            } else if (
                normalizedCheckOutStatus === 'PENDING_CHECKOUT'
                || ['pending', 'in_progress', 'under_review'].includes(
                    String(checkOutVerificationStatus).trim().toLowerCase().replace(/[\s-]+/g, '_'),
                )
            ) {
                filters.checkOutVerificationStatus = {
                    $in: ['PENDING_CHECKOUT', 'MANUAL_REVIEW_REQUIRED'],
                };
            }
        }

        if (req.query.startDate && !startDate) {
            return res.status(400).json({
                success: false,
                message: 'Invalid startDate. Use a valid date or YYYY-MM-DD format.'
            });
        }

        if (req.query.endDate && !endDate) {
            return res.status(400).json({
                success: false,
                message: 'Invalid endDate. Use a valid date or YYYY-MM-DD format.'
            });
        }

        if (startDate || endDate) {
            filters.date = {};
            if (startDate) {
                filters.date.$gte = startDate;
            }
            if (endDate) {
                filters.date.$lte = endDate;
            }
        }

        const searchFilters = await buildAttendanceSearchFilters(search);
        if (searchFilters.length > 0) {
            filters.$or = searchFilters;
        } else if (search) {
            return res.json({
                success: true,
                data: [],
                pagination: {
                    page,
                    limit,
                    total: 0,
                    totalPages: 0,
                    hasNextPage: false,
                    hasPrevPage: page > 1,
                }
            });
        }

        if (requestedView === 'geo-verification') {
            const attendanceQuery = Attendance.find(filters)
                .select([
                    'trainerId',
                    'collegeId',
                    'courseId',
                    'scheduleId',
                    'dayNumber',
                    'assignedDate',
                    'date',
                    'geoVerificationStatus',
                    'geoValidationComment',
                    'checkOutVerificationStatus',
                    'checkOutVerificationMode',
                    'checkOutVerificationReason',
                    'checkOutCapturedAt',
                    'checkOutLatitude',
                    'checkOutLongitude',
                    'checkOutGeoDistanceMeters',
                    'checkOutVerifiedAt',
                    'driveSyncStatus',
                    'checkOutTime',
                    ...ATTENDANCE_LIST_CHECK_OUT_SELECT_FIELDS,
                    'checkOutGeoImageUrl',
                    'checkOutGeoImageUrls',
                    'activityPhotos',
                    'activityVideos',
                    'latitude',
                    'longitude',
                    'createdAt',
                    'status'
                ].join(' '))
                .populate({
                    path: 'trainerId',
                    select: 'name trainerId userId',
                    populate: { path: 'userId', select: 'name email' }
                })
                .populate({
                    path: 'collegeId',
                    select: 'name latitude longitude companyId',
                    populate: { path: 'companyId', select: 'name' }
                })
                .populate({
                    path: 'courseId',
                    select: 'name title'
                })
                .populate({
                    path: 'scheduleId',
                    select: 'subject dayNumber courseId',
                    populate: { path: 'courseId', select: 'name title' }
                })
                .sort({ date: -1, createdAt: -1 })
                .lean();

            let totalPromise = Promise.resolve(null);
            if (shouldPaginate) {
                attendanceQuery.skip((page - 1) * limit).limit(limit);
                totalPromise = Attendance.countDocuments(filters);
            }

            const [attendance, total] = await Promise.all([
                attendanceQuery,
                totalPromise,
            ]);

            const responsePayload = {
                success: true,
                data: attendance
            };

            if (shouldPaginate) {
                const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
                responsePayload.pagination = {
                    page,
                    limit,
                    total,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1,
                };
            }

            return res.json(responsePayload);
        }

        const attendanceQuery = Attendance.find(filters)
            .select([
                '_id',
                'trainerId',
                'collegeId',
                'scheduleId',
                'dayNumber',
                'assignedDate',
                'date',
                'checkIn',
                'checkInTime',
                'checkOutTime',
                'studentsPresent',
                'studentsAbsent',
                'verificationStatus',
                'geoVerificationStatus',
                'geoValidationComment',
                'checkOutVerificationStatus',
                'checkOutVerificationMode',
                'checkOutVerificationReason',
                'checkOutCapturedAt',
                'checkOutLatitude',
                'checkOutLongitude',
                'checkOutGeoDistanceMeters',
                'driveSyncStatus',
                ...ATTENDANCE_LIST_CHECK_OUT_SELECT_FIELDS,
                'checkOutGeoImageUrl',
                'checkOutGeoImageUrls',
                'attendancePdfUrl',
                'createdAt',
                'status'
            ].join(' '))
            .populate({
                path: 'trainerId',
                select: 'name trainerId userId',
                populate: { path: 'userId', select: 'name email' }
            })
            .populate({
                path: 'collegeId',
                select: 'name latitude longitude companyId',
                populate: { path: 'companyId', select: 'name' }
            })
            .populate({
                path: 'scheduleId',
                select: 'dayNumber subject courseId',
                populate: { path: 'courseId', select: 'name title' }
            })
            .sort({ createdAt: -1 })
            .lean();

        let totalPromise = Promise.resolve(null);
        if (shouldPaginate) {
            attendanceQuery.skip((page - 1) * limit).limit(limit);
            totalPromise = Attendance.countDocuments(filters);
        }

        const [attendance, total] = await Promise.all([
            attendanceQuery,
            totalPromise,
        ]);

        const responsePayload = {
            success: true,
            data: attendance
        };

        if (shouldPaginate) {
            const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
            responsePayload.pagination = {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            };
        }

        res.json(responsePayload);
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// Get attendance details by ID (for detail modal)
router.get('/:id/details', getAttendanceLegacyDetailsController);

// Get pending attendance for verification
router.get('/pending', async (req, res) => {
    try {
        const attendance = await Attendance.find({ verificationStatus: 'pending' })
            .populate({
                path: 'trainerId',
                populate: { path: 'userId', select: 'name email' }
            })
            .populate('collegeId', 'name latitude longitude company')
            .populate({
                path: 'scheduleId',
                populate: { path: 'courseId' } // Changed from 'course' to 'courseId' if that's the field name
            })
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching pending attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch pending attendance',
            error: error.message
        });
    }
});

// Get uploaded drive documents tracked per schedule/day
router.get('/documents', getAttendanceDocumentsController);

// SPOC verifies uploaded document
const verifyAttendanceDocumentAdapter = createVerifyAttendanceDocumentController({
    syncScheduleDayStateHelper: syncScheduleDayState,
    emitRealtimeUpdateHelper: emitAttendanceRealtimeUpdate
});
router.post('/verify-document', verifyAttendanceDocumentAdapter);

// SPOC rejects uploaded document
const rejectAttendanceDocumentAdapter = createRejectAttendanceDocumentController({
    syncScheduleDayStateHelper: syncScheduleDayState,
    emitRealtimeUpdateHelper: emitAttendanceRealtimeUpdate
});
router.post('/reject-document', rejectAttendanceDocumentAdapter);

const markManualAttendanceAdapter = createMarkManualAttendanceController({
    syncScheduleDayStateHelper: syncScheduleDayState,
    emitRealtimeUpdateHelper: emitAttendanceRealtimeUpdate
});
router.post('/manual', uploadManual, markManualAttendanceAdapter);

// Daily attendance entry for HR (no college required)
router.post('/trainer-daily', async (req, res) => {
    try {
        const { trainerId, date, status, remarks } = req.body;

        if (!trainerId || !date || !status) {
            return res.status(400).json({
                success: false,
                message: 'Trainer ID, Date, and Status are required'
            });
        }

        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        let attendance = await Attendance.findOne({
            trainerId,
            date: { $gte: startOfDay, $lte: endOfDay },
            collegeId: null
        });

        if (attendance) {
            attendance.status = status;
            attendance.remarks = remarks;
            attendance.verifiedAt = new Date();
            await attendance.save();
        } else {
            attendance = await Attendance.create({
                trainerId,
                date: new Date(date),
                status,
                remarks,
                uploadedBy: 'admin',
                isManualEntry: true,
                verificationStatus: 'approved',
                verifiedAt: new Date(),
                collegeId: null
            });
        }

        res.json({
            success: true,
            message: 'Attendance marked successfully',
            data: attendance
        });
    } catch (error) {
        console.error('Error marking daily attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark attendance',
            error: error.message
        });
    }
});

// Get attendance by college
router.get('/college/:collegeId', getAttendanceCollegeController);

// Admin uploads/updates attendance (PDF, Image, GeoTag)
router.post('/admin-upload', uploadAttendance, async (req, res) => {
    let adminUploadStage = 'initializing request';
    const adminUploadCorrelationId = createCorrelationId('attendance_admin_upload');
    try {
        adminUploadStage = 'reading request payload';
        const { scheduleId, trainerId, collegeId, latitude, longitude, date } = req.body;
        const requestedVerificationStatus = normalizeVerificationStatus(
            req.body.verificationStatus,
            null
        );
        const requestedGeoVerificationStatus = normalizeVerificationStatus(
            req.body.geoVerificationStatus,
            null
        );



        if (!scheduleId) {
            return res.status(400).json({ success: false, message: 'Schedule ID is required' });
        }
        adminUploadStage = 'loading schedule';
        const schedule = await Schedule.findById(scheduleId).select('dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink departmentId dayNumber');
        if (!schedule) {
            return res.status(404).json({ success: false, message: 'Schedule not found' });
        }

        adminUploadStage = 'loading attendance';
        let attendance = await Attendance.findOne({ scheduleId }).sort({ createdAt: -1 });

        const attendancePdfUrl = req.files?.attendancePdf ? req.files.attendancePdf[0].path : undefined;
        const attendanceExcelUrl = req.files?.attendanceExcel ? req.files.attendanceExcel[0].path : undefined;
        const studentsPhotoUrl = req.files?.studentsPhoto ? req.files.studentsPhoto[0].path : undefined;

        let checkOutGeoImageUrls = undefined;
        let checkOutGeoImageUrl = undefined;
        if (req.files?.checkOutGeoImage) {
            checkOutGeoImageUrls = req.files.checkOutGeoImage.map(file => file.path);
            checkOutGeoImageUrl = checkOutGeoImageUrls[0];
        }

        if (attendance) {
            adminUploadStage = 'updating attendance';
            // Update existing
            if (attendancePdfUrl) attendance.attendancePdfUrl = attendancePdfUrl;
            if (attendanceExcelUrl) attendance.attendanceExcelUrl = attendanceExcelUrl;
            if (studentsPhotoUrl) attendance.studentsPhotoUrl = studentsPhotoUrl;
            if (checkOutGeoImageUrls) {
                attendance.checkOutGeoImageUrls = checkOutGeoImageUrls;
                attendance.checkOutGeoImageUrl = checkOutGeoImageUrl;
                // Reset verification status if new images are uploaded
                attendance.geoVerificationStatus = normalizeVerificationStatus('pending');
                attendance.checkOutVerificationStatus = normalizeCheckOutVerificationStatus('manual_review_required');
                attendance.checkOutVerificationMode = 'MANUAL';
                attendance.checkOutVerificationReason = 'Uploaded by admin. Manual verification required.';
                attendance.checkOutVerifiedAt = null;
                attendance.checkOutVerifiedBy = null;
            }
            if (latitude) attendance.latitude = latitude;
            if (longitude) attendance.longitude = longitude;

            // Update statuses if provided
            if (requestedVerificationStatus) {
                attendance.verificationStatus = requestedVerificationStatus;
            }
            if (requestedGeoVerificationStatus) {
                attendance.geoVerificationStatus = requestedGeoVerificationStatus;
                attendance.checkOutVerificationMode = 'MANUAL';
                attendance.checkOutVerificationStatus =
                    requestedGeoVerificationStatus === 'approved'
                        ? normalizeCheckOutVerificationStatus('auto_verified')
                        : requestedGeoVerificationStatus === 'rejected'
                            ? normalizeCheckOutVerificationStatus('rejected')
                            : normalizeCheckOutVerificationStatus('manual_review_required');
                attendance.checkOutVerificationReason =
                    requestedGeoVerificationStatus === 'approved'
                        ? null
                        : requestedGeoVerificationStatus === 'rejected'
                            ? 'Manually rejected by admin'
                            : 'Manual review pending';
                attendance.checkOutVerifiedAt = requestedGeoVerificationStatus === 'approved'
                    ? new Date()
                    : null;
                attendance.checkOutVerifiedBy = req.user?.id || null;
                // Sync main status with Geo Tag status
                if (requestedGeoVerificationStatus === 'approved') {
                    attendance.status = normalizeAttendancePresenceStatus('present');
                } else if (requestedGeoVerificationStatus === 'rejected') {
                    attendance.status = normalizeAttendancePresenceStatus('absent');
                }
            }
            
            if (req.body.syllabus) attendance.syllabus = req.body.syllabus;
            attendance.driveSyncStatus = 'PENDING';

        } else {
            adminUploadStage = 'creating attendance';
            // Create new
            if (!trainerId || !collegeId) {
                return res.status(400).json({ success: false, message: 'Trainer ID and College ID are required for new attendance' });
            }

            attendance = new Attendance({
                scheduleId,
                trainerId,
                collegeId,
                date: date ? new Date(date) : new Date(),
                attendancePdfUrl,
                attendanceExcelUrl,
                studentsPhotoUrl,
                latitude,
                longitude,
                checkOutGeoImageUrl,
                checkOutGeoImageUrls,
                verificationStatus: requestedVerificationStatus || normalizeVerificationStatus('pending'),
                geoVerificationStatus: requestedGeoVerificationStatus || normalizeVerificationStatus('pending'),
                checkOutVerificationStatus:
                    (requestedGeoVerificationStatus || 'pending') === 'approved'
                        ? normalizeCheckOutVerificationStatus('auto_verified')
                        : (requestedGeoVerificationStatus || 'pending') === 'rejected'
                            ? normalizeCheckOutVerificationStatus('rejected')
                            : normalizeCheckOutVerificationStatus(
                                checkOutGeoImageUrls?.length ? 'manual_review_required' : 'pending_checkout'
                            ),
                checkOutVerificationMode: requestedGeoVerificationStatus ? 'MANUAL' : 'AUTO',
                checkOutVerificationReason:
                    (requestedGeoVerificationStatus || 'pending') === 'approved'
                        ? null
                        : (requestedGeoVerificationStatus || 'pending') === 'rejected'
                            ? 'Manually rejected by admin'
                            : checkOutGeoImageUrls?.length
                                ? 'Uploaded by admin. Manual verification required.'
                                : null,
                checkOutVerifiedAt: (requestedGeoVerificationStatus || 'pending') === 'approved'
                    ? new Date()
                    : null,
                checkOutVerifiedBy: req.user?.id || null,
                status: normalizeAttendancePresenceStatus(
                    (requestedGeoVerificationStatus || 'pending') === 'approved'
                        ? 'present'
                        : (requestedGeoVerificationStatus || 'pending') === 'rejected'
                            ? 'absent'
                            : 'pending'
                ),
                verifiedBy: req.user ? req.user.id : undefined,
                verifiedAt: (
                    (requestedVerificationStatus || 'pending') === 'approved'
                    || (requestedGeoVerificationStatus || 'pending') === 'approved'
                ) ? new Date() : undefined,
                uploadedBy: 'admin',
                driveSyncStatus: 'PENDING',
            });

        }

        await attendance.save();
        adminUploadStage = 'queueing drive sync';
        const driveSyncQueued = queueStoredAttendanceDriveSync({
            attendanceId: attendance._id,
            contextLabel: 'admin-upload',
            correlationId: adminUploadCorrelationId,
        });
        adminUploadStage = 'syncing day state';
        const dayState = await syncScheduleDayState({ scheduleId, attendance });
        emitAttendanceRealtimeUpdate(req, {
            type: 'DAY_STATUS_UPDATE',
            scheduleId,
            attendanceId: attendance._id,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Day status updated to ${dayState?.dayStatus || 'pending'}`
        });

        await invalidateTrainerScheduleCaches([
            attendance?.trainerId,
            trainerId,
        ]);

        res.json({
            success: true,
            message: driveSyncQueued
                ? 'Attendance uploaded successfully. Drive sync queued.'
                : 'Attendance uploaded successfully',
            driveSync: {
                queued: driveSyncQueued,
                synced: false,
                error: null
            },
            data: attendance
        });

    } catch (error) {
        logAttendanceAsyncTelemetry('error', {
            correlationId: adminUploadCorrelationId,
            stage: 'admin_upload_failed',
            status: 'admin_upload',
            outcome: 'failed',
            reason: error?.message || 'Unknown error',
            contextLabel: adminUploadStage,
        });
        res.status(500).json({ success: false, message: 'Failed to upload attendance', error: error.message });
    }
});

// SPOC Admin verifies attendance (Approve/Reject)
router.put('/:id/verify', async (req, res) => {
    let verifyStage = 'initializing request';
    const verifyCorrelationId = createCorrelationId('attendance_verify_checkin');
    try {
        verifyStage = 'reading request payload';
        const { status: requestedStatus, comment } = req.body;
        const attendanceId = req.params.id;
        const status = normalizeVerificationStatus(requestedStatus, null);

        // Validate status
        if (!status || !['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be "approved", "rejected", or "pending". Received: "${requestedStatus}"`,
            });
        }

        // Use findByIdAndUpdate to update directly
        const updateData = {
            verificationStatus: status,
            verificationComment: comment || '',
            approvedBy: req.body.approvedBy || null,
            verifiedAt: new Date()
        };

        // If Check-In is rejected, automatically reject Check-Out too
        if (status === 'rejected') {
            updateData.geoVerificationStatus = 'rejected';
            updateData.geoValidationComment = null;
            updateData.status = 'Absent';
            updateData.checkOutTime = null;
            updateData.checkOutGeoImageUrl = null;
            updateData.checkOutGeoImageUrls = [];
            updateData.activityPhotos = [];
            updateData.activityVideos = [];
            updateData.images = [];
            updateData.finalStatus = 'PENDING';
            updateData.checkOutCapturedAt = null;
            updateData.checkOutLatitude = null;
            updateData.checkOutLongitude = null;
            updateData.checkOutGeoDistanceMeters = null;
            updateData.checkOutVerificationStatus = normalizeCheckOutVerificationStatus('pending_checkout');
            updateData.checkOutVerificationMode = 'AUTO';
            updateData.checkOutVerificationReason = null;
            updateData.checkOutVerifiedAt = null;
            updateData.checkOutVerifiedBy = null;
            updateData.driveSyncStatus = 'PENDING';
            updateData.checkOut = {
                time: null,
                finalStatus: 'PENDING',
                location: {
                    lat: null,
                    lng: null,
                    accuracy: null,
                    address: null,
                    distanceFromCollege: null
                },
                images: [],
                photos: []
            };
            updateData.completedAt = null;
        }

        // If Check-In is approved, mark as Present
        if (status === 'approved') {
            updateData.status = 'Present';
        }

        const attendance = await Attendance.findByIdAndUpdate(
            attendanceId,
            updateData,
            { new: true, runValidators: true }
        );

        if (!attendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found'
            });
        }

        // Ensure verified check-in/check-out documents are synced to Drive hierarchy.
        verifyStage = 'syncing drive evidence';
        await syncStoredAttendanceFilesToDrive(attendance, `verify-check-in-${status}`, {
            correlationId: verifyCorrelationId,
            attempt: 1,
        });
        verifyStage = 'updating schedule documents verification';
        await updateScheduleDocumentsVerificationStatus({
            attendance,
            fileType: 'attendance',
            verificationStatus: status,
            verifiedBy: req.body.approvedBy || req.user?.id || null,
            rejectReason: status === 'rejected' ? comment : null
        });
        if (status === 'rejected') {
            await updateScheduleDocumentsVerificationStatus({
                attendance,
                fileType: 'geotag',
                verificationStatus: 'rejected',
                verifiedBy: req.body.approvedBy || req.user?.id || null,
                rejectReason: comment || 'Check-in rejected'
            });
        }

        // Notify Trainer on rejection
        if (status === 'rejected') {
            verifyStage = 'dispatching rejection notifications';
            try {
                const populatedAttendance = await Attendance.findById(attendanceId)
                    .populate({
                        path: 'trainerId',
                        populate: { path: 'userId' }
                    })
                    .populate('collegeId');

                if (populatedAttendance && populatedAttendance.trainerId?.userId) {
                    await Notification.create({
                        userId: populatedAttendance.trainerId.userId._id,
                        title: 'Attendance Rejected',
                        message: `Your Check-In for Day ${populatedAttendance.dayNumber || 'N/A'} at ${populatedAttendance.collegeId?.name || 'College'} was rejected. Reason: ${comment || 'No reason provided'}`,
                        type: 'error',
                        link: '/trainer/schedule'
                    });
                }
            } catch (notifyError) {
                logAttendanceAsyncTelemetry('warn', {
                    correlationId: verifyCorrelationId,
                    stage: 'verify_checkin_rejection_notification_failed',
                    trainerId: attendance?.trainerId ? String(attendance.trainerId) : null,
                    attendanceId: attendance?._id ? String(attendance._id) : null,
                    scheduleId: attendance?.scheduleId ? String(attendance.scheduleId) : null,
                    status: 'verification_notification',
                    outcome: 'failed',
                    reason: notifyError.message,
                    contextLabel: verifyStage,
                });
            }
        }

        if (status === 'approved') {
            verifyStage = 'dispatching approval notifications';
            try {
                const populatedAttendance = await Attendance.findById(attendanceId)
                    .populate({
                        path: 'trainerId',
                        populate: { path: 'userId', select: 'name' }
                    })
                    .populate('collegeId', 'name');

                const trainerName = populatedAttendance?.trainerId?.userId?.name || 'Trainer';
                const collegeName = populatedAttendance?.collegeId?.name || 'College';
                const io = req.app.get('io');
                const superAdmins = await User.find({ role: 'SuperAdmin' }).select('_id role');

                superAdmins.forEach((admin) => {
                    sendNotification(io, {
                        userId: admin._id,
                        role: admin.role,
                        title: 'Trainer Marked Present',
                        message: `${trainerName} was approved for today at ${collegeName}.`,
                        type: 'Attendance',
                        link: '/dashboard/trainer-activity'
                    });
                });
            } catch (notifyError) {
                logAttendanceAsyncTelemetry('warn', {
                    correlationId: verifyCorrelationId,
                    stage: 'verify_checkin_approval_notification_failed',
                    trainerId: attendance?.trainerId ? String(attendance.trainerId) : null,
                    attendanceId: attendance?._id ? String(attendance._id) : null,
                    scheduleId: attendance?.scheduleId ? String(attendance.scheduleId) : null,
                    status: 'verification_notification',
                    outcome: 'failed',
                    reason: notifyError.message,
                    contextLabel: verifyStage,
                });
            }
        }

        if (attendance.scheduleId) {
            verifyStage = 'syncing schedule lifecycle status';
            await syncScheduleLifecycleStatusFromAttendance({
                scheduleId: attendance.scheduleId,
                attendance
            });
        }

        // If approved and both document streams are verified, notify Trainer of completion
        if (status === 'approved'
            && attendance.scheduleId
            && normalizeVerificationStatus(attendance?.geoVerificationStatus, '') === 'approved') {
            verifyStage = 'dispatching completion notifications';
            try {
                // Send Bell Notification to Trainer
                const populatedAttendance = await Attendance.findById(attendanceId)
                    .populate({
                        path: 'trainerId',
                        populate: { path: 'userId' }
                    })
                    .populate('collegeId')
                    .populate('scheduleId');

                if (populatedAttendance && populatedAttendance.trainerId?.userId) {
                    const courseName = populatedAttendance.scheduleId?.courseId?.name || 'Training';
                    await Notification.create({
                        userId: populatedAttendance.trainerId.userId._id,
                        title: '✅ Attendance Verified',
                        message: `Your attendance for Day ${populatedAttendance.dayNumber} at ${populatedAttendance.collegeId?.name || 'College'} has been approved.`,
                        type: 'success',
                        link: '/trainer/schedule'
                    });
                }
            } catch (syncError) {
                logAttendanceAsyncTelemetry('warn', {
                    correlationId: verifyCorrelationId,
                    stage: 'verify_checkin_completion_notification_failed',
                    trainerId: attendance?.trainerId ? String(attendance.trainerId) : null,
                    attendanceId: attendance?._id ? String(attendance._id) : null,
                    scheduleId: attendance?.scheduleId ? String(attendance.scheduleId) : null,
                    status: 'verification_notification',
                    outcome: 'failed',
                    reason: syncError.message,
                    contextLabel: verifyStage,
                });
            }
        }

        const dayState = attendance.scheduleId
            ? await syncScheduleDayState({ scheduleId: attendance.scheduleId, attendance })
            : null;

        // Notify via socket
        emitAttendanceRealtimeUpdate(req, {
            type: 'VERIFICATION_UPDATE',
            attendanceId: attendance._id,
            scheduleId: attendance.scheduleId || null,
            status: attendance.verificationStatus,
            dayStatus: dayState?.dayStatus || null,
            attendanceUploaded: dayState?.attendanceUploaded ?? null,
            geoTagUploaded: dayState?.geoTagUploaded ?? null,
            message: `Attendance verification status updated to ${attendance.verificationStatus}`
        });

        await invalidateTrainerScheduleCaches([attendance?.trainerId]);

        const allocatedDrivePath = await buildAllocatedDrivePathForSchedule(attendance.scheduleId);

        res.json({
            success: true,
            message: 'Attendance verification status updated',
            data: attendance,
            driveSync: {
                synced: !attendance?.driveAssets?.lastSyncError,
                error: attendance?.driveAssets?.lastSyncError || null
            },
            allocatedDrivePath
        });
    } catch (error) {
        logAttendanceAsyncTelemetry('error', {
            correlationId: verifyCorrelationId,
            stage: 'verify_checkin_failed',
            status: 'verification',
            outcome: 'failed',
            reason: error?.message || 'Unknown error',
            contextLabel: verifyStage,
        });
        res.status(500).json({
            success: false,
            message: 'Failed to verify attendance',
            error: error.message
        });
    }
});

// Verify Geo Tag (SPOC Admin)
router.post('/verify-geo', async (req, res) => {
    try {
        // Adapt legacy body if needed, though modular controller handles standard payload
        req.body.attendanceId = req.body.attendanceId || req.body.id;
        return await verifyGeoTagController(req, res);
    } catch (err) {
        logAttendanceAsyncTelemetry('error', {
            correlationId: createCorrelationId('attendance_verify_geo_adapter'),
            stage: 'legacy_verify_geo_adapter_failed',
            status: 'geo_verification_adapter',
            outcome: 'failed',
            reason: err?.message || 'Unknown error',
            contextLabel: 'verify_geo_adapter',
        });
        return res.status(500).json({ success: false, message: 'Failed to verify geo tag' });
    }
});

// Reject Geo Tag (SPOC Admin)
router.post('/reject-geo', async (req, res) => {
    try {
        req.body.attendanceId = req.body.attendanceId || req.body.id;
        return await rejectGeoTagController(req, res);
    } catch (err) {
        logAttendanceAsyncTelemetry('error', {
            correlationId: createCorrelationId('attendance_reject_geo_adapter'),
            stage: 'legacy_reject_geo_adapter_failed',
            status: 'geo_verification_adapter',
            outcome: 'failed',
            reason: err?.message || 'Unknown error',
            contextLabel: 'reject_geo_adapter',
        });
        return res.status(500).json({ success: false, message: 'Failed to reject geo tag' });
    }
});

const runCanonicalAttendanceAdapterStep = async ({ handler, req, body }) => {
    const originalBody = req.body;
    const capture = {
        statusCode: 200,
        payload: null,
    };

    const adapterResponse = {
        status(code) {
            capture.statusCode = code;
            return this;
        },
        json(payload) {
            capture.payload = payload;
            return payload;
        },
        set() {
            return this;
        },
        get() {
            return undefined;
        },
    };

    try {
        req.body = body;
        await handler(req, adapterResponse);
    } finally {
        req.body = originalBody;
    }

    if (!capture.payload) {
        capture.statusCode = capture.statusCode >= 400 ? capture.statusCode : 500;
        capture.payload = {
            success: false,
            message: 'Canonical attendance flow returned no payload.',
        };
    }

    return capture;
};

const buildLegacySubmitCheckInBody = (legacyBody = {}) => {
    const checkInLocation = legacyBody.checkInLocation ?? legacyBody.location ?? null;
    return {
        ...legacyBody,
        checkInLocation,
        checkInTime:
            legacyBody.checkInTime
            || legacyBody.locationCapturedAt
            || legacyBody.checkOutTime
            || undefined,
    };
};

const buildLegacySubmitCheckOutBody = (legacyBody = {}) => {
    const checkOutLocation =
        legacyBody.checkOutLocation
        ?? legacyBody.location
        ?? legacyBody.checkInLocation
        ?? null;

    return {
        ...legacyBody,
        checkOutLocation,
        checkOutTime:
            legacyBody.checkOutTime
            || legacyBody.locationCapturedAt
            || legacyBody.checkInTime
            || undefined,
    };
};

const hasLegacySubmitGeoEvidence = (files = {}) => {
    const photoCount = [
        ...(files?.photo || []),
        ...(files?.checkOutGeoImage || []),
    ].length;

    return photoCount === 3;
};

// Legacy adapter endpoint.
// Canonical production flow is:
// 1) /attendance/check-in
// 2) /attendance/check-out
// 3) /attendance/:id/verify
router.post('/submit', uploadAttendance, async (req, res) => {
    try {
        res.set('X-MBK-Legacy-Endpoint', '/attendance/submit');
        res.set('X-MBK-Canonical-Flow', '/attendance/check-in,/attendance/check-out,/attendance/:id/verify');

        const legacyPayload = { ...(req.body || {}) };
        const checkInResult = await runCanonicalAttendanceAdapterStep({
            handler: checkInHandler,
            req,
            body: buildLegacySubmitCheckInBody(legacyPayload),
        });

        if (checkInResult.statusCode >= 400 || !checkInResult.payload?.success) {
            return res.status(checkInResult.statusCode).json(checkInResult.payload);
        }

        if (!hasLegacySubmitGeoEvidence(req.files)) {
            return res.status(200).json({
                ...checkInResult.payload,
                message: 'Legacy submit adapter completed canonical check-in. Complete canonical check-out using /attendance/check-out with 3 GeoTag images.',
                adapter: {
                    legacyEndpoint: '/attendance/submit',
                    executedSteps: ['check-in'],
                    pendingSteps: ['check-out', 'verification'],
                },
            });
        }

        const checkOutResult = await runCanonicalAttendanceAdapterStep({
            handler: checkOutHandler,
            req,
            body: buildLegacySubmitCheckOutBody(legacyPayload),
        });

        if (checkOutResult.statusCode >= 400 || !checkOutResult.payload?.success) {
            return res.status(checkOutResult.statusCode).json(checkOutResult.payload);
        }

        return res.status(checkOutResult.statusCode || 200).json({
            ...checkOutResult.payload,
            message: `Legacy submit adapter executed canonical check-in + check-out. ${checkOutResult.payload?.message || ''}`.trim(),
            adapter: {
                legacyEndpoint: '/attendance/submit',
                executedSteps: ['check-in', 'check-out'],
                pendingSteps: ['verification'],
            },
        });
    } catch (error) {
        console.error('Error submitting attendance through legacy adapter:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to process legacy submit adapter',
            error: error.message,
        });
    }
});

// Export Attendance to Excel (Dynamic)
router.get('/:id/export-excel', async (req, res) => {
    try {
        const attendance = await Attendance.findById(req.params.id)
            .populate({
                path: 'trainerId',
                populate: { path: 'userId', select: 'name' }
            })
            .populate('collegeId', 'name')
            .populate('scheduleId', 'subject courseId');
            
        if (!attendance) return res.status(404).json({ success: false, message: 'Attendance not found' });

        const wb = xlsx.utils.book_new();
        
        // Prepare Summary Header
        const aoaData = [
            ['ATTENDANCE REPORT'],
            ['Trainer', attendance.trainerId?.userId?.name || 'N/A'],
            ['College', attendance.collegeId?.name || 'N/A'],
            ['Topic', attendance.scheduleId?.subject || 'N/A'],
            ['Date', attendance.date ? new Date(attendance.date).toLocaleDateString() : 'N/A'],
            ['Check-In Time', attendance.checkInTime || 'N/A'],
            ['Check-In Dist', attendance.checkIn?.location?.distanceFromCollege ? `${Math.round(attendance.checkIn.location.distanceFromCollege)}m` : 'N/A'],
            ['Check-Out Time', attendance.checkOutTime || 'N/A'],
            ['Check-Out Dist', attendance.checkOut?.location?.distanceFromCollege ? `${Math.round(attendance.checkOut.location.distanceFromCollege)}m` : 'N/A'],
            ['Total Present', attendance.studentsPresent || 0],
            ['Total Absent', attendance.studentsAbsent || 0],
            [], // Spacer
            ['RollNo', 'RegisterNo', 'StudentName', 'Status'] // Header strictly as requested
        ];

        // Process Students
        let studentsToUse = [];
        if (attendance.students && attendance.students.length > 0) {
            // Sort numerically first
            studentsToUse = [...attendance.students].sort((a, b) => {
                const aNum = parseInt(a.rollNo?.replace(/\D/g, '') || '0') || 0;
                const bNum = parseInt(b.rollNo?.replace(/\D/g, '') || '0') || 0;
                return aNum - bNum;
            });
        } else {
            const filter = { collegeId: attendance.collegeId };
            if (attendance.courseId) filter.courseId = attendance.courseId;
            else if (attendance.scheduleId?.courseId) filter.courseId = attendance.scheduleId.courseId;
            studentsToUse = await Student.find(filter);
            // Sort numerically
            studentsToUse.sort((a, b) => {
                const aNum = parseInt(a.rollNo?.replace(/\D/g, '') || '0') || 0;
                const bNum = parseInt(b.rollNo?.replace(/\D/g, '') || '0') || 0;
                return aNum - bNum;
            });
        }

        const totalPresent = attendance.studentsPresent || 0;
        const totalAbsent = attendance.studentsAbsent || 0;

        studentsToUse.forEach((s, index) => {
            // Use sequential Index as RollNo for auditor clarity
            const rollNo = index + 1; 
            
            // Status distribution if session-specific data is missing
            let status = s.status;
            if (!status) {
                if (index < totalPresent) status = 'Present';
                else if (index < (totalPresent + totalAbsent)) status = 'Absent';
                else status = '-';
            }

            aoaData.push([
                rollNo,
                s.registerNo || '-',
                s.name || '-',
                status
            ]);
        });

        const ws = xlsx.utils.aoa_to_sheet(aoaData);
        xlsx.utils.book_append_sheet(wb, ws, "Attendance");
        
        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        const collegeName = attendance.collegeId?.name || 'College';
        const dateStr = attendance.date ? new Date(attendance.date).toLocaleDateString().replace(/\//g, '-') : 'Date';
        const filename = `Attendance_${collegeName}_${dateStr}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.send(buffer);
    } catch (err) {
        console.error('Excel Export Error:', err);
        res.status(500).json({ success: false, message: 'Failed to generate excel', error: err.message });
    }
});

router.uploadSingleGeoImageMiddleware = uploadSingleGeoImageMiddleware;
router.uploadSingleGeoImageHandler = uploadSingleGeoImageHandler;

router.validateAssignedScheduleUpload = validateAssignedScheduleUpload;
router.validateCheckOutSessionState = validateCheckOutSessionState;
router.resolveCanonicalUploadFolders = resolveCanonicalUploadFolders;
module.exports = router;

