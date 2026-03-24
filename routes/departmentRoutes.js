const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { authorizeDepartmentPermission } = require('../middleware/departmentAccessMiddleware');
const { Department, Schedule, Attendance, College, UserDepartmentAccess } = require('../models');
const { cascadeDeleteDepartmentsByIds } = require('../services/hierarchyDeleteService');
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
        const newDepartmentNames = inserts.map((i) => String(i.name).trim().toLowerCase());
        const newDepartments = await Department.find({
            collegeId,
            name: { $in: inserts.map((i) => i.name) },
        });

        const scheduleInserts = [];
        for (const dept of newDepartments) {
            // Only create schedules if none exist yet for this department
            const existingScheduleCount = await Schedule.countDocuments({ departmentId: dept._id });
            if (existingScheduleCount > 0) continue;

            for (let day = 1; day <= 12; day++) {
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
            .select('scheduleId status verificationStatus approvedBy latitude longitude studentsPresent studentsAbsent checkInTime checkOutTime');

        const attendanceBySchedule = new Map();
        for (const attendance of attendanceDocs) {
            const key = String(attendance.scheduleId);
            if (!attendanceBySchedule.has(key)) {
                attendanceBySchedule.set(key, attendance);
            }
        }

        const days = schedules.map((schedule) => {
            const attendance = attendanceBySchedule.get(String(schedule._id));
            const status = attendance?.status === 'Present' ? 'Completed' : 'Pending';

            return {
                id: schedule._id,
                dayNumber: schedule.dayNumber,
                name: schedule.scheduledDate
                    ? new Date(schedule.scheduledDate).toLocaleDateString(undefined, { weekday: 'long' })
                    : `Day ${schedule.dayNumber}`,
                date: schedule.scheduledDate,
                startTime: schedule.startTime,
                endTime: schedule.endTime,
                trainerName: schedule.trainerId?.userId?.name || 'Not Assigned',
                trainerId: schedule.trainerId?._id || null,
                status,
                verificationStatus: attendance?.verificationStatus || 'Pending',
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
