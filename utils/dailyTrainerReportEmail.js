function dailyTrainerReportEmail({
  companyName,
  date,
  totalTrainers,
  activeToday,
  completedSessions,
  pendingAttendance,
}) {
  return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;font-family:Arial;background:#f4f6f9;">
      <div style="padding:20px;">
        <div style="width:100%;max-width:600px;margin:auto;background:white;border-radius:12px;padding:20px;">
          <h2 style="color:#1e3a8a;text-align:center;">
            Daily Trainer Activity Report
          </h2>

          <p><strong>Company:</strong> ${companyName}</p>
          <p><strong>Date:</strong> ${date}</p>

          <div style="background:#f1f5f9;padding:15px;border-radius:8px;margin-top:15px;">
            <p>Total Trainers: <strong>${totalTrainers}</strong></p>
            <p>Active Today: <strong>${activeToday}</strong></p>
            <p>Completed Sessions: <strong>${completedSessions}</strong></p>
            <p>Pending Attendance: <strong>${pendingAttendance}</strong></p>
          </div>

          <p style="margin-top:20px;">
            Please monitor performance and ensure attendance records are updated.
          </p>

          <hr style="margin-top:20px;" />
          <p style="font-size:12px;color:#888;text-align:center;">
            &copy; ${new Date().getFullYear()} MBK Carriez
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

module.exports = dailyTrainerReportEmail;
