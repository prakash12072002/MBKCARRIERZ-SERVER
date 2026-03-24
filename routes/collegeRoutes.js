const express = require('express');
const router = express.Router();
const { College, Trainer, User } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const { cascadeDeleteCollegesByIds } = require('../services/hierarchyDeleteService');
const {
    normalizeRole,
    canAccessCollegeByCompany,
    parseDepartments,
    getUserCompanyIds,
    getUserCollegeIds,
} = require('../utils/departmentAccess');

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

const ensureDepartmentsAndSchedules = async (college, preferredDepartmentName = '') => {
    const { Department, Schedule } = require('../models');
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
            companyId: college.companyId || null,
            courseId: college.courseId || null,
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
    }).select('departmentId dayNumber');

    const existingDayKeys = new Set(
        existingDepartmentSchedules.map((item) => `${String(item.departmentId)}-${item.dayNumber}`)
    );

    const missingSchedules = [];
    departments.forEach((department) => {
        for (let day = 1; day <= 12; day++) {
            const key = `${String(department._id)}-${day}`;
            if (existingDayKeys.has(key)) continue;

            missingSchedules.push({
                dayNumber: day,
                collegeId: college._id,
                departmentId: department._id,
                companyId: college.companyId || null,
                courseId: college.courseId || null,
                status: 'scheduled',
                startTime: '09:00',
                endTime: '17:00',
                subject: `Day ${day} Content`,
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

        // Fetch attendance for each schedule
        const schedulesWithAttendance = await Promise.all(
            schedules.map(async (schedule) => {
                // Find attendance by scheduleId OR by (collegeId + dayNumber) as fallback
                let attendance = await Attendance.findOne({ scheduleId: schedule._id })
                    .sort({ createdAt: -1 })
                    .populate({
                        path: 'trainerId',
                        populate: {
                            path: 'userId',
                            select: 'name profilePicture'
                        }
                    });

                if (!attendance && !schedule.departmentId) {
                    attendance = await Attendance.findOne({
                        collegeId: college._id,
                        dayNumber: schedule.dayNumber
                    }).sort({ createdAt: -1 })
                        .populate({
                            path: 'trainerId',
                            populate: {
                                path: 'userId',
                                select: 'name profilePicture'
                            }
                        });
                }

                return { schedule, attendance };
            })
        );

        // Transform data to match frontend expectation
        const days = schedulesWithAttendance.map(({ schedule, attendance }) => {
            let status = 'Pending';
            if (attendance) {
                status = attendance.status === 'Present' ? 'Completed' : 'Pending';
            } else if (new Date(schedule.scheduledDate) < new Date()) {
                status = 'Pending'; // Past date but no attendance
            }

            return {
                id: schedule._id,
                dayNumber: schedule.dayNumber,
                departmentId: schedule.departmentId || activeDepartment?._id || null,
                departmentName: activeDepartment?.name || null,
                trainerName: schedule.trainerId?.userId?.name || attendance?.trainerId?.userId?.name || 'Unknown',
                trainerPhone: schedule.trainerId?.phone || attendance?.trainerId?.phone || 'N/A',
                trainerId: schedule.trainerId?._id || attendance?.trainerId?._id, // Needed for manual attendance creation
                trainerCustomId: schedule.trainerId?.trainerId || attendance?.trainerId?.trainerId || 'N/A',
                trainerProfilePhoto: schedule.trainerId?.profilePicture || schedule.trainerId?.userId?.profilePicture || attendance?.trainerId?.profilePicture || attendance?.trainerId?.userId?.profilePicture || null,
                syllabusName: attendance?.syllabus || schedule.subject || `Day ${schedule.dayNumber} Content`,
                date: schedule.scheduledDate,
                time: `${schedule.startTime} - ${schedule.endTime}`,
                status: status,
                verificationStatus: attendance ? attendance.verificationStatus : 'Pending',
                geoVerificationStatus: attendance ? attendance.geoVerificationStatus : 'pending',
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

        const { Company, Course } = require('../models');

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
        if (courseId) {
            const course = await Course.findById(courseId);
            if (course) {
                // Add college to course's colleges array if not already there
                const isLinked = course.colleges.some(id => id.toString() === college._id.toString());
                if (!isLinked) {
                    course.colleges.push(college._id);
                    await course.save();
                }
            } else {
                console.warn('Course not found:', courseId);
            }
        }

        // Auto-generate Department tree and fixed 12 days per department.
        await ensureDepartmentsAndSchedules(college);

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
