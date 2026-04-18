const mongoose = require("mongoose");
const Schedule = require("../../models/Schedule");
const Attendance = require("../../models/Attendance");
const { normalizeAttendanceVerificationStatus } = require("../../utils/statusNormalizer");

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

const normalizeVerificationStatus = normalizeAttendanceVerificationStatus;

const buildDocsStatusLabel = (attendance) => hasAttendanceDocs(attendance) ? 'Docs Uploaded' : 'Pending';

const buildGeoStatusLabel = (attendance) => {
    const normalized = normalizeVerificationStatus(attendance?.geoVerificationStatus);
    if (normalized === 'approved') return 'Completed';
    return 'Pending';
};

const normalizeDayStatus = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'completed') return 'completed';
    if (normalized === 'pending') return 'pending';
    if (normalized === 'not_assigned') return 'not_assigned';
    return null;
};

const buildPersistedDayStatus = (schedule, attendance) => {
    const attendanceUploaded = hasAttendanceDocs(attendance);
    const geoTagUploaded = hasGeoTagDocs(attendance);
    const hasTrainerAssigned = Boolean(schedule?.trainerId);
    const attendanceVerification = normalizeVerificationStatus(attendance?.verificationStatus, '');
    const geoVerification = normalizeVerificationStatus(attendance?.geoVerificationStatus, '');

    if (!hasTrainerAssigned || String(schedule?.status || '').trim().toLowerCase() === 'cancelled') {
        return {
            attendanceUploaded,
            geoTagUploaded,
            dayStatus: 'not_assigned'
        };
    }

    if (
        attendanceUploaded
        && geoTagUploaded
        && attendanceVerification === 'approved'
        && geoVerification === 'approved'
    ) {
        return {
            attendanceUploaded,
            geoTagUploaded,
            dayStatus: 'completed'
        };
    }

    return {
        attendanceUploaded,
        geoTagUploaded,
        dayStatus: 'pending'
    };
};

const syncScheduleDayState = async ({
    scheduleId,
    schedule = null,
    attendance = null,
    dayStatusOverride = undefined
} = {}) => {
    if (!scheduleId) return null;

    const scheduleDoc = schedule && typeof schedule === 'object' && schedule._id
        ? schedule
        : await Schedule.findById(scheduleId).select('trainerId status attendanceUploaded geoTagUploaded dayStatus');

    if (!scheduleDoc) return null;

    const attendanceDoc = attendance
        || await Attendance.findOne({ scheduleId }).sort({ createdAt: -1 });

    const derivedState = buildPersistedDayStatus(scheduleDoc, attendanceDoc);
    const normalizedOverride = normalizeDayStatus(dayStatusOverride);
    const nextState = {
        attendanceUploaded: derivedState.attendanceUploaded,
        geoTagUploaded: derivedState.geoTagUploaded,
        dayStatus: normalizedOverride || derivedState.dayStatus,
        dayStatusUpdatedAt: new Date()
    };

    const shouldUpdate =
        scheduleDoc.attendanceUploaded !== nextState.attendanceUploaded
        || scheduleDoc.geoTagUploaded !== nextState.geoTagUploaded
        || normalizeDayStatus(scheduleDoc.dayStatus) !== nextState.dayStatus;

    if (shouldUpdate) {
        await Schedule.findByIdAndUpdate(scheduleId, { $set: nextState });
    }

    return nextState;
};

const deriveScheduleLifecycleStatusFromAttendance = (attendance) => {
    const attendanceVerification = normalizeVerificationStatus(attendance?.verificationStatus, '');
    const geoVerification = normalizeVerificationStatus(attendance?.geoVerificationStatus, '');

    if (attendanceVerification !== 'approved') {
        return 'scheduled';
    }

    if (attendanceVerification === 'approved' && geoVerification === 'approved') {
        return 'COMPLETED';
    }

    if (attendanceVerification === 'approved') {
        return 'inprogress';
    }

    return 'inprogress';
};

const syncScheduleLifecycleStatusFromAttendance = async ({ scheduleId, attendance }) => {
    if (!scheduleId || !attendance) return null;
    const nextStatus = deriveScheduleLifecycleStatusFromAttendance(attendance);
    await Schedule.findByIdAndUpdate(scheduleId, { status: nextStatus });
    return nextStatus;
};

const emitAttendanceRealtimeUpdate = (req, payload = {}) => {
    const io = req?.app?.get?.('io');
    if (!io) return;
    io.emit('attendanceUpdate', payload);
};

module.exports = {
    hasAttendanceDocs,
    hasGeoTagDocs,
    normalizeVerificationStatus,
    buildDocsStatusLabel,
    buildGeoStatusLabel,
    normalizeDayStatus,
    buildPersistedDayStatus,
    syncScheduleDayState,
    deriveScheduleLifecycleStatusFromAttendance,
    syncScheduleLifecycleStatusFromAttendance,
    emitAttendanceRealtimeUpdate
};
