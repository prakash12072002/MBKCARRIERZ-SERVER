const express = require('express');
const router = express.Router();
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Student, College } = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');



// @route   POST /api/students/upload
// @desc    Upload student list Excel
// @access  Super Admin, SPOC Admin
router.post('/upload', authenticate, authorize(['SuperAdmin', 'SPOCAdmin']), (req, res, next) => {
    const uploadSingle = upload.single('file');
    uploadSingle(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: 'Upload failed', error: err.message });
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const { collegeId } = req.body;
        if (!collegeId) return res.status(400).json({ success: false, message: 'College ID is required' });

        const college = await College.findById(collegeId);
        if (!college) return res.status(404).json({ success: false, message: 'College not found' });

        const workbook = xlsx.readFile(req.file.path);
        let sheetName = workbook.SheetNames.find(n => n.toLowerCase().includes('student')) || workbook.SheetNames[0];
        const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        if (rows.length === 0) return res.status(400).json({ success: false, message: 'Excel sheet is empty' });

        const studentsToUpsert = [];

        // IMPROVED: Robust Key Matcher (removes all non-alphanumeric chars)
        const getVal = (row, ...candidates) => {
            const rowKeys = Object.keys(row);
            for (const expected of candidates) {
                const normExpected = expected.toLowerCase().replace(/[^a-z0-9]/g, '');
                const foundKey = rowKeys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === normExpected);
                if (foundKey) return row[foundKey];
            }
            return null;
        };

        let processedCount = 0;
        let skippedCount = 0;

        for (const row of rows) {
            // Flexible Header Matching
            let rollNo = getVal(row, 'Student RollNo', 'Student Roll No', 'RollNo', 'Roll Number', 'Roll #', 'Roll No');
            let registerNo = getVal(row, 'RegisterNo', 'Register Number', 'Reg No', 'Registration No', 'Reg Number', 'Student Register No', 'Univ Reg No');
            let name = getVal(row, 'StudentName', 'Student Name', 'Name', 'Name of Student', 'Student');
            let phone = getVal(row, 'Phone', 'Mobile', 'Cell', 'PhoneNumber', 'CoNDAct No', 'Student Phone');
            let email = getVal(row, 'Email', 'E-mail', 'Mail', 'Student Email');

            // --- Auto-Correction Heuristic ---
            const hasDigits = (str) => /\d/.test(String(str));
            const hasLetters = (str) => /[a-zA-Z]/.test(String(str));

            if (registerNo && name) {
                const regStr = String(registerNo);
                const nameStr = String(name);
                if (hasLetters(regStr) && !hasDigits(regStr) && hasDigits(nameStr)) {
                    console.log(`[SWAP DETECTED] Swapping ${registerNo} <-> ${name}`);
                    [registerNo, name] = [name, registerNo];
                }
            }

            // Validation: RegisterNo (or RollNo) AND Name are minimal requirements
            const uniqueId = registerNo || rollNo;

            if (uniqueId && name) {
                // If RegisterNo is missing but RollNo exists, use RollNo as RegisterNo fallback? 
                // No, better to keep them separate but ensure at least one ID exists.
                // Our schema likely requires registerNo or we use it as filter.
                // Let's assume RegisterNo is the primary key. If missing, use RollNo.
                
                const finalRegisterNo = registerNo ? String(registerNo).trim() : String(rollNo).trim();

                studentsToUpsert.push({
                    updateOne: {
                        filter: { collegeId: college._id, registerNo: finalRegisterNo },
                        update: { 
                            $set: { 
                                rollNo: rollNo ? String(rollNo).trim() : '', 
                                name: String(name).trim(),
                                companyId: college.companyId,
                                courseId: college.courseId,
                                // Optional fields if schema supports them
                                ...(phone && { phone: String(phone).trim() }),
                                ...(email && { email: String(email).trim() })
                            }
                        },
                        upsert: true
                    }
                });
                processedCount++;
            } else {
                skippedCount++;
                if (skippedCount <= 5) {
                    console.log('[ROW SKIPPED] Missing keys:', JSON.stringify(row));
                }
            }
        }

        if (studentsToUpsert.length > 0) {
            await Student.bulkWrite(studentsToUpsert);
            
            // Always save file reference if at least one student processed
            college.studeNDAttendanceExcelUrl = req.file.filename; 
            await college.save();
        } else {
            console.log('[UPLOAD FAIL] No valid rows found. Sample keys:', Object.keys(rows[0] || {}));
        }


        let msg = `Processed ${processedCount} students successfully (out of ${rows.length} rows found).`;
        
        if (processedCount === 0 && rows.length > 0) {
            msg += ` [DEBUG] FAIL. First Row Keys: ${JSON.stringify(Object.keys(rows[0]))}`;
        } else if (skippedCount > 0) {
            msg += ` ${skippedCount} rows skipped (missing Name/RegNo).`;
        }

        res.json({
            success: true,
            message: msg,
            data: { count: processedCount }
        });

    } catch (error) {
        console.error('Error uploading students:', error);
        res.status(500).json({ success: false, message: 'Failed to upload students', error: error.message });
    }
});

// @route   DELETE /api/students/clean/:collegeId
// @desc    Delete all students for a college (to fix bad uploads)
// @access  Super Admin
router.delete('/clean/:collegeId', authenticate, authorize(['SuperAdmin']), async (req, res) => {
    try {
        const { collegeId } = req.params;
        const result = await Student.deleteMany({ collegeId });
        
        // Also clear the file reference from college
        await College.findByIdAndUpdate(collegeId, { $unset: { studeNDAttendanceExcelUrl: 1 } });

        res.json({ success: true, message: `Deleted ${result.deletedCount} students. List cleared.` });
    } catch (error) {
        console.error('Error cleaning students:', error);
        res.status(500).json({ success: false, message: 'Failed to clear students', error: error.message });
    }
});

// @route   GET /api/students/college/:collegeId
// @desc    Get all students for a college
// @access  Super Admin, SPOC Admin, Trainer
router.get('/college/:collegeId', authenticate, async (req, res) => {
    try {
        const students = await Student.find({ collegeId: req.params.collegeId })
             // Numeric sort attempt for Roll No, fallback to string sort
            .collation({ locale: "en_US", numericOrdering: true })
            .sort({ rollNo: 1 });
        
        res.json({
            success: true,
            count: students.length,
            data: students
        });
    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch students', error: error.message });
    }
});

module.exports = router;
