const express = require('express');
const router = express.Router();
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { uploadAttendance, uploadManual } = require('../config/upload');
const { Attendance, Trainer, College, Schedule, User, Student, Notification } = require('../models');
const { sendTrainingCompletionEmail } = require('../utils/emailService');
const { sendNotification } = require('../services/notificationService');
const haversine = require('haversine-distance');

// Trainer uploads attendance with image and signature
// Check In
router.post('/check-in', uploadAttendance, async (req, res) => {
    try {
        console.log(`[CHECK-IN] Request received at ${new Date().toISOString()}`);
        console.log(`[CHECK-IN] Body keys: ${Object.keys(req.body).join(', ')}`);
        
        const { trainerId, collegeId, scheduleId, dayNumber, checkInTime, latitude, longitude, studentsPresent, studentsAbsent } = req.body;
        let checkInLocation = req.body.checkInLocation;

        if (req.files) {
            console.log(`[CHECK-IN] Files: ${Object.keys(req.files).join(', ')}`);
            if (req.files.attendancePdf) {
                console.log(`[CHECK-IN] PDF: ${req.files.attendancePdf[0].originalname}, Size: ${req.files.attendancePdf[0].size} bytes`);
            }
        }

        // Parse checkInLocation if it's a string (from FormData)
        if (typeof checkInLocation === 'string') {
            try {
                checkInLocation = JSON.parse(checkInLocation);
            } catch (e) {
                console.error('Error parsing checkInLocation:', e);
            }
        }

        // Validate required fields
        if (!trainerId || !collegeId || !scheduleId) {
            return res.status(400).json({
                success: false,
                message: 'Trainer ID, College ID, and Schedule ID are required'
            });
        }

        // 1. DISTANCE VALIDATION (HAIVERSINE)
        try {
            const schedule = await Schedule.findById(scheduleId);
            if (schedule && schedule.collegeLocation && schedule.collegeLocation.lat && schedule.collegeLocation.lng) {
                const currentLat = checkInLocation?.lat || latitude;
                const currentLng = checkInLocation?.lng || longitude;

                if (currentLat && currentLng) {
                    const trainerLoc = { latitude: parseFloat(currentLat), longitude: parseFloat(currentLng) };
                    const collegeLoc = { latitude: schedule.collegeLocation.lat, longitude: schedule.collegeLocation.lng };
                    
                    console.log(`[CHECK-IN] Calculating distance: Trainer(${trainerLoc.latitude}, ${trainerLoc.longitude}) to College(${collegeLoc.latitude}, ${collegeLoc.longitude})`);
                    
                    const distance = haversine(trainerLoc, collegeLoc);

                    if (distance > 300) {
                        console.log(`[Geo-Fencing] Trainer is ${Math.round(distance)}m away (Validation Disabled)`);
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
            console.error('[CHECK-IN] Distance calculation failed (non-blocking):', distError);
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

        // Parse student list if provided
        let students = [];
        if (req.body.studentList) {
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
                console.error('Error parsing studentList:', e);
            }
        }

        // Check for existing attendance (e.g. for re-check-in after rejection)
        console.log(`[CHECK-IN] Querying Attendance for scheduleId: ${scheduleId}`);
        let attendance = await Attendance.findOne({ scheduleId });

        if (attendance) {
            console.log(`[CHECK-IN] Updating existing attendance ID: ${attendance._id}`);
            // Update existing record
            attendance.checkInTime = checkInTime || new Date().toTimeString().split(' ')[0];
            if (attendancePdfUrl) attendance.attendancePdfUrl = attendancePdfUrl;
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
            attendance.status = 'Pending';
            attendance.rejectionReason = undefined; // Clear previous rejection reason
            if (req.body.syllabus) attendance.syllabus = req.body.syllabus; // Save syllabus
            await attendance.save();
        } else {
            console.log(`[CHECK-IN] Creating new attendance record`);
            // Create new attendance record
            attendance = await Attendance.create({
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
                latitude: latitude || null,
                longitude: longitude || null,
                uploadedBy: 'trainer',
                isManualEntry: false,
                status: 'Pending',
                studentsPresent: studentsPresent || 0,
                studentsAbsent: studentsAbsent || 0,
                students: students, // Save student list
                verificationStatus: 'pending',
                syllabus: req.body.syllabus || null // Save syllabus
            });
        }

        console.log(`[CHECK-IN] Updating Schedule ID: ${scheduleId}`);
        // Update Schedule status to 'inprogress' and update subject if provided
        const scheduleUpdate = { status: 'inprogress' };
        if (req.body.syllabus) {
            scheduleUpdate.subject = req.body.syllabus;
        }
        await Schedule.findByIdAndUpdate(scheduleId, scheduleUpdate);

        console.log(`[CHECK-IN] Successful for ID: ${attendance._id}`);

        // Notify Admins
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
                    link: '/spoc/attendance' 
                });
            });
        } catch (notifyErr) {
            console.error('Failed to dispatch check-in notification:', notifyErr);
        }

        res.status(201).json({
            success: true,
            message: 'Check-in successful',
            data: attendance
        });
    } catch (error) {
        console.error('Error during check-in:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check in',
            error: error.message
        });
    }
});

