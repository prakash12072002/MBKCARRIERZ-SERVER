function weeklySummaryEmail({
  companyName,
  weekRange,
  totalSessions,
  totalAttendance,
  topTrainer,
  issuesReported,
}) {
  return `
  <!DOCTYPE html>
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0;padding:0;font-family:Arial;background:#f4f6f9;">
      <div style="padding:20px;">
        <div style="inline-size:100%;max-inline-size:600px;margin:auto;background:white;border-radius:12px;padding:20px;">
          <h2 style="color:#1e3a8a;text-align:center;">
            Weekly Activity Summary
          </h2>

          <p><strong>Company:</strong> ${companyName}</p>
          <p><strong>Week:</strong> ${weekRange}</p>

          <div style="background:#f8fafc;padding:15px;border-radius:8px;margin-block-start:15px;">
            <p>Total Sessions Conducted: <strong>${totalSessions}</strong></p>
            <p>Attendance Records Submitted: <strong>${totalAttendance}</strong></p>
            <p>Top Performing Trainer: <strong>${topTrainer}</strong></p>
            <p>Issues Reported: <strong>${issuesReported}</strong></p>
          </div>

          <p style="margin-block-start:20px;">
            Keep up the good work and improve where necessary.
          </p>

          <hr style="margin-block-start:20px;" />
          <p style="font-size:12px;color:#888;text-align:center;">
            &copy; ${new Date().getFullYear()} MBK Carriez
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

module.exports = weeklySummaryEmail;
