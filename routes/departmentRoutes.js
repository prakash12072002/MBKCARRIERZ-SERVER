const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeDepartmentPermission } = require('../middleware/departmentAccessMiddleware');
const { Department, Schedule, Attendance, College, Company, Course, UserDepartmentAccess } = require('../models');
const { cascadeDeleteDepartmentsByIds } = require('../services/hierarchyDeleteService');
const {
    ensureDepartmentHierarchy,
    isTrainingDriveEnabled,
    toDepartmentDayFolders,
} = require('../services/googleDriveTrainingHierarchyService');
const {
    normalizeRole,
    parseDepartments,
    getUserCompanyIds,
    getUserCollegeIds,
} = require('../utils/departmentAccess');

const toId = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const FULL_PERMISSIONS = ['view', 'edit', 'attendance', 'finance'];

const normalizePermissions = (permissions = []) => {
    if (!Array.isArray(permissions) || !permissions.length) return ['view'];
    return [...new Set(
        permissions
            .map((value) => String(value || '').trim().toLowerCase())
            .filter(Boolean)
    )];
};

const hasViewPermission = (permissions = []) => {
    const normalized = normalizePermissions(permissions);
    return normalized.includes('view') || normalized.includes('*') || normalized.includes('all');
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

const buildDocsStatusLabel = (attendance) => hasAttendanceDocs(attendance) ? 'Docs Uploaded' : 'Pending';

const buildGeoStatusLabel = (attendance) => {
    const normalized = String(attendance?.geoVerificationStatus || '').trim().toLowerCase();
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

const buildDayUploadStatus = (schedule, attendance) => {
    const attendanceUploaded = typeof schedule?.attendanceUploaded === 'boolean'
        ? schedule.attendanceUploaded
        : hasAttendanceDocs(attendance);
    const geoTagUploaded = typeof schedule?.geoTagUploaded === 'boolean'
        ? schedule.geoTagUploaded
        : hasGeoTagDocs(attendance);
    const persistedDayStatus = normalizeDayStatus(schedule?.dayStatus);
    if (persistedDayStatus) {
        return {
            attendanceUploaded,
            geoTagUploaded,
            statusCode: persistedDayStatus,
            statusLabel: persistedDayStatus === 'completed'
                ? 'Completed'
                : persistedDayStatus === 'pending'
                    ? 'Pending'
                    : 'Not Assigned',
        };
    }
    const normalizedScheduleStatus = String(schedule?.status || '').trim().toLowerCase();
    const hasTrainerAssigned = Boolean(schedule?.trainerId);
    const attendanceVerified = String(attendance?.verificationStatus || '').trim().toLowerCase() === 'approved';
    const geoVerified = String(attendance?.geoVerificationStatus || '').trim().toLowerCase() === 'approved';

    if (!hasTrainerAssigned || normalizedScheduleStatus === 'cancelled') {
        return {
            attendanceUploaded,
            geoTagUploaded,
            statusCode: 'not_assigned',
            statusLabel: 'Not Assigned',
        };
    }

    if (attendanceUploaded && geoTagUploaded && attendanceVerified && geoVerified) {
        return {
            attendanceUploaded,
            geoTagUploaded,
            statusCode: 'completed',
            statusLabel: 'Completed',
        };
    }

    return {
        attendanceUploaded,
        geoTagUploaded,
        statusCode: 'pending',
        statusLabel: 'Pending',
    };
};

const defaultPermissionsByRole = (role) => {
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === 'superadmin' || normalizedRole === 'admin') return [...FULL_PERMISSIONS];
    if (normalizedRole === 'trainer') return ['view', 'attendance'];
    if (normalizedRole === 'accouNDAnt') return ['view', 'finance'];
    if (normalizedRole === 'companyadmin' || normalizedRole === 'company' || normalizedRole === 'spocadmin' || normalizedRole === 'collegeadmin') {
        return ['view', 'edit'];
    }
    return ['view'];
};

const ensureDepartmentsForCollege = async (college) => {
    const collegeId = toId(college?._id);
    if (!collegeId) return [];

    const departmentNames = parseDepartments(college.department);
    if (!departmentNames.length) return [];

    const existing = await Department.find({ collegeId }).select('_id name');
    const existingNameSet = new Set(
        existing.map((dep) => String(dep.name || '').trim().toLowerCase()).filter(Boolean)
    );

    const inserts = departmentNames
        .filter((name) => !existingNameSet.has(String(name).trim().toLowerCase()))
        .map((name) => ({
            name,
            companyId: college.companyId || null,
            courseId: college.courseId || null,
            collegeId: college._id,
            isActive: true,
        }));

    if (inserts.length) {
        try {
            await Department.insertMany(inserts, { ordered: false });
        } catch (error) {
            // Ignore duplicate race conditions from concurrent requests.
            if (error?.code !== 11000 && error?.name !== 'BulkWriteError') {
                throw error;
            }
        }

        // Auto-generate 12 fixed schedule days for each newly created department
        const newDepartments = await Department.find({
            collegeId,
            name: { $in: inserts.map((i) => i.name) },
        });

        const dayFoldersByDepartmentId = new Map();
        if (isTrainingDriveEnabled()) {
            const companyDoc = college?.companyId
                ? await Company.findById(college.companyId).select('name driveFolderId driveFolderName driveFolderLink')
                : null;
            const courseDoc = college?.courseId
                ? await Course.findById(college.courseId).select('title driveFolderId driveFolderName driveFolderLink')
                : null;

            for (const dept of newDepartments) {
                try {
                    const hierarchy = await ensureDepartmentHierarchy({
                        company: companyDoc || { _id: college.companyId, name: `Company_${college.companyId}` },
                        course: courseDoc || null,
                        college,
                        department: dept,
                        totalDays: 12,
                    });

                    let shouldSaveDepartment = false;
                    if (hierarchy?.departmentFolder?.id) {
                        dept.driveFolderId = hierarchy.departmentFolder.id;
                        dept.driveFolderName = hierarchy.departmentFolder.name;
                        dept.driveFolderLink = hierarchy.departmentFolder.link;
                        shouldSaveDepartment = true;
                    }

                    const dayFolders = toDepartmentDayFolders(hierarchy?.dayFoldersByDayNumber || {});
                    if (dayFolders.length) {
                        dept.dayFolders = dayFolders;
                        shouldSaveDepartment = true;
                    }

                    if (shouldSaveDepartment) {
                        await dept.save();
                    }

                    dayFoldersByDepartmentId.set(String(dept._id), hierarchy?.dayFoldersByDayNumber || {});
                } catch (driveError) {
                    console.error('[GOOGLE-DRIVE] Failed to create hierarchy for auto-created department:', driveError.message);
                }
            }
        }

        const scheduleInserts = [];
        for (const dept of newDepartments) {
            // Only create schedules if none exist yet for this department
            const existingScheduleCount = await Schedule.countDocuments({ departmentId: dept._id });
            if (existingScheduleCount > 0) continue;

            for (let day = 1; day <= 12; day++) {
                const dayFolder = dayFoldersByDepartmentId.get(String(dept._id))?.[day] || null;
                scheduleInserts.push({
                    collegeId: dept.collegeId,
                    companyId: dept.companyId || null,
                    courseId: dept.courseId || null,
                    departmentId: dept._id,
                    dayNumber: day,
                    startTime: '09:00',
                    endTime: '18:00',
                    status: 'scheduled',
                    isActive: true,
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
        }

        if (scheduleInserts.length) {
            try {
                await Schedule.insertMany(scheduleInserts, { ordered: false });
            } catch (error) {
                if (error?.code !== 11000 && error?.name !== 'BulkWriteError') {
                    console.error('Error auto-creating 12-day schedules:', error);
                }
            }
        }
    }

    return Department.find({ collegeId }).sort({ name: 1 });
};

const canAccessCollege = (user, college) => {
    const role = normalizeRole(user?.role);
    if (role === 'superadmin' || role === 'admin') return true;

    if (role === 'companyadmin' || role === 'company' || role === 'spocadmin') {
        const companyIds = getUserCompanyIds(user);
        if (!companyIds.length) return false;
        return companyIds.includes(toId(college?.companyId));
    }

    if (role === 'collegeadmin') {
        const collegeIds = getUserCollegeIds(user);
        return collegeIds.includes(toId(college?._id));
    }

    if (role === 'trainer' || role === 'accouNDAnt') return false;

    return false;
};

router.get('/my', authenticate, async (req, res) => {
    try {
        const role = normalizeRole(req.user?.role);
        const { companyId, courseId, collegeId } = req.query;

        const baseFilter = { isActive: { $ne: false } };
        if (companyId) baseFilter.companyId = companyId;
        if (courseId) baseFilter.courseId = courseId;
        if (collegeId) baseFilter.collegeId = collegeId;

        if (collegeId) {
            const college = await College.findById(collegeId).select('department companyId courseId');
            if (college && canAccessCollege(req.user, college)) {
                await ensureDepartmentsForCollege(college);
            }
        }

        const userId = req.user.id || req.user._id;
        const accessRows = await UserDepartmentAccess.find({ userId })
            .select('departmentId permissions');

        const permissionByDepartmentId = new Map();
        accessRows.forEach((row) => {
            const depId = toId(row.departmentId);
            if (!depId) return;
            permissionByDepartmentId.set(depId, normalizePermissions(row.permissions));
        });

        let departments = [];
        if (role === 'superadmin' || role === 'admin') {
            departments = await Department.find(baseFilter).sort({ name: 1 });
        } else if (role === 'companyadmin' || role === 'company' || role === 'spocadmin') {
            const companyIds = getUserCompanyIds(req.user);
            if (!companyIds.length) {
                return res.json({ success: true, departments: [] });
            }

            if (companyId && !companyIds.includes(String(companyId))) {
                return res.json({ success: true, departments: [] });
            }

            departments = await Department.find({
                ...baseFilter,
                companyId: { $in: companyIds },
            }).sort({ name: 1 });
        } else if (role === 'collegeadmin') {
            const collegeIds = getUserCollegeIds(req.user);
            if (!collegeIds.length) {
                return res.json({ success: true, departments: [] });
            }

            if (collegeId && !collegeIds.includes(String(collegeId))) {
                return res.json({ success: true, departments: [] });
            }

            departments = await Department.find({
                ...baseFilter,
                collegeId: { $in: collegeIds },
            }).sort({ name: 1 });
        } else {
            const allowedDepartmentIds = [...permissionByDepartmentId.entries()]
                .filter(([, permissions]) => hasViewPermission(permissions))
                .map(([departmentId]) => departmentId);

            if (!allowedDepartmentIds.length) {
                return res.json({ success: true, departments: [] });
            }

            departments = await Department.find({
                ...baseFilter,
                _id: { $in: allowedDepartmentIds },
            }).sort({ name: 1 });
        }

        const payload = departments.map((dep) => ({
            _id: dep._id,
            name: dep.name,
            companyId: dep.companyId,
            courseId: dep.courseId,
            collegeId: dep.collegeId,
            isAssigned: permissionByDepartmentId.has(String(dep._id)),
            permissions: permissionByDepartmentId.get(String(dep._id)) || defaultPermissionsByRole(role),
        }));

        return res.json({
            success: true,
            departments: payload,
        });
    } catch (error) {
        console.error('Error fetching my departments:', error);
        return res.status(500).json({ message: 'Server error' });
    }
});

// POST /api/departments - Create a new department for a college
router.post('/', authenticate, async (req, res) => {
    try {
        const { name, collegeId, companyId, courseId } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Department name is required' });
        }
        if (!collegeId) {
            return res.status(400).json({ message: 'College ID is required' });
        }

        const college = await College.findById(collegeId);
        if (!college) {
            return res.status(404).json({ message: 'College not found' });
        }

        if (!canAccessCollege(req.user, college)) {
            return res.status(403).json({ message: 'Access denied for this college' });
        }

        // Check for duplicate department name in the same college
        const existing = await Department.findOne({
            collegeId,
            name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
        });
        if (existing) {
            return res.status(409).json({ message: `Department "${name.trim()}" already exists in this college` });
        }

        const department = await Department.create({
            name: name.trim(),
            collegeId,
            companyId: companyId || college.companyId || null,
            courseId: courseId || college.courseId || null,
            isActive: true,
        });

        let dayFoldersByDayNumber = {};
        if (isTrainingDriveEnabled()) {
            try {
                const companyDoc = (department.companyId || college.companyId)
                    ? await Company.findById(department.companyId || college.companyId).select('name driveFolderId driveFolderName driveFolderLink')
                    : null;
                const courseDoc = (department.courseId || college.courseId)
                    ? await Course.findById(department.courseId || college.courseId).select('title driveFolderId driveFolderName driveFolderLink')
                    : null;

                const hierarchy = await ensureDepartmentHierarchy({
                    company: companyDoc || { _id: department.companyId || college.companyId, name: `Company_${department.companyId || college.companyId}` },
                    course: courseDoc || null,
                    college,
                    department,
                    totalDays: 12,
                });

                let shouldSaveDepartment = false;
                if (hierarchy?.departmentFolder?.id) {
                    department.driveFolderId = hierarchy.departmentFolder.id;
                    department.driveFolderName = hierarchy.departmentFolder.name;
                    department.driveFolderLink = hierarchy.departmentFolder.link;
                    shouldSaveDepartment = true;
                }

                const dayFolders = toDepartmentDayFolders(hierarchy?.dayFoldersByDayNumber || {});
                if (dayFolders.length) {
                    department.dayFolders = dayFolders;
                    shouldSaveDepartment = true;
                }

                if (shouldSaveDepartment) {
                    await department.save();
                }

                dayFoldersByDayNumber = hierarchy?.dayFoldersByDayNumber || {};
            } catch (driveError) {
                console.error('[GOOGLE-DRIVE] Failed to create hierarchy for department:', driveError.message);
            }
        }

        // Also update the college's department string to include the new department
        const currentDepts = (college.department || '')
            .split(/[|,/]/)
            .map((d) => d.trim())
            .filter(Boolean);
        if (!currentDepts.some((d) => d.toLowerCase() === name.trim().toLowerCase())) {
            currentDepts.push(name.trim());
            college.department = currentDepts.join(' | ');
            await college.save();
        }

        // Auto-generate 12 schedule days for the new department
        const scheduleInserts = [];
        for (let day = 1; day <= 12; day++) {
            const dayFolder = dayFoldersByDayNumber?.[day] || null;
            scheduleInserts.push({
                collegeId: department.collegeId,
                companyId: department.companyId || null,
                courseId: department.courseId || null,
                departmentId: department._id,
                dayNumber: day,
                startTime: '09:00',
                endTime: '18:00',
                status: 'scheduled',
                isActive: true,
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
        if (scheduleInserts.length) {
            try {
                await Schedule.insertMany(scheduleInserts, { ordered: false });
            } catch (err) {
                if (err?.code !== 11000 && err?.name !== 'BulkWriteError') {
                    console.error('Error auto-creating schedules:', err);
                }
            }
        }

        return res.status(201).json({
            success: true,
            department,
        });
    } catch (error) {
        console.error('Error creating department:', error);
        return res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// PUT /api/departments/:id - Rename a department
router.put('/:id', authenticate, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ message: 'Department name is required' });
        }

        const department = await Department.findById(req.params.id);
        if (!department) {
            return res.status(404).json({ message: 'Department not found' });
        }

        // Check for duplicate name in same college
        const duplicate = await Department.findOne({
            collegeId: department.collegeId,
            name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
            _id: { $ne: department._id },
        });
        if (duplicate) {
            return res.status(409).json({ message: `Department "${name.trim()}" already exists in this college` });
        }

        const oldName = department.name;
        department.name = name.trim();
        await department.save();

        // Update the college's department string
        const college = await College.findById(department.collegeId);
        if (college && college.department) {
            const parts = college.department.split(/[|,/]/).map((d) => d.trim()).filter(Boolean);
            const idx = parts.findIndex((d) => d.toLowerCase() === oldName.toLowerCase());
            if (idx !== -1) {
                parts[idx] = name.trim();
                college.department = parts.join(' | ');
                await college.save();
            }
        }

        if (isTrainingDriveEnabled() && college) {
            try {
                const companyDoc = (department.companyId || college.companyId)
                    ? await Company.findById(department.companyId || college.companyId).select('name driveFolderId driveFolderName driveFolderLink')
                    : null;
                const courseDoc = (department.courseId || college.courseId)
                    ? await Course.findById(department.courseId || college.courseId).select('title driveFolderId driveFolderName driveFolderLink')
                    : null;
                const totalDays = Math.max(12, await Schedule.countDocuments({ departmentId: department._id }));
                const hierarchy = await ensureDepartmentHierarchy({
                    company: companyDoc || { _id: department.companyId || college.companyId, name: `Company_${department.companyId || college.companyId}` },
                    course: courseDoc || null,
                    college,
                    department,
                    totalDays,
                });

                if (hierarchy?.companyFolder?.id && companyDoc && companyDoc.driveFolderId !== hierarchy.companyFolder.id) {
                    companyDoc.driveFolderId = hierarchy.companyFolder.id;
                    companyDoc.driveFolderName = hierarchy.companyFolder.name;
                    companyDoc.driveFolderLink = hierarchy.companyFolder.link;
                    await companyDoc.save();
                }

                if (hierarchy?.courseFolder?.id && courseDoc && courseDoc.driveFolderId !== hierarchy.courseFolder.id) {
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

                let shouldSaveDepartment = false;
                if (hierarchy?.departmentFolder?.id && department.driveFolderId !== hierarchy.departmentFolder.id) {
                    department.driveFolderId = hierarchy.departmentFolder.id;
                    department.driveFolderName = hierarchy.departmentFolder.name;
                    department.driveFolderLink = hierarchy.departmentFolder.link;
                    shouldSaveDepartment = true;
                }

                const dayFolders = toDepartmentDayFolders(hierarchy?.dayFoldersByDayNumber || {});
                if (dayFolders.length) {
                    department.dayFolders = dayFolders;
                    shouldSaveDepartment = true;
                }

                if (shouldSaveDepartment) {
                    await department.save();
                }

                const schedules = await Schedule.find({ departmentId: department._id }).select(
                    '_id dayNumber dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink'
                );

                const scheduleUpdates = schedules
                    .map((schedule) => {
                        const dayFolder = hierarchy?.dayFoldersByDayNumber?.[schedule.dayNumber];
                        if (!dayFolder?.id) return null;

                        if (
                            schedule.dayFolderId === dayFolder.id &&
                            schedule.dayFolderName === (dayFolder.name || null) &&
                            schedule.dayFolderLink === (dayFolder.link || null) &&
                            schedule.attendanceFolderId === (dayFolder.attendanceFolder?.id || null) &&
                            schedule.attendanceFolderName === (dayFolder.attendanceFolder?.name || null) &&
                            schedule.attendanceFolderLink === (dayFolder.attendanceFolder?.link || null) &&
                            schedule.geoTagFolderId === (dayFolder.geoTagFolder?.id || null) &&
                            schedule.geoTagFolderName === (dayFolder.geoTagFolder?.name || null) &&
                            schedule.geoTagFolderLink === (dayFolder.geoTagFolder?.link || null) &&
                            schedule.driveFolderId === dayFolder.id &&
                            schedule.driveFolderName === (dayFolder.name || null) &&
                            schedule.driveFolderLink === (dayFolder.link || null)
                        ) {
                            return null;
                        }

                        return {
                            updateOne: {
                                filter: { _id: schedule._id },
                                update: {
                                    $set: {
                                        dayFolderId: dayFolder.id,
                                        dayFolderName: dayFolder.name || null,
                                        dayFolderLink: dayFolder.link || null,
                                        attendanceFolderId: dayFolder.attendanceFolder?.id || null,
                                        attendanceFolderName: dayFolder.attendanceFolder?.name || null,
                                        attendanceFolderLink: dayFolder.attendanceFolder?.link || null,
                                        geoTagFolderId: dayFolder.geoTagFolder?.id || null,
                                        geoTagFolderName: dayFolder.geoTagFolder?.name || null,
                                        geoTagFolderLink: dayFolder.geoTagFolder?.link || null,
                                        driveFolderId: dayFolder.id,
                                        driveFolderName: dayFolder.name || null,
                                        driveFolderLink: dayFolder.link || null,
                                    }
                                }
                            }
                        };
                    })
                    .filter(Boolean);

                if (scheduleUpdates.length) {
                    await Schedule.bulkWrite(scheduleUpdates, { ordered: false });
                }
            } catch (driveError) {
                console.error('[GOOGLE-DRIVE] Failed to sync department hierarchy:', driveError.message);
            }
        }

        return res.json({ success: true, department });
    } catch (error) {
        console.error('Error updating department:', error);
        return res.status(500).json({ message: 'Server error' });
    }
});

// DELETE /api/departments/:id - Delete a department
router.delete('/:id', authenticate, async (req, res) => {
    try {
        const department = await Department.findById(req.params.id);
        if (!department) {
            return res.status(404).json({ message: 'Department not found' });
        }

        // Update the college's department string
        const college = await College.findById(department.collegeId);
        if (college && college.department) {
            const parts = college.department.split(/[|,/]/).map((d) => d.trim()).filter(Boolean);
            const filtered = parts.filter((d) => d.toLowerCase() !== department.name.toLowerCase());
            college.department = filtered.length ? filtered.join(' | ') : 'General';
            await college.save();
        }

        await cascadeDeleteDepartmentsByIds([department._id]);

        return res.json({ success: true, message: 'Department deleted successfully' });
    } catch (error) {
        console.error('Error deleting department:', error);
        return res.status(500).json({ message: 'Server error' });
    }
});

const getDepartmentDays = async (req, res) => {
    try {
        const { departmentId } = req.params;

        const department = await Department.findById(departmentId)
            .populate('companyId', 'name companyCode')
            .populate('courseId', 'title name')
            .populate('collegeId', 'name city zone');

        if (!department) {
            return res.status(404).json({ message: 'Department not found' });
        }

        const schedules = await Schedule.find({
            collegeId: department.collegeId?._id || department.collegeId,
            departmentId: department._id,
            isActive: true,
        })
            .sort({ dayNumber: 1, scheduledDate: 1 })
            .populate({
                path: 'trainerId',
                select: 'trainerId phone',
                populate: { path: 'userId', select: 'name email profilePicture' },
            });

        const scheduleIds = schedules.map((schedule) => schedule._id);
        const attendanceDocs = await Attendance.find({ scheduleId: { $in: scheduleIds } })
            .sort({ createdAt: -1 })
            .select('scheduleId status verificationStatus geoVerificationStatus approvedBy latitude longitude studentsPresent studentsAbsent checkInTime checkOutTime attendancePdfUrl attendanceExcelUrl studentsPhotoUrl signatureUrl checkOutGeoImageUrl checkOutGeoImageUrls activityPhotos activityVideos');

        const attendanceBySchedule = new Map();
        for (const attendance of attendanceDocs) {
            const key = String(attendance.scheduleId);
            if (!attendanceBySchedule.has(key)) {
                attendanceBySchedule.set(key, attendance);
            }
        }

        const days = schedules.map((schedule) => {
            const attendance = attendanceBySchedule.get(String(schedule._id));
            const dayUploadStatus = buildDayUploadStatus(schedule, attendance);

            return {
                id: schedule._id,
                dayNumber: schedule.dayNumber,
                name: schedule.scheduledDate
                    ? new Date(schedule.scheduledDate).toLocaleDateString(undefined, { weekday: 'long' })
                    : `Day ${schedule.dayNumber}`,
                date: schedule.scheduledDate,
                startTime: schedule.startTime,
                endTime: schedule.endTime,
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
                trainerName: schedule.trainerId?.userId?.name || 'Not Assigned',
                trainerId: schedule.trainerId?._id || null,
                status: dayUploadStatus.statusLabel,
                statusCode: dayUploadStatus.statusCode,
                attendanceUploaded: dayUploadStatus.attendanceUploaded,
                geoTagUploaded: dayUploadStatus.geoTagUploaded,
                verificationStatus: attendance?.verificationStatus || 'Pending',
                geoVerificationStatus: attendance?.geoVerificationStatus || 'pending',
                hasAttendanceDocs: hasAttendanceDocs(attendance),
                hasGeoTagDocs: hasGeoTagDocs(attendance),
                docsStatusLabel: buildDocsStatusLabel(attendance),
                geoStatusLabel: buildGeoStatusLabel(attendance),
                approvedBy: attendance?.approvedBy || null,
                geoTag: attendance?.latitude != null && attendance?.longitude != null
                    ? `${attendance.latitude}, ${attendance.longitude}`
                    : null,
                studentsPresent: attendance?.studentsPresent || 0,
                studentsAbsent: attendance?.studentsAbsent || 0,
                checkInTime: attendance?.checkInTime || null,
                checkOutTime: attendance?.checkOutTime || null,
            };
        });

        return res.json({
            success: true,
            department,
            days,
        });
    } catch (error) {
        console.error('Error fetching department days:', error);
        return res.status(500).json({ message: 'Server error' });
    }
};

router.get('/:departmentId/days', authenticate, authorizeDepartmentPermission('view'), getDepartmentDays);

module.exports = router;
