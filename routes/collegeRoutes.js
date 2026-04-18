const express = require('express');
const router = express.Router();
const { College, Trainer, User } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const { cascadeDeleteCollegesByIds } = require('../services/hierarchyDeleteService');
const {
    ensureCollegeHierarchy,
    ensureDepartmentHierarchy,
    isTrainingDriveEnabled,
    toDepartmentDayFolders,
} = require('../modules/drive/driveGateway');
const {
    normalizeRole,
    canAccessCollegeByCompany,
    parseDepartments,
    getUserCompanyIds,
    getUserCollegeIds,
} = require('../utils/departmentAccess');
const {
    normalizeCollegeLocation,
    hasValidCollegeCoordinates,
    mergeCollegeLocations,
    collegeLocationsEqual,
} = require('../utils/collegeLocation');

// Middleware to check if user is SPOCAdmin or SuperAdmin
const isSPOCAdmin = (req, res, next) => {
    const role = normalizeRole(req.user?.role);
    const allowedRoles = new Set(['spocadmin', 'superadmin', 'admin', 'companyadmin', 'company', 'accouNDAnt', 'collegeadmin']);
    if (!allowedRoles.has(role)) {
        return res.status(403).json({ message: 'Access denied.' });
    }
    next();
};

const toNullableNumber = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
};

const MAP_COORD_PATTERNS = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /[?&]query=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /[?&]ll=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /[?&]center=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i,
];

const extractCoordinatesFromMapUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    let normalized = url.trim();
    if (!normalized) return null;

    try {
        normalized = decodeURIComponent(normalized);
    } catch (error) {
        // Keep original URL when decoding fails.
    }

    for (const pattern of MAP_COORD_PATTERNS) {
        const match = normalized.match(pattern);
        if (!match) continue;

        const lat = Number.parseFloat(match[1]);
        const lng = Number.parseFloat(match[2]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;

        return { lat, lng };
    }

    return null;
};

const normalizeText = (value) => String(value || '').trim().toLowerCase();
const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasViewPermission = (permissions = []) => {
    const normalized = Array.isArray(permissions)
        ? permissions.map((item) => String(item || '').trim().toLowerCase())
        : [];

    if (!normalized.length) return true;
    return normalized.includes('view') || normalized.includes('*') || normalized.includes('all');
};

const syncCollegeLocationToSchedules = async (collegeId, collegeLike) => {
    const normalizedCollegeLocation = normalizeCollegeLocation(collegeLike);
    if (!collegeId || !hasValidCollegeCoordinates(normalizedCollegeLocation)) return;

    const { Schedule } = require('../models');
    const schedules = await Schedule.find({ collegeId }).select('_id collegeLocation');
    if (!schedules.length) return;

    const updates = schedules.reduce((result, schedule) => {
        const mergedLocation = mergeCollegeLocations(normalizedCollegeLocation, schedule.collegeLocation);
        if (!mergedLocation || collegeLocationsEqual(schedule.collegeLocation, mergedLocation)) {
            return result;
        }

        result.push({
            updateOne: {
                filter: { _id: schedule._id },
                update: { $set: { collegeLocation: mergedLocation } }
            }
        });
        return result;
    }, []);

    if (updates.length) {
        await Schedule.bulkWrite(updates, { ordered: false });
    }
};

const hasAttendanceDocs = (attendance) =>
    Boolean(attendance?.attendancePdfUrl || attendance?.attendanceExcelUrl);

const hasGeoTagDocs = (attendance) =>
    Boolean(
        attendance?.signatureUrl
        || attendance?.studentsPhotoUrl
        || attendance?.checkOutGeoImageUrl
        || (Array.isArray(attendance?.checkOutGeoImageUrls) && attendance.checkOutGeoImageUrls.length)
        || (Array.isArray(attendance?.activityPhotos) && attendance.activityPhotos.length)
        || (Array.isArray(attendance?.activityVideos) && attendance.activityVideos.length)
    );

const normalizeGeoVerificationToken = (value) =>
    String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

const deriveCheckoutGeoState = (attendance) => {
    const checkOutVerification = normalizeGeoVerificationToken(attendance?.checkOutVerificationStatus);
    if (checkOutVerification) {
        if (
            checkOutVerification === 'auto_verified'
            || checkOutVerification === 'approved'
            || checkOutVerification === 'verified'
            || checkOutVerification === 'completed'
        ) {
            return 'approved';
        }

        if (checkOutVerification === 'rejected' || checkOutVerification === 'manually_rejected') {
            return 'rejected';
        }

        if (
            checkOutVerification === 'manual_review_required'
            || checkOutVerification === 'manual_review'
            || checkOutVerification === 'review_required'
        ) {
            return 'manual_review_required';
        }

        if (checkOutVerification === 'pending_checkout' || checkOutVerification === 'pending') {
            return 'pending';
        }
    }

    const legacyGeoVerification = normalizeGeoVerificationToken(attendance?.geoVerificationStatus);
    if (legacyGeoVerification === 'approved') return 'approved';
    if (legacyGeoVerification === 'rejected') return 'rejected';
    return 'pending';
};

const isGeoVerificationApproved = (attendance) => {
    return deriveCheckoutGeoState(attendance) === 'approved';
};

const isGeoVerificationRejected = (attendance) => {
    return deriveCheckoutGeoState(attendance) === 'rejected';
};

const isAttendanceVerificationApproved = (attendance) => {
    const token = normalizeGeoVerificationToken(attendance?.verificationStatus);
    return (
        token === 'approved'
        || token === 'verified'
        || token === 'completed'
        || token === 'auto_verified'
        || token === 'manually_verified'
    );
};

const buildDocsStatusLabel = (attendance) => hasAttendanceDocs(attendance) ? 'Docs Uploaded' : 'Pending';

const buildGeoStatusLabel = (attendance) => {
    const geoState = deriveCheckoutGeoState(attendance);
    if (geoState === 'approved') return 'Geo Verified';
    if (geoState === 'rejected') return 'Geo Rejected';
    if (geoState === 'manual_review_required') return 'Geo Manual Review';
    return 'Geo Pending';
};