// Check Out
router.post('/check-out', uploadAttendance, async (req, res) => {
    try {
        const { scheduleId, checkOutTime, latitude, longitude, location } = req.body;
        let checkOutLocation = req.body.checkOutLocation;

        // Parse checkInLocation if it's a string (from FormData)
        if (typeof checkOutLocation === 'string') {
            try {
                checkOutLocation = JSON.parse(checkOutLocation);
            } catch (e) {
                console.error('Error parsing checkOutLocation:', e);
            }
        }

        if (!scheduleId) {
            return res.status(400).json({
                success: false,
                message: 'Schedule ID is required'
            });
        }

        // 1. DISTANCE VALIDATION (HAIVERSINE)
        const schedule = await Schedule.findById(scheduleId);
        let distance = null;
        if (schedule && schedule.collegeLocation && schedule.collegeLocation.lat && schedule.collegeLocation.lng) {
            const currentLat = req.body.lat || checkOutLocation?.lat || latitude;
            const currentLng = req.body.lng || checkOutLocation?.lng || longitude;

            if (currentLat && currentLng) {
                const trainerLoc = { latitude: parseFloat(currentLat), longitude: parseFloat(currentLng) };
                const collegeLoc = { latitude: schedule.collegeLocation.lat, longitude: schedule.collegeLocation.lng };
                distance = haversine(trainerLoc, collegeLoc);

                if (distance > 300) {
                    console.log(`[Geo-Fencing] Trainer is ${Math.round(distance)}m away (Validation Disabled)`);
                    // return res.status(400).json({
                    //     success: false,
                    //     message: `Access Denied: You are ${Math.round(distance)} meters away. Please be within 300m of the college campus to check out.`,
                    //     distance: Math.round(distance)
                    // });
                }
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
        const attendance = await Attendance.findOne({ scheduleId });

        if (!attendance) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found for this schedule'
            });
        }

        // Get file paths
        const photoFiles = [...(req.files?.photo || []), ...(req.files?.checkOutGeoImage || [])].slice(0, 3);
        const photoPaths = photoFiles.map(file => file.path);

        // Update attendance
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
        
        // Structured Geo-Tag (ANTI-FAKE)
        attendance.checkOut = {
            time: new Date(),
            location: {
                lat: req.body.lat || checkOutLocation?.lat || latitude,
                lng: req.body.lng || checkOutLocation?.lng || longitude,
                accuracy: req.body.accuracy || checkOutLocation?.accuracy,
                address: req.body.address || checkOutLocation?.address || "College Campus",
                distanceFromCollege: distance
            },
            photos: photoPaths.map(path => ({
                url: path,
                uploadedAt: new Date()
            }))
        };

        // Reset verification status to pending so SPOC can verify the check-out details
        attendance.verificationStatus = 'pending';
        attendance.geoVerificationStatus = 'pending';

        await attendance.save();

        // Update Schedule status to 'completed'
        await Schedule.findByIdAndUpdate(scheduleId, { status: 'completed' });

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
                    link: '/spoc/attendance' 
                });
            });
        } catch (notifyErr) {
            console.error('Failed to dispatch check-out notification:', notifyErr);
        }

        res.json({
            success: true,
            message: 'Check-out successful',
            data: attendance
        });
    } catch (error) {
        console.error('Error during check-out:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check out',
            error: error.message
        });
    }
});

