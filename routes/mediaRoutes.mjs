import express from 'express';
import { parser, uploadMedia } from '../controllers/mediaController.mjs';

const router = express.Router();

/**
 * @route   POST /api/media/upload
 * @desc    Upload media file to Cloudinary
 * @access  Private
 */
router.post('/upload', parser.single('file'), uploadMedia);

export default router;