const normalizeDayStatus = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'completed') return 'completed';
    if (normalized === 'pending') return 'pending';
    if (normalized === 'not_assigned') return 'not_assigned';
    return null;
};

const buildDayUploadStatus = (schedule, attendance) => {
    const attendanceUploaded = Boolean(
        hasAttendanceDocs(attendance)
        || schedule?.attendanceUploaded === true
    );
    const geoTagUploaded = Boolean(
        hasGeoTagDocs(attendance)
        || schedule?.geoTagUploaded === true
    );
    const persistedDayStatus = normalizeDayStatus(schedule?.dayStatus);
    const normalizedScheduleStatus = String(schedule?.status || '').trim().toLowerCase();
    const hasTrainerAssigned = Boolean(schedule?.trainerId);
    const attendanceVerified = isAttendanceVerificationApproved(attendance);
    const geoVerified = isGeoVerificationApproved(attendance);
    const docsRejected = normalizeGeoVerificationToken(attendance?.verificationStatus) === 'rejected'
        || isGeoVerificationRejected(attendance);
    const checkoutGeoState = deriveCheckoutGeoState(attendance);

    if (!hasTrainerAssigned || normalizedScheduleStatus === 'cancelled') {
        return {
            attendanceUploaded,
            geoTagUploaded,
            statusCode: 'not_assigned',
            statusLabel: 'Not Assigned',
        };
    }

    if (attendanceUploaded && geoTagUploaded && attendanceVerified && geoVerified && !docsRejected) {
        return {
            attendanceUploaded,
            geoTagUploaded,
            statusCode: 'completed',
            statusLabel: 'Completed',
        };
    }

    // Backward compatibility: keep persisted completion if docs remain uploaded and not rejected.
    if (
        persistedDayStatus === 'completed'
        && attendanceUploaded
        && geoTagUploaded
        && !docsRejected
        && checkoutGeoState !== 'manual_review_required'
        && checkoutGeoState !== 'pending'
    ) {
        return {
            attendanceUploaded,
            geoTagUploaded,
            statusCode: 'completed',
            statusLabel: 'Completed',
        };
    }

    if (persistedDayStatus === 'pending' || persistedDayStatus === 'not_assigned') {
        return {
            attendanceUploaded,
            geoTagUploaded,
            statusCode: persistedDayStatus,
            statusLabel: persistedDayStatus === 'pending' ? 'Pending' : 'Not Assigned',
        };
    }

    return {
        attendanceUploaded,
        geoTagUploaded,
        statusCode: 'pending',
        statusLabel: 'Pending',
    };
};

const toAttendanceEventTime = (attendance) => {
    const candidates = [
        attendance?.updatedAt,
        attendance?.createdAt,
        attendance?.checkOutVerifiedAt,
        attendance?.approvedAt,
        attendance?.checkOutCapturedAt,
    ];

    for (const candidate of candidates) {
        const parsed = new Date(candidate);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.getTime();
        }
    }

    return 0;
};

const computeAttendanceSelectionScore = (attendance) => {
    const docsApproved = normalizeGeoVerificationToken(attendance?.verificationStatus) === 'approved';
    const docsRejected = normalizeGeoVerificationToken(attendance?.verificationStatus) === 'rejected';
    const geoState = deriveCheckoutGeoState(attendance);
    const geoApproved = geoState === 'approved';
    const geoRejected = geoState === 'rejected';
    const manualReviewRequired = geoState === 'manual_review_required';
    const hasDocs = hasAttendanceDocs(attendance);
    const hasGeoEvidence = hasGeoTagDocs(attendance);

    if (docsApproved && geoApproved && !docsRejected && !geoRejected) return 600;
    if (docsApproved && manualReviewRequired && !docsRejected) return 500;
    if (docsApproved && hasGeoEvidence && !docsRejected) return 450;
    if (docsApproved && !docsRejected) return 420;
    if (docsRejected || geoRejected) return 300;
    if (hasDocs && hasGeoEvidence) return 220;
    if (hasDocs) return 150;
    if (hasGeoEvidence) return 120;
    return 0;
};

const isPreferredAttendanceCandidate = (candidate, current) => {
    if (!candidate) return false;
    if (!current) return true;

    const candidateScore = computeAttendanceSelectionScore(candidate);
    const currentScore = computeAttendanceSelectionScore(current);
    if (candidateScore !== currentScore) {
        return candidateScore > currentScore;
    }

    const candidateTime = toAttendanceEventTime(candidate);
    const currentTime = toAttendanceEventTime(current);
    if (candidateTime !== currentTime) {
        return candidateTime > currentTime;
    }

    return String(candidate?._id || '') > String(current?._id || '');
};

