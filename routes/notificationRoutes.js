const express = require('express');
const router = express.Router();
const {
    dispatchWorkspaceNotification,
    getNotifications,
    markAsRead,
    markAllAsRead,
    deleteAllNotifications,
    deleteNotification,
} = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');

// All notification routes require authentication
router.use(authenticate);

router.route('/')
    .get(getNotifications)
    .delete(deleteAllNotifications);

router.route('/read-all')
    .put(markAllAsRead);

router.route('/workspace-dispatch')
    .post(dispatchWorkspaceNotification);

router.route('/:id')
    .delete(deleteNotification);

router.route('/:id/read')
    .put(markAsRead);

module.exports = router;
