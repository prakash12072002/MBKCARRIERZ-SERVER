const cron = require('node-cron');
const dayjs = require('dayjs');
const { Schedule, Trainer, College, Course, Notification } = require('../models');
const { sendScheduleChangeEmail } = require('../utils/emailService');
const { notifyTrainerSchedule } = require('./notificationService');

/**
 * Check for schedules occurring in the next 24 hours and send reminders
 */
const checkAndSendReminders = async () => {
    console.log('⏰ Running 24h Schedule Reminder Job...');
    try {
        const now = dayjs();
        const tomorrow = now.add(24, 'hour');
        
        // Find schedules starting between 20 and 26 hours from now 
        // We use a window to ensure we don't miss ones due to job frequency (runs every hour)
        const schedules = await Schedule.find({
            scheduledDate: {
                $gte: tomorrow.subtract(2, 'hour').toDate(),
                $lte: tomorrow.add(2, 'hour').toDate()
            },
            status: 'scheduled',
            reminderSent: { $ne: true },
            trainerId: { $ne: null }
        });

        console.log(`Found ${schedules.length} upcoming schedules for reminders.`);

        for (const schedule of schedules) {
            try {
                const trainer = await Trainer.findById(schedule.trainerId).populate('userId');
                const college = await College.findById(schedule.collegeId);
                const course = await Course.findById(schedule.courseId);

                if (!trainer || !trainer.userId) continue;

                const spocName = college?.principalName || 'N/A';
                const spocPhone = college?.phone || '';
                const mapLink = college?.location?.mapUrl || ((college?.location?.lat && college?.location?.lng) ? `https://www.google.com/maps?q=${college.location.lat},${college.location.lng}` : '');
                const formattedDate = dayjs(schedule.scheduledDate).format('DD-MM-YYYY');

                // Unified Notification Dispatcher
                const { sendNotification } = require('./notificationService');
                
                const formattedTime = `${schedule.startTime} - ${schedule.endTime}`;

                await sendNotification(null, {
                    userId: trainer.userId._id,
                    role: trainer.userId.role || 'Trainer',
                    title: 'Upcoming Training Reminder',
                    message: `Reminder: You have a training for ${course?.title || 'TEST COURSE'} at ${college?.name} tomorrow, ${formattedDate} (${formattedTime}). CoNDAct SPOC: ${spocName} (${spocPhone})`,
                    type: 'Schedule',
                    link: '/trainer/schedule',
                    channels: ['in-app', 'email', 'whatsapp'],
                    phone: trainer.phone,
                    whatsappVariables: {
                        "1": formattedDate,
                        "2": formattedTime
                    }
                }).catch(e => console.error('Unified Reminder failed:', e));

                // Send original assignment-style email as fallback since sendNotification currently has a simple email stub
                await sendScheduleChangeEmail(
                    trainer.userId.email,
                    trainer.name || trainer.userId.name,
                    {
                        date: formattedDate,
                        day: schedule.dayNumber ? `Day ${schedule.dayNumber}` : dayjs(schedule.scheduledDate).format('dddd'),
                        college: college?.name || 'Assigned College',
                        course: course?.title || 'Assigned Course',
                        startTime: schedule.startTime,
                        endTime: schedule.endTime,
                        location: college?.location?.address || '',
                        mapLink,
                        spocName,
                        spocPhone
                    },
                    'assignment', // We use assignment style for reminder
                    'Reminder: This is a 24-hour reminder for your upcoming training session tomorrow.'
                );

                // Mark as sent
                schedule.reminderSent = true;
                await schedule.save();
                
                console.log(`✅ Sent reminder to ${trainer.name} for ${course?.title} at ${college?.name}`);
            } catch (err) {
                console.error(`Failed to send reminder for schedule ${schedule._id}:`, err);
            }
        }
    } catch (error) {
        console.error('Error in checkAndSendReminders:', error);
    }
};

/**
 * Initialize the reminder cron job
 */
const init = () => {
    // Run every hour at the start of the hour
    cron.schedule('0 * * * *', () => {
        checkAndSendReminders();
    });
    
    // Also run once on startup
    checkAndSendReminders();
    
    console.log('🚀 Reminder Service Initialized (Job: hourly)');
};

module.exports = {
    init,
    checkAndSendReminders
};