const ensureDepartmentsAndSchedules = async (college, preferredDepartmentName = '') => {
    const { Department, Schedule } = require('../models');
    const companyIdValue = college?.companyId?._id || college?.companyId || null;
    const courseIdValue = college?.courseId?._id || college?.courseId || null;
    const departmentNames = parseDepartments(college?.department);

    if (preferredDepartmentName && !departmentNames.some((item) => normalizeText(item) === normalizeText(preferredDepartmentName))) {
        departmentNames.push(preferredDepartmentName.trim());
    }

    const existingDepartments = await Department.find({ collegeId: college._id }).select('_id name');
    const existingMap = new Map(
        existingDepartments.map((dep) => [normalizeText(dep.name), dep])
    );

    const departmentsToInsert = departmentNames
        .filter((name) => !existingMap.has(normalizeText(name)))
        .map((name) => ({
            name,
            companyId: companyIdValue || null,
            courseId: courseIdValue || null,
            collegeId: college._id,
            isActive: true,
        }));

    if (departmentsToInsert.length) {
        try {
            await Department.insertMany(departmentsToInsert, { ordered: false });
        } catch (error) {
            if (error?.code !== 11000 && error?.name !== 'BulkWriteError') {
                throw error;
            }
        }
    }

    const departments = await Department.find({ collegeId: college._id }).sort({ name: 1 });
    if (!departments.length) {
        return { departments: [], activeDepartment: null };
    }

    const activeDepartment = departments.find((dep) => normalizeText(dep.name) === normalizeText(preferredDepartmentName))
        || departments[0];

    const dayFoldersByDepartmentId = new Map();
    if (isTrainingDriveEnabled()) {
        try {
            const { Company, Course } = require('../models');
            const companyDoc = companyIdValue
                ? await Company.findById(companyIdValue).select('name driveFolderId driveFolderName driveFolderLink')
                : null;
            const courseDoc = courseIdValue
                ? await Course.findById(courseIdValue).select('title driveFolderId driveFolderName driveFolderLink')
                : null;

            const collegeHierarchy = await ensureCollegeHierarchy({
                company: companyDoc || { _id: companyIdValue, name: `Company_${companyIdValue}` },
                course: courseDoc || null,
                college,
            });

            if (collegeHierarchy?.companyFolder?.id && companyDoc && companyDoc.driveFolderId !== collegeHierarchy.companyFolder.id) {
                companyDoc.driveFolderId = collegeHierarchy.companyFolder.id;
                companyDoc.driveFolderName = collegeHierarchy.companyFolder.name;
                companyDoc.driveFolderLink = collegeHierarchy.companyFolder.link;
                await companyDoc.save();
            }

            if (collegeHierarchy?.courseFolder?.id && courseDoc && courseDoc.driveFolderId !== collegeHierarchy.courseFolder.id) {
                courseDoc.driveFolderId = collegeHierarchy.courseFolder.id;
                courseDoc.driveFolderName = collegeHierarchy.courseFolder.name;
                courseDoc.driveFolderLink = collegeHierarchy.courseFolder.link;
                await courseDoc.save();
            }

            if (collegeHierarchy?.collegeFolder?.id && college.driveFolderId !== collegeHierarchy.collegeFolder.id) {
                college.driveFolderId = collegeHierarchy.collegeFolder.id;
                college.driveFolderName = collegeHierarchy.collegeFolder.name;
                college.driveFolderLink = collegeHierarchy.collegeFolder.link;
                await college.save();
            }

            for (const department of departments) {
                const departmentHierarchy = await ensureDepartmentHierarchy({
                    company: companyDoc || { _id: companyIdValue, name: `Company_${companyIdValue}` },
                    course: courseDoc || null,
                    college,
                    department,
                    totalDays: 12,
                });

                let shouldSaveDepartment = false;
                if (departmentHierarchy?.departmentFolder?.id && department.driveFolderId !== departmentHierarchy.departmentFolder.id) {
                    department.driveFolderId = departmentHierarchy.departmentFolder.id;
                    department.driveFolderName = departmentHierarchy.departmentFolder.name;
                    department.driveFolderLink = departmentHierarchy.departmentFolder.link;
                    shouldSaveDepartment = true;
                }

                const dayFolders = toDepartmentDayFolders(departmentHierarchy?.dayFoldersByDayNumber || {});
                if (dayFolders.length) {
                    department.dayFolders = dayFolders;
                    shouldSaveDepartment = true;
                }

                if (shouldSaveDepartment) {
                    await department.save();
                }

                dayFoldersByDepartmentId.set(
                    String(department._id),
                    departmentHierarchy?.dayFoldersByDayNumber || {}
                );
            }
        } catch (driveError) {
            console.error('[GOOGLE-DRIVE] Failed to sync college department/day folders:', driveError.message);
        }
    }

    // Backward compatibility: if college has only one department, attach legacy schedules.
    if (departments.length === 1) {
        await Schedule.updateMany(
            {
                collegeId: college._id,
                $or: [{ departmentId: { $exists: false } }, { departmentId: null }],
            },
            { $set: { departmentId: departments[0]._id } }
        );
    }

    const existingDepartmentSchedules = await Schedule.find({
        collegeId: college._id,
        departmentId: { $in: departments.map((dep) => dep._id) },
    }).select('_id departmentId dayNumber dayFolderId dayFolderName dayFolderLink attendanceFolderId geoTagFolderId driveFolderId driveFolderName driveFolderLink');

    const existingDayKeys = new Set(
        existingDepartmentSchedules.map((item) => `${String(item.departmentId)}-${item.dayNumber}`)
    );

    const missingSchedules = [];
    departments.forEach((department) => {
        for (let day = 1; day <= 12; day++) {
            const key = `${String(department._id)}-${day}`;
            if (existingDayKeys.has(key)) continue;
            const dayFolder = dayFoldersByDepartmentId.get(String(department._id))?.[day] || null;

            missingSchedules.push({
                dayNumber: day,
                collegeId: college._id,
                departmentId: department._id,
                companyId: companyIdValue || null,
                courseId: courseIdValue || null,
                status: 'scheduled',
                startTime: '09:00',
                endTime: '17:00',
                subject: `Day ${day} Content`,
                dayFolderId: dayFolder?.id || null,
                dayFolderName: dayFolder?.name || null,
                dayFolderLink: dayFolder?.link || null,
                attendanceFolderId: dayFolder?.attendanceFolder?.id || null,
                attendanceFolderName: dayFolder?.attendanceFolder?.name || null,
                attendanceFolderLink: dayFolder?.attendanceFolder?.link || null,
                geoTagFolderId: dayFolder?.geoTagFolder?.id || null,
                geoTagFolderName: dayFolder?.geoTagFolder?.name || null,
                geoTagFolderLink: dayFolder?.geoTagFolder?.link || null,
                driveFolderId: dayFolder?.id || null,
                driveFolderName: dayFolder?.name || null,
                driveFolderLink: dayFolder?.link || null,
            });
        }
    });

    if (missingSchedules.length) {
        try {
            await Schedule.insertMany(missingSchedules, { ordered: false });
        } catch (error) {
            if (error?.code !== 11000 && error?.name !== 'BulkWriteError') {
                throw error;
            }
        }
    }

    if (dayFoldersByDepartmentId.size) {
        const scheduleFolderUpdates = [];
        existingDepartmentSchedules.forEach((schedule) => {
            const dayFolder = dayFoldersByDepartmentId.get(String(schedule.departmentId))?.[schedule.dayNumber] || null;
            if (!dayFolder?.id) return;

            if (
                schedule.dayFolderId !== dayFolder.id ||
                schedule.dayFolderName !== dayFolder.name ||
                schedule.dayFolderLink !== dayFolder.link ||
                schedule.attendanceFolderId !== (dayFolder?.attendanceFolder?.id || null) ||
                schedule.geoTagFolderId !== (dayFolder?.geoTagFolder?.id || null) ||
                schedule.driveFolderId !== dayFolder.id ||
                schedule.driveFolderName !== dayFolder.name ||
                schedule.driveFolderLink !== dayFolder.link
            ) {
                scheduleFolderUpdates.push({
                    updateOne: {
                        filter: { _id: schedule._id },
                        update: {
                            $set: {
                                dayFolderId: dayFolder.id,
                                dayFolderName: dayFolder.name,
                                dayFolderLink: dayFolder.link,
                                attendanceFolderId: dayFolder?.attendanceFolder?.id || null,
                                attendanceFolderName: dayFolder?.attendanceFolder?.name || null,
                                attendanceFolderLink: dayFolder?.attendanceFolder?.link || null,
                                geoTagFolderId: dayFolder?.geoTagFolder?.id || null,
                                geoTagFolderName: dayFolder?.geoTagFolder?.name || null,
                                geoTagFolderLink: dayFolder?.geoTagFolder?.link || null,
                                driveFolderId: dayFolder.id,
                                driveFolderName: dayFolder.name,
                                driveFolderLink: dayFolder.link,
                            },
                        },
                    },
                });
            }
        });

        if (scheduleFolderUpdates.length) {
            try {
                await Schedule.bulkWrite(scheduleFolderUpdates, { ordered: false });
            } catch (error) {
                console.error('[GOOGLE-DRIVE] Failed to backfill day folder metadata on schedules:', error.message);
            }
        }
    }

    return { departments, activeDepartment };
};

