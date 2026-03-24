const express = require('express');
const router = express.Router();
const { generatePDF } = require('../utils/pdfGenerator');
const { upload } = require('../config/cloudinary');

// Test PDF Generation
router.get('/pdf', async (req, res) => {
    try {
        const content = {
            title: 'Verification Test PDF',
            message: 'If you are reading this, the PDF generation service using PDFKit is working correctly!',
            timestamp: new Date().toISOString()
        };
        
        const pdfBuffer = await generatePDF(content, 'System Verification Report');
        
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="test-report.pdf"',
            'Content-Length': pdfBuffer.length
        });
        
        res.send(pdfBuffer);
    } catch (error) {
        console.error('PDF Generation Error:', error);
        res.status(500).json({ success: false, message: 'PDF Generation Failed', error: error.message });
    }
});

// Test File Upload (Cloudinary)
router.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }
        res.json({
            success: true,
            message: 'File uploaded successfully to Cloudinary',
            file: req.file
        });
    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).json({ success: false, message: 'Upload Failed', error: error.message });
    }
});

// Trigger Reminder Service Manually for Testing
router.post('/trigger-reminders', async (req, res) => {
    try {
        const { checkAndSendReminders } = require('../services/reminderService');
        await checkAndSendReminders();
        res.json({ success: true, message: 'Trainer Reminders job triggered successfully. Check logs for details.' });
    } catch (error) {
        console.error('Trigger Reminder Error:', error);
        res.status(500).json({ success: false, message: 'Failed to trigger reminders', error: error.message });
    }
});

module.exports = router;
