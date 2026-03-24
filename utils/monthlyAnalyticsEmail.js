function monthlyAnalyticsEmail({
  companyName,
  month,
  totalTrainers,
  totalSessions,
  totalColleges,
  attendanceRate,
  growthPercent,
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
            Monthly Performance Analytics
          </h2>

          <p><strong>Company:</strong> ${companyName}</p>
          <p><strong>Month:</strong> ${month}</p>

          <div style="background:#eef2ff;padding:15px;border-radius:8px;margin-top:15px;">
            <p>Total Trainers: <strong>${totalTrainers}</strong></p>
            <p>Total Sessions: <strong>${totalSessions}</strong></p>
            <p>Colleges Covered: <strong>${totalColleges}</strong></p>
            <p>Attendance Rate: <strong>${attendanceRate}%</strong></p>
            <p>Growth: <strong>${growthPercent}%</strong></p>
          </div>

          <p style="margin-top:20px;">
            Thank you for being part of MBK Carriez. We look forward to continued growth.
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

module.exports = monthlyAnalyticsEmail;
