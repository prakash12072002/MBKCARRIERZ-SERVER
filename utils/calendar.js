const { createEvent } = require('ics');

/**
 * Generates an ICS file content for a schedule
 * @param {Object} schedule - Schedule object with day, date, course, college, location
 * @returns {Promise<string>} - ICS file content
 */
const generateICS = (schedule) => {
  // schedule.date is formatted YYYY-MM-DD or is a Date object?
  // Passed object usually has date string or Date object.
  // We expect { date: 'YYYY-MM-DD', startTime: 'HH:MM', endTime: 'HH:MM', ... }
  
  const dateStr = schedule.date; 
  let year, month, day;
  
  if (dateStr instanceof Date) {
      year = dateStr.getFullYear();
      month = dateStr.getMonth() + 1;
      day = dateStr.getDate();
  } else {
      [year, month, day] = dateStr.split("-").map(Number);
  }

  const [sh, sm] = schedule.startTime.split(":").map(Number);
  const [eh, em] = schedule.endTime.split(":").map(Number);

  return new Promise((resolve, reject) => {
    createEvent(
      {
        title: `${schedule.course} - ${schedule.college}`,
        description: `
Course: ${schedule.course}
Day: ${schedule.day}
College: ${schedule.college}
Location: ${schedule.location || 'See Map'}
        `,
        location: schedule.location || 'TBD',
        start: [year, month, day, sh, sm],
        end: [year, month, day, eh, em],
        status: 'CONFIRMED',
        busyStatus: 'BUSY',
      },
      (error, value) => {
        if (error) {
            console.error('ICS Generation Error:', error);
            reject(error);
        }
        else resolve(value);
      }
    );
  });
};

module.exports = { generateICS };
