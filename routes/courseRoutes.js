const express = require('express');
const router = express.Router();
const { Course, Company } = require('../models');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { cascadeDeleteCoursesByIds } = require('../services/hierarchyDeleteService');
const {
    ensureCourseHierarchy,
    isTrainingDriveEnabled,
} = require('../modules/drive/driveGateway');

// @route   GET /api/courses
// @desc    Get all courses (optionally filtered by companyId)
// @access  Authenticated
router.get('/', authenticate, async (req, res) => {
    try {
        const { companyId } = req.query;
        const filter = {};
        if (companyId) {
            filter.companyId = companyId;
        }

        const courses = await Course.find(filter)
            .sort({ createdAt: -1 });
        res.json(courses);
    } catch (error) {
        console.error('Error fetching courses:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   POST /api/courses
// @desc    Create a new course
// @access  Super Admin, SPOC Admin
router.post('/', authenticate, async (req, res) => {
    try {
        const { title, companyId, courseHead, description } = req.body;
        const course = await Course.create({
            title,
            companyId,
            courseHead,
            description
        });

        if (isTrainingDriveEnabled()) {
            try {
                const company = await Company.findById(course.companyId);
                if (company) {
                    const hierarchy = await ensureCourseHierarchy({ company, course });

                    if (hierarchy?.companyFolder?.id) {
                        company.driveFolderId = hierarchy.companyFolder.id;
                        company.driveFolderName = hierarchy.companyFolder.name;
                        company.driveFolderLink = hierarchy.companyFolder.link;
                        await company.save();
                    }

                    if (hierarchy?.courseFolder?.id) {
                        course.driveFolderId = hierarchy.courseFolder.id;
                        course.driveFolderName = hierarchy.courseFolder.name;
                        course.driveFolderLink = hierarchy.courseFolder.link;
                        await course.save();
                    }
                }
            } catch (driveError) {
                console.error('[GOOGLE-DRIVE] Failed to create course hierarchy:', driveError.message);
            }
        }

        res.status(201).json(course);
    } catch (error) {
        console.error('Error creating course:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   PUT /api/courses/:id
// @desc    Update a course
// @access  Super Admin, SPOC Admin
router.put('/:id', authenticate, async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) {
            return res.status(404).json({ message: 'Course not found' });
        }
        Object.assign(course, req.body);
        await course.save();

        if (isTrainingDriveEnabled()) {
            try {
                const company = course.companyId
                    ? await Company.findById(course.companyId).select('name driveFolderId driveFolderName driveFolderLink')
                    : null;

                if (company) {
                    const hierarchy = await ensureCourseHierarchy({ company, course });

                    if (hierarchy?.companyFolder?.id) {
                        company.driveFolderId = hierarchy.companyFolder.id;
                        company.driveFolderName = hierarchy.companyFolder.name;
                        company.driveFolderLink = hierarchy.companyFolder.link;
                        await company.save();
                    }

                    if (hierarchy?.courseFolder?.id) {
                        course.driveFolderId = hierarchy.courseFolder.id;
                        course.driveFolderName = hierarchy.courseFolder.name;
                        course.driveFolderLink = hierarchy.courseFolder.link;
                        await course.save();
                    }
                }
            } catch (driveError) {
                console.error('[GOOGLE-DRIVE] Failed to sync course hierarchy:', driveError.message);
            }
        }

        res.json(course);
    } catch (error) {
        console.error('Error updating course:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   DELETE /api/courses/:id
// @desc    Delete a course
// @access  Super Admin, SPOC Admin
router.delete('/:id', authenticate, async (req, res) => {
    try {
        console.log('Deleting course:', req.params.id);
        const course = await Course.findById(req.params.id);
        if (!course) {
            return res.status(404).json({ message: 'Course not found' });
        }

        await cascadeDeleteCoursesByIds([course._id]);

        console.log('Course deleted successfully');
        res.json({ message: 'Course and related colleges/departments/days deleted successfully' });
    } catch (error) {
        console.error('Error deleting course:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// @route   POST /api/courses/:id/upload-image
// @desc    Upload course image
// @access  Authenticated
router.post('/:id/upload-image', authenticate, upload.single('image'), async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) {
            return res.status(404).json({ message: 'Course not found' });
        }
        if (!req.file) {
            return res.status(400).json({ message: 'No image file uploaded' });
        }
        course.image = req.file.filename;
        await course.save();
        res.json({ success: true, image: course.image });
    } catch (error) {
        console.error('Error uploading course image:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