// GET /api/colleges/:id - Get college by ID
router.get('/:id', authenticate, async (req, res) => {
    try {
        const college = await College.findById(req.params.id)
            .populate('courseId', 'title name')
            .populate('companyId', 'name companyCode');
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }

        if (!canAccessCollegeByCompany({ user: req.user, college })) {
            return res.status(403).json({ message: 'Access denied for this college' });
        }

        if (normalizeRole(req.user?.role) === 'trainer') {
            const trainerProfile = await Trainer.findOne({ userId: req.user.id }).select('_id');
            const assignedTrainerIds = (college.trainers || []).map((id) => String(id));
            if (!trainerProfile || !assignedTrainerIds.includes(String(trainerProfile._id))) {
                return res.status(403).json({ message: 'Access denied for this college' });
            }
        }
        res.json(college);
    } catch (error) {
        console.error('Error fetching college:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/colleges/:id/details - Get college details with schedules and attendance
router.get('/:id/details', authenticate, async (req, res) => {
    try {
        const { Schedule, Attendance } = require('../models');
        const requestedDepartment = typeof req.query.department === 'string' ? req.query.department.trim() : '';

        const college = await College.findById(req.params.id)
            .populate('courseId', 'title name')
            .populate('companyId', 'name companyCode');

        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }

        if (!canAccessCollegeByCompany({ user: req.user, college })) {
            return res.status(403).json({ message: 'Access denied for this college' });
        }

        if (normalizeRole(req.user?.role) === 'trainer') {
            const trainerProfile = await Trainer.findOne({ userId: req.user.id }).select('_id');
            const assignedTrainerIds = (college.trainers || []).map((id) => String(id));
            if (!trainerProfile || !assignedTrainerIds.includes(String(trainerProfile._id))) {
                return res.status(403).json({ message: 'Access denied for this college' });
            }
        }

        const role = normalizeRole(req.user?.role);
        const userId = req.user.id || req.user._id;
        const { departments } = await ensureDepartmentsAndSchedules(college, requestedDepartment);

        const departmentById = new Map(departments.map((dep) => [String(dep._id), dep]));
        const allDepartmentNames = departments.map((dep) => dep.name);
        let visibleDepartments = [...allDepartmentNames];

        const fullViewRoles = new Set(['superadmin', 'admin', 'companyadmin', 'company', 'spocadmin', 'collegeadmin']);
        if (!fullViewRoles.has(role)) {
            const { UserDepartmentAccess } = require('../models');
            const accessRows = await UserDepartmentAccess.find({
                userId,
                departmentId: { $in: departments.map((dep) => dep._id) },
            }).select('departmentId permissions');

            const viewDepartmentIds = new Set(
                accessRows
                    .filter((row) => hasViewPermission(row.permissions))
                    .map((row) => String(row.departmentId))
            );

            // Backward-compatible fallback for users still using departmentIds on User.
            if (!viewDepartmentIds.size && Array.isArray(req.user?.departmentIds)) {
                req.user.departmentIds.forEach((depId) => viewDepartmentIds.add(String(depId)));
            }

            visibleDepartments = [...viewDepartmentIds]
                .map((depId) => departmentById.get(depId))
                .filter(Boolean)
                .map((dep) => dep.name);
        }

        const requestedAllowed = !requestedDepartment
            || visibleDepartments.some((dep) => normalizeText(dep) === normalizeText(requestedDepartment));

        if (requestedDepartment && !requestedAllowed) {
            return res.status(403).json({ message: 'Access denied for this department' });
        }

        // Fetch trainers for this college
        const trainers = await Trainer.find({ _id: { $in: college.trainers } })
            .populate('userId', 'name email profilePicture');

        const preferredDepartmentName = requestedDepartment || visibleDepartments[0] || allDepartmentNames[0] || '';
        const activeDepartment = departments.find((dep) => normalizeText(dep.name) === normalizeText(preferredDepartmentName))
            || departments.find((dep) => visibleDepartments.some((visible) => normalizeText(visible) === normalizeText(dep.name)))
            || null;

        const scheduleFilter = { collegeId: college._id };
        if (activeDepartment?._id) {
            scheduleFilter.departmentId = activeDepartment._id;
        } else {
            scheduleFilter._id = { $in: [] };
        }

        // Fetch schedules for active department with populated references
        const schedules = await Schedule.find(scheduleFilter)
            .sort({ dayNumber: 1, scheduledDate: 1, startTime: 1 })
            .populate('trainerId', 'phone trainerId profilePicture')
            .populate({
                path: 'trainerId',
                populate: {
                    path: 'userId',
                    select: 'name profilePicture'
                }
            });

        // Fetch attendance rows for all schedules, then select the most effective row
        // (approved + geo-approved rows should win over stale pending duplicates).
        const scheduleIds = schedules.map((schedule) => schedule?._id).filter(Boolean);
        const attendanceRows = scheduleIds.length
            ? await Attendance.find({ scheduleId: { $in: scheduleIds } })
                .sort({ createdAt: -1 })
                .populate({
                    path: 'trainerId',
                    populate: {
                        path: 'userId',
                        select: 'name profilePicture'
                    }
                })
            : [];

        const attendanceByScheduleId = new Map();
        attendanceRows.forEach((attendance) => {
            const scheduleKey = String(attendance?.scheduleId || '').trim();
            if (!scheduleKey) return;
            const current = attendanceByScheduleId.get(scheduleKey);
            if (isPreferredAttendanceCandidate(attendance, current)) {
                attendanceByScheduleId.set(scheduleKey, attendance);
            }
        });

        const schedulesWithAttendance = schedules.map((schedule) => ({
            schedule,
            attendance: attendanceByScheduleId.get(String(schedule?._id || '')) || null,
        }));

        // Transform data to match frontend expectation
        const days = schedulesWithAttendance.map(({ schedule, attendance }) => {
            const dayUploadStatus = buildDayUploadStatus(schedule, attendance);

            return {
                id: schedule._id,
                dayNumber: schedule.dayNumber,
                departmentId: schedule.departmentId || activeDepartment?._id || null,
                departmentName: activeDepartment?.name || null,
                driveFolderId: schedule.driveFolderId || schedule.dayFolderId || null,
                driveFolderName: schedule.driveFolderName || schedule.dayFolderName || null,
                driveFolderLink: schedule.driveFolderLink || schedule.dayFolderLink || null,
                dayFolderId: schedule.dayFolderId || schedule.driveFolderId || null,
                dayFolderName: schedule.dayFolderName || schedule.driveFolderName || null,
                dayFolderLink: schedule.dayFolderLink || schedule.driveFolderLink || null,
                attendanceFolderId: schedule.attendanceFolderId || null,
                attendanceFolderName: schedule.attendanceFolderName || null,
                attendanceFolderLink: schedule.attendanceFolderLink || null,
                geoTagFolderId: schedule.geoTagFolderId || null,
                geoTagFolderName: schedule.geoTagFolderName || null,
                geoTagFolderLink: schedule.geoTagFolderLink || null,
                trainerName: schedule.trainerId?.userId?.name || attendance?.trainerId?.userId?.name || 'Unknown',
                trainerPhone: schedule.trainerId?.phone || attendance?.trainerId?.phone || 'N/A',
                trainerId: schedule.trainerId?._id || attendance?.trainerId?._id, // Needed for manual attendance creation
                trainerCustomId: schedule.trainerId?.trainerId || attendance?.trainerId?.trainerId || 'N/A',
                trainerProfilePhoto: schedule.trainerId?.profilePicture || schedule.trainerId?.userId?.profilePicture || attendance?.trainerId?.profilePicture || attendance?.trainerId?.userId?.profilePicture || null,
                syllabusName: attendance?.syllabus || schedule.subject || `Day ${schedule.dayNumber} Content`,
                date: schedule.scheduledDate,
                time: `${schedule.startTime} - ${schedule.endTime}`,
                status: dayUploadStatus.statusLabel,
                statusCode: dayUploadStatus.statusCode,
                attendanceUploaded: dayUploadStatus.attendanceUploaded,
                geoTagUploaded: dayUploadStatus.geoTagUploaded,
                verificationStatus: attendance ? attendance.verificationStatus : 'Pending',
                geoVerificationStatus: attendance ? attendance.geoVerificationStatus : 'pending',
                checkOutVerificationStatus: attendance ? attendance.checkOutVerificationStatus : 'pending_checkout',
                hasAttendanceDocs: hasAttendanceDocs(attendance),
                hasGeoTagDocs: hasGeoTagDocs(attendance),
                docsStatusLabel: buildDocsStatusLabel(attendance),
                geoStatusLabel: buildGeoStatusLabel(attendance),
                approvedBy: attendance ? attendance.approvedBy : null,
                collegeSpoc: college.spocName || college.principalName || 'N/A',
                companySpoc: 'Company SPOC', // Placeholder
                attendanceImage: attendance?.studentsPhotoUrl || null,
                attendancePdfUrl: attendance?.attendancePdfUrl || null,
                checkOutGeoImageUrl: attendance?.checkOutGeoImageUrl || null,
                checkOutGeoImageUrls: attendance?.checkOutGeoImageUrls || [],
                geoTag: attendance ? `${attendance.latitude}, ${attendance.longitude}` : null,
                attendanceId: attendance?._id,
                location: attendance ? attendance.location : null,
                checkInTime: attendance ? attendance.checkInTime : null,
                checkOutTime: attendance ? attendance.checkOutTime : null,
                checkIn: attendance ? attendance.checkIn : null,
                checkOut: attendance ? attendance.checkOut : null,
                area: attendance ? attendance.area : null,
                studentsPresent: attendance ? attendance.studentsPresent : 0,
                studentsAbsent: attendance ? attendance.studentsAbsent : 0,
                hasAttendance: !!attendance
            };
        });

        res.json({
            college,
            days,
            trainers, // Send the fetched trainers list
            visibleDepartments,
            departments: departments
                .filter((dep) => visibleDepartments.some((name) => normalizeText(name) === normalizeText(dep.name)))
                .map((dep) => ({ _id: dep._id, name: dep.name })),
            activeDepartment: activeDepartment?.name || preferredDepartmentName || null,
            activeDepartmentId: activeDepartment?._id || null,
        });

    } catch (error) {
        console.error('Error fetching college details:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// GET /api/colleges - Get all colleges (filtered by companyId or courseId)
router.get('/', authenticate, isSPOCAdmin, async (req, res) => {
    try {
        const { companyId, courseId } = req.query;
        const filter = {};
        const role = normalizeRole(req.user?.role);

        if (courseId) {
            filter.courseId = courseId;
        }

        if (companyId) {
            filter.companyId = companyId;
        } else if (role === 'spocadmin') {
            // Find the company owned by this SPOC
            const { Company } = require('../models');
            const company = await Company.findOne({ userId: req.user.id });
            if (company) {
                filter.companyId = company._id;
            } else {
                // If no company assigned, they shouldn't see any colleges
                return res.json([]);
            }
        } else if (role === 'companyadmin' || role === 'company' || role === 'accouNDAnt' || role === 'collegeadmin') {
            if (role === 'collegeadmin') {
                const userCollegeIds = getUserCollegeIds(req.user);
                if (!userCollegeIds.length) {
                    return res.json([]);
                }
                filter._id = { $in: userCollegeIds };
            } else {
                const userCompanyIds = getUserCompanyIds(req.user);
                if (userCompanyIds.length) {
                    filter.companyId = { $in: userCompanyIds };
                }
            }
        } else if (role === 'trainer') {
            const trainerProfile = await Trainer.findOne({ userId: req.user.id }).select('_id');
            if (!trainerProfile) return res.json([]);
            filter.trainers = trainerProfile._id;
        }


        const colleges = await College.find(filter)
            .populate({
                path: 'trainers',
                populate: {
                    path: 'userId',
                    select: 'name email'
                }
            });
        res.json(colleges);
    } catch (error) {
        console.error('Error in GET /api/colleges:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// POST /api/colleges - Create a new college
router.post('/', authenticate, isSPOCAdmin, async (req, res) => {
    try {
        const {
            name,
            location,
            address,
            mapUrl,
            latitude,
            longitude,
            principalName,
            phone,
            spocName,
            spocPhone,
            email,
            website,
            zone,
            city,
            department,
            companyId,
            courseId
        } = req.body;

        const { Company, Course, Schedule } = require('../models');

        let company;
        // If companyId is provided (e.g. by SuperAdmin), use it
        if (companyId) {
            company = await Company.findById(companyId);
        } else {
            // Otherwise try to find company associated with the user (SPOCAdmin)
            company = await Company.findOne({ userId: req.user.id });
        }

        if (!company) {
            console.error('Company not found for user:', req.user.id);
            return res.status(404).json({ message: 'Company not found' });
        }

        const normalizedCollegeName = String(name || '').trim();
        if (!normalizedCollegeName) {
            return res.status(400).json({ message: 'College name is required' });
        }
        // Idempotent guard: avoid duplicate college rows from repeated submits/retries.
        const duplicateQuery = {
            companyId: company._id,
            name: { $regex: new RegExp(`^${escapeRegExp(normalizedCollegeName)}$`, 'i') },
        };

        const duplicateCollege = await College.findOne(duplicateQuery);
        if (duplicateCollege) {
            return res.status(200).json({
                ...duplicateCollege.toObject(),
                duplicate: true,
                message: 'College already exists. Existing record returned.',
            });
        }

        const resolvedAddress = address ?? location?.address ?? null;
        const resolvedMapUrl = typeof mapUrl === 'string' && mapUrl.trim() ? mapUrl.trim() : null;
        const urlCoordinates = extractCoordinatesFromMapUrl(resolvedMapUrl);
        const resolvedLatitude = latitude !== undefined
            ? toNullableNumber(latitude)
            : (location?.lat !== undefined
                ? toNullableNumber(location?.lat)
                : urlCoordinates?.lat ?? null);
        const resolvedLongitude = longitude !== undefined
            ? toNullableNumber(longitude)
            : (location?.lng !== undefined
                ? toNullableNumber(location?.lng)
                : urlCoordinates?.lng ?? null);
        const resolvedSpocName = spocName || principalName || null;
        const resolvedSpocPhone = spocPhone || phone || null;
        const resolvedDepartment = (typeof department === 'string' && department.trim()) ? department.trim() : 'General';

        const college = await College.create({
            name: normalizedCollegeName,
            address: resolvedAddress,
            mapUrl: resolvedMapUrl,
            latitude: resolvedLatitude,
            longitude: resolvedLongitude,
            location: {
                address: resolvedAddress,
                lat: resolvedLatitude,
                lng: resolvedLongitude,
                mapUrl: resolvedMapUrl
            },
            spocName: resolvedSpocName,
            spocPhone: resolvedSpocPhone,
            principalName: resolvedSpocName,
            phone: resolvedSpocPhone,
            email,
            website,
            zone,
            city: (typeof city === 'string' && city.trim()) ? city.trim() : null,
            department: resolvedDepartment,
            companyId: company._id,
            courseId: courseId || null
        });


        // If courseId is provided, link college to course (keep this for backward compatibility/other lookups)
        let courseDoc = null;
        if (courseId) {
            courseDoc = await Course.findById(courseId);
            if (courseDoc) {
                // Add college to course's colleges array if not already there
                const isLinked = courseDoc.colleges.some(id => id.toString() === college._id.toString());
                if (!isLinked) {
                    courseDoc.colleges.push(college._id);
                    await courseDoc.save();
                }
            } else {
                console.warn('Course not found:', courseId);
            }
        }

        // Auto-generate Department tree and fixed 12 days per department.
        const { departments } = await ensureDepartmentsAndSchedules(college);

        if (isTrainingDriveEnabled()) {
            try {
                const hierarchy = await ensureCollegeHierarchy({
                    company,
                    course: courseDoc,
                    college,
                });

                if (hierarchy?.companyFolder?.id && company.driveFolderId !== hierarchy.companyFolder.id) {
                    company.driveFolderId = hierarchy.companyFolder.id;
                    company.driveFolderName = hierarchy.companyFolder.name;
                    company.driveFolderLink = hierarchy.companyFolder.link;
                    await company.save();
                }

                if (courseDoc && hierarchy?.courseFolder?.id && courseDoc.driveFolderId !== hierarchy.courseFolder.id) {
                    courseDoc.driveFolderId = hierarchy.courseFolder.id;
                    courseDoc.driveFolderName = hierarchy.courseFolder.name;
                    courseDoc.driveFolderLink = hierarchy.courseFolder.link;
                    await courseDoc.save();
                }

                if (hierarchy?.collegeFolder?.id && college.driveFolderId !== hierarchy.collegeFolder.id) {
                    college.driveFolderId = hierarchy.collegeFolder.id;
                    college.driveFolderName = hierarchy.collegeFolder.name;
                    college.driveFolderLink = hierarchy.collegeFolder.link;
                    await college.save();
                }

                const departmentIds = departments.map((dep) => dep._id);
                const daySchedules = departmentIds.length
                    ? await Schedule.find({
                        collegeId: college._id,
                        departmentId: { $in: departmentIds },
                        dayNumber: { $gte: 1, $lte: 12 },
                    }).select('_id departmentId dayNumber dayFolderId dayFolderName dayFolderLink attendanceFolderId geoTagFolderId driveFolderId driveFolderName driveFolderLink')
                    : [];

                const scheduleByDepDay = new Map(
                    daySchedules.map((row) => [`${String(row.departmentId)}-${row.dayNumber}`, row])
                );

                const scheduleUpdates = [];
                for (const dep of departments) {
                    const departmentHierarchy = await ensureDepartmentHierarchy({
                        company,
                        course: courseDoc,
                        college,
                        department: dep,
                        totalDays: 12,
                    });

                    let shouldSaveDepartment = false;
                    if (departmentHierarchy?.departmentFolder?.id && dep.driveFolderId !== departmentHierarchy.departmentFolder.id) {
                        dep.driveFolderId = departmentHierarchy.departmentFolder.id;
                        dep.driveFolderName = departmentHierarchy.departmentFolder.name;
                        dep.driveFolderLink = departmentHierarchy.departmentFolder.link;
                        shouldSaveDepartment = true;
                    }

                    const dayFolders = toDepartmentDayFolders(departmentHierarchy?.dayFoldersByDayNumber || {});
                    if (dayFolders.length) {
                        dep.dayFolders = dayFolders;
                        shouldSaveDepartment = true;
                    }

                    if (shouldSaveDepartment) {
                        await dep.save();
                    }

                    for (let dayNumber = 1; dayNumber <= 12; dayNumber += 1) {
                        const dayFolder = departmentHierarchy?.dayFoldersByDayNumber?.[dayNumber];
                        const schedule = scheduleByDepDay.get(`${String(dep._id)}-${dayNumber}`);
                        if (!schedule || !dayFolder?.id) continue;

                        if (
                            schedule.dayFolderId !== dayFolder.id ||
                            schedule.dayFolderName !== dayFolder.name ||
                            schedule.dayFolderLink !== dayFolder.link ||
                            schedule.attendanceFolderId !== (dayFolder?.attendanceFolder?.id || null) ||
                            schedule.geoTagFolderId !== (dayFolder?.geoTagFolder?.id || null) ||
                            schedule.driveFolderId !== dayFolder.id ||
                            schedule.driveFolderName !== dayFolder.name ||
                            schedule.driveFolderLink !== dayFolder.link
                        ) {
                            scheduleUpdates.push({
                                updateOne: {
                                    filter: { _id: schedule._id },
                                    update: {
                                        $set: {
                                            dayFolderId: dayFolder.id,
                                            dayFolderName: dayFolder.name,
                                            dayFolderLink: dayFolder.link,
                                            attendanceFolderId: dayFolder?.attendanceFolder?.id || null,
                                            attendanceFolderName: dayFolder?.attendanceFolder?.name || null,
                                            attendanceFolderLink: dayFolder?.attendanceFolder?.link || null,
                                            geoTagFolderId: dayFolder?.geoTagFolder?.id || null,
                                            geoTagFolderName: dayFolder?.geoTagFolder?.name || null,
                                            geoTagFolderLink: dayFolder?.geoTagFolder?.link || null,
                                            driveFolderId: dayFolder.id,
                                            driveFolderName: dayFolder.name,
                                            driveFolderLink: dayFolder.link,
                                        },
                                    },
                                },
                            });
                        }
                    }
                }

                if (scheduleUpdates.length) {
                    await Schedule.bulkWrite(scheduleUpdates, { ordered: false });
                }
            } catch (driveError) {
                console.error('[GOOGLE-DRIVE] Failed to create college/department/day hierarchy:', driveError.message);
            }
        }

        res.status(201).json(college);
    } catch (error) {
        console.error(error);
        const fs = require('fs');
        fs.appendFileSync('error_log.txt', `${new Date().toISOString()} - Error in POST /api/colleges: ${error.stack}\n`);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// PUT /api/colleges/:id - Update a college
router.put('/:id', authenticate, isSPOCAdmin, async (req, res) => {
    try {
        const { Company } = require('../models');

        // Build query based on role
        const query = { _id: req.params.id };

        if (req.user.role === 'SPOCAdmin') {
            // For SPOC Admin, ensure they own the company associated with the college
            const company = await Company.findOne({ userId: req.user.id });
            if (company) {
                query.companyId = company._id;
            } else {
                return res.status(403).json({ message: 'No company assigned to SPOC Admin' });
            }
        }
        // SuperAdmin can access any college (no extra query params needed)

        const college = await College.findOne(query);

        if (!college) {
            return res.status(404).json({ message: 'College not found or access denied' });
        }

        const updatePayload = { ...req.body };
        const location = updatePayload.location || {};
        const resolvedMapUrl = updatePayload.mapUrl !== undefined
            ? ((typeof updatePayload.mapUrl === 'string' && updatePayload.mapUrl.trim())
                ? updatePayload.mapUrl.trim()
                : null)
            : undefined;
        const urlCoordinates = resolvedMapUrl ? extractCoordinatesFromMapUrl(resolvedMapUrl) : null;

        const resolvedAddress = updatePayload.address ?? location.address;
        const hasFlatLat = updatePayload.latitude !== undefined;
        const hasFlatLng = updatePayload.longitude !== undefined;
        const hasNestedLat = location.lat !== undefined;
        const hasNestedLng = location.lng !== undefined;

        const resolvedLatitude = hasFlatLat
            ? toNullableNumber(updatePayload.latitude)
            : (hasNestedLat
                ? toNullableNumber(location.lat)
                : (urlCoordinates ? urlCoordinates.lat : undefined));
        const resolvedLongitude = hasFlatLng
            ? toNullableNumber(updatePayload.longitude)
            : (hasNestedLng
                ? toNullableNumber(location.lng)
                : (urlCoordinates ? urlCoordinates.lng : undefined));
        const resolvedSpocName = updatePayload.spocName || updatePayload.principalName;
        const resolvedSpocPhone = updatePayload.spocPhone || updatePayload.phone;
        const resolvedDepartment = updatePayload.department !== undefined
            ? ((typeof updatePayload.department === 'string' && updatePayload.department.trim())
                ? updatePayload.department.trim()
                : 'General')
            : undefined;

        Object.assign(college, updatePayload);

        if (resolvedAddress !== undefined) {
            college.address = resolvedAddress;
        }
        if (resolvedLatitude !== undefined) {
            college.latitude = resolvedLatitude;
        }
        if (resolvedLongitude !== undefined) {
            college.longitude = resolvedLongitude;
        }
        if (resolvedSpocName !== undefined) {
            college.spocName = resolvedSpocName;
            college.principalName = resolvedSpocName;
        }
        if (resolvedSpocPhone !== undefined) {
            college.spocPhone = resolvedSpocPhone;
            college.phone = resolvedSpocPhone;
        }
        if (resolvedMapUrl !== undefined) {
            college.mapUrl = resolvedMapUrl;
        }
        if (resolvedDepartment !== undefined) {
            college.department = resolvedDepartment;
        }

        // Normalize legacy nested location for backward compatibility
        college.location = {
            address: college.address ?? null,
            lat: college.latitude ?? null,
            lng: college.longitude ?? null,
            mapUrl: college.mapUrl ?? null
        };

        await college.save();
        await syncCollegeLocationToSchedules(college._id, college);
        await ensureDepartmentsAndSchedules(college);
        res.json(college);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
});

// DELETE /api/colleges/:id - Delete a college
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const college = await College.findById(req.params.id);

        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }

        await cascadeDeleteCollegesByIds([college._id]);
        res.json({ message: 'College and related departments/days deleted successfully' });
    } catch (error) {
        console.error('Error deleting college:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// POST /api/colleges/:id/assign-trainers - Assign trainers to college with schedules
router.post('/:id/assign-trainers', authenticate, isSPOCAdmin, async (req, res) => {
    try {
        const { trainers } = req.body; // Array of { trainerId, schedules: [...] }
        const { Schedule } = require('../models');
        const { notifyTrainerSchedule } = require('../services/notificationService');

        const college = await College.findOne({
            _id: req.params.id,
            companyId: req.user.id
        });

        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }

        const notificationResults = [];

        for (const trainerData of trainers) {
            // Get trainer details with user information
            const trainer = await Trainer.findById(trainerData.trainerId)
                .populate('userId', 'name email');

            if (!trainer) {
                console.warn(`Trainer ${trainerData.trainerId} not found`);
                continue;
            }

            // Assign trainer to college (add to trainers array if not already present)
            if (!college.trainers.includes(trainer._id)) {
                college.trainers.push(trainer._id);
                await college.save();
            }

            // Create schedules if provided
            const createdSchedules = [];
            if (trainerData.schedules && trainerData.schedules.length > 0) {
                for (const schedule of trainerData.schedules) {
                    const newSchedule = await Schedule.create({
                        trainerId: trainer._id,
                        collegeId: college._id,
                        dayOfWeek: schedule.dayOfWeek,
                        startTime: schedule.startTime,
                        endTime: schedule.endTime,
                        subject: schedule.subject || null
                    });
                    createdSchedules.push(newSchedule);
                }
            }

            // Send notifications if schedules were created
            if (createdSchedules.length > 0) {
                const trainerInfo = {
                    name: trainer.userId?.name || 'Trainer',
                    phone: trainer.phone
                };

                const notificationResult = await notifyTrainerSchedule(
                    trainerInfo,
                    college,
                    createdSchedules
                );

                notificationResults.push({
                    trainerId: trainer._id,
                    trainerName: trainerInfo.name,
                    notifications: notificationResult
                });
            }
        }

        res.json({
            message: 'Trainers assigned successfully',
            notifications: notificationResults
        });
    } catch (error) {
        console.error('Assign trainers error:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST /api/colleges/:id/upload-attendance - Upload student attendance excel
router.post('/:id/upload-attendance', authenticate, isSPOCAdmin, (req, res, next) => {
    // Wrap upload middleware to handle errors
    const upload = require('../middleware/upload');
    const uploadSingle = upload.single('file'); // 'file' matches the formData key from frontend

    uploadSingle(req, res, async (err) => {
        if (err) {
            console.error('Multer error:', err);
            return res.status(400).json({ message: 'File upload failed', error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        const xlsx = require('xlsx');
        const path = require('path');
        const fs = require('fs');

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const college = await College.findById(req.params.id);
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }

        // Store the file name in the college record
        // The middleware saves files to uploads/trainer-documents
        college.studeNDAttendanceExcelUrl = req.file.filename; 

        // OPTIONAL: Parse the Excel here if needed
        // const workbook = xlsx.readFile(req.file.path);
        // const sheetName = workbook.SheetNames[0];
        // const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
        // console.log(`Parsed ${data.length} rows from Excel`);
        // We could also create Student records here if that logic existed

        await college.save();

        res.json({ 
            message: 'File uploaded successfully', 
            fileName: req.file.filename,
            // parsedRows: data.length 
        });

    } catch (error) {
        console.error('Error in upload-attendance:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

module.exports = router;