// Get attendance by schedule ID
router.get('/schedule/:scheduleId', async (req, res) => {
    try {
        const attendance = await Attendance.find({ scheduleId: req.params.scheduleId })
            .populate('trainerId')
            .populate('collegeId')
            .populate('verifiedBy', 'id name')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// Get attendance by trainer ID
router.get('/trainer/:trainerId', async (req, res) => {
    try {
        const { month, year } = req.query;
        let filter = { trainerId: req.params.trainerId };

        if (month && year) {
            const startDate = new Date(year, month - 1, 1);
            const endDate = new Date(year, month, 0);
            filter.date = { $gte: startDate, $lte: endDate };
        }

        const attendance = await Attendance.find(filter)
            .populate('collegeId', 'name')
            .populate({
                path: 'scheduleId',
                populate: [
                    { path: 'courseId', select: 'title' },
                    { path: 'collegeId', select: 'name' }
                ]
            })
            .sort({ date: -1 });

        res.json({
            success: true,
            count: attendance.length,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching trainer attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// Get all attendance records (for SPOC Admin verification page)
router.get('/', async (req, res) => {
    try {
        const attendance = await Attendance.find({})
            .populate({
                path: 'trainerId',
                populate: { path: 'userId', select: 'name email' }
            })
            .populate({
                path: 'collegeId',
                select: 'name latitude longitude companyId',
                populate: { path: 'companyId', select: 'name' }
            })
            .populate({
                path: 'scheduleId',
                populate: { path: 'courseId', select: 'name' }
            })
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

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

// Manual attendance entry (SPOC Admin)
router.post('/manual', uploadManual, async (req, res) => {
    try {
        const {
            trainerId,
            collegeId,
            scheduleId,
            dayNumber,
            date,
            status,
            remarks,
            studentsPresent,
            studentsAbsent,
            syllabus
        } = req.body;

        if (!trainerId || !collegeId || !date) {
            return res.status(400).json({
                success: false,
                message: 'Trainer ID, College ID, and Date are required'
            });
        }

        const attendance = await Attendance.create({
            trainerId,
            collegeId,
            scheduleId: scheduleId || null,
            dayNumber: dayNumber || null,
            date: new Date(date),
            status: status || 'Present',
            remarks,
            uploadedBy: 'admin',
            isManualEntry: true,
            studentsPresent: studentsPresent || 0,
            studentsAbsent: studentsAbsent || 0,
            verificationStatus: 'approved',
            verifiedAt: new Date(),
            syllabus: syllabus || null
        });

        res.status(201).json({
            success: true,
            message: 'Manual attendance created successfully',
            data: attendance
        });
    } catch (error) {
        console.error('Error creating manual attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create manual attendance',
            error: error.message
        });
    }
});

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

        // Check if attendance already exists for this trainer and date
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        let attendance = await Attendance.findOne({
            trainerId,
            date: { $gte: startOfDay, $lte: endOfDay },
            collegeId: null // Only check for general attendance
        });

        if (attendance) {
            attendance.status = status;
            attendance.remarks = remarks;
            attendance.verifiedAt = new Date(); // Auto-verify
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
                collegeId: null // Explicitly null for general attendance
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
router.get('/college/:collegeId', async (req, res) => {
    try {
        const attendance = await Attendance.find({ collegeId: req.params.collegeId })
            .populate('trainerId')
            .populate('scheduleId')
            .populate('verifiedBy', 'name')
            .sort({ date: -1 });

        res.json({
            success: true,
            data: attendance
        });
    } catch (error) {
        console.error('Error fetching college attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// Admin uploads/updates attendance (PDF, Image, GeoTag)
router.post('/admin-upload', uploadAttendance, async (req, res) => {
    try {
        const { scheduleId, trainerId, collegeId, latitude, longitude, date } = req.body;



        if (!scheduleId) {
            return res.status(400).json({ success: false, message: 'Schedule ID is required' });
        }

        let attendance = await Attendance.findOne({ scheduleId });

        const attendancePdfUrl = req.files?.attendancePdf ? req.files.attendancePdf[0].path : undefined;
        const studentsPhotoUrl = req.files?.studentsPhoto ? req.files.studentsPhoto[0].path : undefined;

        let checkOutGeoImageUrls = undefined;
        let checkOutGeoImageUrl = undefined;
        if (req.files?.checkOutGeoImage) {
            checkOutGeoImageUrls = req.files.checkOutGeoImage.map(file => file.path);
            checkOutGeoImageUrl = checkOutGeoImageUrls[0];
        }

        if (attendance) {
            // Update existing
            if (attendancePdfUrl) attendance.attendancePdfUrl = attendancePdfUrl;
            if (studentsPhotoUrl) attendance.studentsPhotoUrl = studentsPhotoUrl;
            if (checkOutGeoImageUrls) {
                attendance.checkOutGeoImageUrls = checkOutGeoImageUrls;
                attendance.checkOutGeoImageUrl = checkOutGeoImageUrl;
                // Reset verification status if new images are uploaded
                attendance.geoVerificationStatus = 'pending';
            }
            if (latitude) attendance.latitude = latitude;
            if (longitude) attendance.longitude = longitude;

            // Update statuses if provided
            if (req.body.verificationStatus) {
                attendance.verificationStatus = req.body.verificationStatus;
            }
            if (req.body.geoVerificationStatus) {
                attendance.geoVerificationStatus = req.body.geoVerificationStatus;
                // Sync main status with Geo Tag status
                if (req.body.geoVerificationStatus === 'approved') {
                    attendance.status = 'Present';
                } else if (req.body.geoVerificationStatus === 'rejected') {
                    attendance.status = 'Absent';
                }
            }
            
            if (req.body.syllabus) attendance.syllabus = req.body.syllabus;

            await attendance.save();

        } else {
            // Create new
            if (!trainerId || !collegeId) {
                return res.status(400).json({ success: false, message: 'Trainer ID and College ID are required for new attendance' });
            }

            attendance = await Attendance.create({
                scheduleId,
                trainerId,
                collegeId,
                date: date ? new Date(date) : new Date(),
                attendancePdfUrl,
                studentsPhotoUrl,
                latitude,
                longitude,
                checkOutGeoImageUrl,
                checkOutGeoImageUrls,
                verificationStatus: req.body.verificationStatus || 'pending',
                geoVerificationStatus: req.body.geoVerificationStatus || 'pending',
                status: req.body.geoVerificationStatus === 'approved' ? 'Present' : (req.body.geoVerificationStatus === 'rejected' ? 'Absent' : 'Pending'),
                verifiedBy: req.user ? req.user.id : undefined,
                verifiedAt: (req.body.verificationStatus === 'approved' || req.body.geoVerificationStatus === 'approved') ? new Date() : undefined,
                uploadedBy: 'admin'
            });

        }

        res.json({ success: true, message: 'Attendance uploaded successfully', data: attendance });

    } catch (error) {
        console.error('Error uploading attendance:', error);
        res.status(500).json({ success: false, message: 'Failed to upload attendance', error: error.message });
    }
});

// SPOC Admin verifies attendance (Approve/Reject)
router.put('/:id/verify', async (req, res) => {
    try {
        let { status, comment } = req.body;
        const attendanceId = req.params.id;

        // Normalize status - trim whitespace and convert to lowercase
        if (status) {
            status = status.toString().trim().toLowerCase();
        }

        // Validate status
        if (!status || !['approved', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be "approved", "rejected", or "pending". Received: "${status}"`,
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
            updateData.status = 'Absent';
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

        // Notify Trainer on rejection
        if (status === 'rejected') {
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
                console.error('Error sending rejection notification:', notifyError);
            }
        }

        // If approved, sync Schedule status to 'COMPLETED'
        if (status === 'approved' && attendance.scheduleId) {
            try {
                await Schedule.findByIdAndUpdate(attendance.scheduleId, { 
                    status: 'COMPLETED' 
                });

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
                console.error('Error syncing schedule status or sending notification:', syncError);
            }
        }

        // Notify via socket
        const io = req.app.get('io');
        if (io) {
            io.emit('attendanceUpdate', {
                type: 'VERIFICATION_UPDATE',
                attendanceId: attendance._id,
                status: attendance.verificationStatus,
                message: `Attendance verification status updated to ${attendance.verificationStatus}`
            });
        }

        res.json({
            success: true,
            message: 'Attendance verification status updated',
            data: attendance
        });
    } catch (error) {
        console.error('Error verifying attendance:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify attendance',
            error: error.message
        });
    }
});

// Verify Geo Tag (SPOC Admin)
router.put('/:id/verify-geo', async (req, res) => {
    try {
        const { status, comment } = req.body;
        const attendanceId = req.params.id;

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be approved or rejected'
            });
        }

        // CRITICAL: Check if check-in is approved before allowing check-out approval
        if (status === 'approved') {
            const attendance = await Attendance.findById(attendanceId);
            if (!attendance) {
                return res.status(404).json({
                    success: false,
                    message: 'Attendance record not found'
                });
            }

            if (attendance.verificationStatus !== 'approved') {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot approve check-out: Check-in must be approved first. Current check-in status: ' + (attendance.verificationStatus || 'pending')
                });
            }
        }

        // Determine attendance status based on verification
        let attendanceStatus = undefined;
        if (status === 'approved') {
            attendanceStatus = 'Present';
        } else if (status === 'rejected') {
            attendanceStatus = 'Absent';
        }

        const updateData = {
            geoVerificationStatus: status,
            verificationComment: comment || '',
            approvedBy: req.body.approvedBy || null,
            verifiedAt: new Date()
        };

        if (attendanceStatus) {
            updateData.status = attendanceStatus;
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

        // Notify Trainer on rejection
        if (status === 'rejected') {
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
                        title: 'Geo-Tag Rejected',
                        message: `Your Check-Out / Geo-Tag for Day ${populatedAttendance.dayNumber || 'N/A'} at ${populatedAttendance.collegeId?.name || 'College'} was rejected. Reason: ${comment || 'No reason provided'}`,
                        type: 'error',
                        link: '/trainer/schedule'
                    });
                }
            } catch (notifyError) {
                console.error('Error sending geo-tag rejection notification:', notifyError);
            }
        }

        // Update Schedule status to 'COMPLETED' when check-out is approved
        if (status === 'approved' && attendance.scheduleId) {
            try {
                // Set completedAt timestamp and status
                attendance.completedAt = new Date();
                attendance.attendanceStatus = 'PRESENT'; // New Field
                await attendance.save();

                // Update schedule status
                const schedule = await Schedule.findByIdAndUpdate(attendance.scheduleId, { 
                    status: 'COMPLETED' 
                }, { new: true }).populate('courseId collegeId');

                // Send Bell Notification to Trainer
                try {
                    const populatedAttendance = await Attendance.findById(attendanceId)
                        .populate({
                            path: 'trainerId',
                            populate: { path: 'userId' }
                        })
                        .populate('collegeId')
                        .populate('courseId')
                        .populate({
                            path: 'scheduleId',
                            populate: { path: 'courseId' }
                        });

                    if (populatedAttendance && populatedAttendance.trainerId?.userId) {
                        const courseName = populatedAttendance.courseId?.name || populatedAttendance.courseId?.title || populatedAttendance.scheduleId?.courseId?.name || populatedAttendance.scheduleId?.courseId?.title || 'N/A';
                         const dayVal = `Day ${populatedAttendance.dayNumber || 'N/A'}`;

                        await Notification.create({
                            userId: populatedAttendance.trainerId.userId._id,
                            title: '✅ Training Day Completed',
                            message: `
Course: ${courseName}
College: ${populatedAttendance.collegeId?.name || 'N/A'}
Day: ${dayVal}
Date: ${new Date(populatedAttendance.date).toLocaleDateString()}
Status: Completed
`,
                            type: 'success',
                            link: '/trainer/schedule'
                        });

                        // Send Email Notification using Helper
                        await sendTrainingCompletionEmail(
                            populatedAttendance.trainerId.userId.email, 
                            populatedAttendance.trainerId.userId.name,
                            {
                                course: courseName,
                                college: populatedAttendance.collegeId?.name || 'N/A',
                                day: dayVal,
                                date: new Date(populatedAttendance.date).toLocaleDateString(),
                                status: 'COMPLETED',
                                portalUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/trainer/schedule`
                            }
                        );
                    }
                } catch (notifyError) {
                    console.error('Error sending completion notification:', notifyError);
                }
            } catch (scheduleError) {
                console.error('Error updating schedule status:', scheduleError);
            }
        }

        res.json({
            success: true,
            message: 'Geo Tag verification status updated',
            data: attendance
        });
    } catch (error) {
        console.error('Error verifying geo tag:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to verify geo tag',
            error: error.message
        });
    }
});

// Submit Attendance (Trainer) - Replaces check-in/check-out flow for Student System
router.post('/submit', uploadAttendance, async (req, res) => {
    try {
        const { 
            scheduleId, trainerId, collegeId, dayNumber, 
            studentsPresent, studentsAbsent, studentList,
            latitude, longitude, locationCapturedAt
        } = req.body;

        if (!scheduleId || !trainerId || !collegeId) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Parse student list
        let students = [];
        if (studentList) {
            try {
                students = JSON.parse(studentList);
            } catch (e) {
                console.error('Error parsing student list:', e);
            }
        }

        // Handle files
        const attendancePdfUrl = req.files?.attendancePdf ? req.files.attendancePdf[0].path : undefined;
        let studentsPhotoUrl = undefined;
        if (req.files?.studentsPhoto) {
            studentsPhotoUrl = req.files.studentsPhoto.map(f => f.path); // Store generic photos
        }
        
        // Handle Signature
        const signatureUrl = req.files?.signature ? req.files.signature[0].path : undefined;

        // Activity evidence
        let activityPhotos = [];
        if (req.files?.activityPhotos) {
            activityPhotos = req.files.activityPhotos.map(f => f.path);
        }
        let activityVideos = [];
        if (req.files?.activityVideos) {
            activityVideos = req.files.activityVideos.map(f => f.path);
        }

        // Find or Create Attendance
        let attendance = await Attendance.findOne({ scheduleId });

        if (!attendance) {
            attendance = new Attendance({
                scheduleId,
                trainerId,
                collegeId,
                dayNumber,
                date: new Date(),
                uploadedBy: 'trainer'
            });
        }

        // Update fields
        attendance.checkInTime = new Date().toTimeString().split(' ')[0];
        attendance.checkOutTime = new Date().toTimeString().split(' ')[0]; // Auto checkout for this flow?
        attendance.status = 'Present';
        attendance.verificationStatus = 'pending';
        attendance.studentsPresent = studentsPresent || 0;
        attendance.studentsAbsent = studentsAbsent || 0;
        attendance.students = students; // Save detailed list
        
        if (attendancePdfUrl) attendance.attendancePdfUrl = attendancePdfUrl;
        if (signatureUrl) attendance.signatureUrl = signatureUrl;
        if (latitude) attendance.latitude = latitude;
        if (longitude) attendance.longitude = longitude;
        if (locationCapturedAt) attendance.locationCapturedAt = locationCapturedAt;
        
        if (activityPhotos.length > 0) attendance.activityPhotos = activityPhotos;
        if (activityVideos.length > 0) attendance.activityVideos = activityVideos;

        // Generate Attendance Excel
        if (students.length > 0) {
            try {
                // Create Workbook
                const wb = xlsx.utils.book_new();
                
                // Format Data for Excel
                const excelData = students.map(s => ({
                    'Roll No': s.rollNo,
                    'Register No': s.registerNo,
                    'Student Name': s.name,
                    'Status': s.status
                }));

                const ws = xlsx.utils.json_to_sheet(excelData);
                xlsx.utils.book_append_sheet(wb, ws, "Attendance");

                // Define Path
                // Ensure directory exists
                const uploadDir = path.join(__dirname, '../uploads/attendance-sheets');
                if (!fs.existsSync(uploadDir)) {
                    fs.mkdirSync(uploadDir, { recursive: true });
                }

                // Filename: College_DayX_Date.xlsx
                const dateStr = new Date().toISOString().split('T')[0];
                const fileName = `Attendance_${collegeId}_Day${dayNumber}_${dateStr}_${Date.now()}.xlsx`;
                const filePath = path.join(uploadDir, fileName);

                // Write File
                xlsx.writeFile(wb, filePath);

                // Save URL (relative path for serving)
                // We'll need to serve specific route for this
                attendance.attendanceExcelUrl = fileName; 

            } catch (err) {
                console.error('Error generating Excel:', err);
            }
        }

        await attendance.save();

        // Update Schedule status
        await Schedule.findByIdAndUpdate(scheduleId, { status: 'completed' });

        res.json({ success: true, message: 'Attendance submitted successfully', data: attendance });

    } catch (error) {
        console.error('Error submitting attendance:', error);
        res.status(500).json({ success: false, message: 'Failed to submit attendance', error: error.message });
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

module.exports = router;

