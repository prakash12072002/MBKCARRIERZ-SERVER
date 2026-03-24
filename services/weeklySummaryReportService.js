const cron = require("node-cron");
const dayjs = require("dayjs");
const {
  Company,
  User,
  Trainer,
  Schedule,
  Attendance,
  Complaint,
} = require("../models");
const { sendMail } = require("../utils/emailService");
const weeklySummaryEmail = require("../utils/weeklySummaryEmail");

const COMPLETED_SCHEDULE_STATUSES = new Set(["completed", "COMPLETED"]);

const getIsoWeekNumber = (inputDate) => {
  const date = new Date(Date.UTC(
    inputDate.getFullYear(),
    inputDate.getMonth(),
    inputDate.getDate(),
  ));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
};

const getWeeklyRange = (dateRef = dayjs()) => {
  const weekEnd = dayjs(dateRef).endOf("day");
  const weekStart = weekEnd.subtract(6, "day").startOf("day");
  return { weekStart, weekEnd };
};

const buildWeeklySummary = async (company, dateRef = dayjs()) => {
  const { weekStart, weekEnd } = getWeeklyRange(dateRef);

  const scheduleQuery = {
    scheduledDate: { $gte: weekStart.toDate(), $lte: weekEnd.toDate() },
    $or: [
      ...(company.companyCode ? [{ companyCode: company.companyCode }] : []),
      { companyId: company._id },
    ],
  };

  const schedules = await Schedule.find(scheduleQuery)
    .select("_id trainerId status")
    .lean();

  const completedSchedules = schedules.filter((schedule) =>
    COMPLETED_SCHEDULE_STATUSES.has(String(schedule.status || "")),
  );
  const totalSessions = completedSchedules.length;
  const scheduleIds = schedules.map((schedule) => schedule._id);

  let totalAttendance = 0;
  if (scheduleIds.length > 0) {
    totalAttendance = await Attendance.countDocuments({
      scheduleId: { $in: scheduleIds },
      date: { $gte: weekStart.toDate(), $lte: weekEnd.toDate() },
    });
  }

  const trainerCountMap = new Map();
  for (const schedule of completedSchedules) {
    if (!schedule.trainerId) continue;
    const trainerId = String(schedule.trainerId);
    trainerCountMap.set(trainerId, (trainerCountMap.get(trainerId) || 0) + 1);
  }

  let topTrainer = "N/A";
  if (trainerCountMap.size > 0) {
    const sorted = [...trainerCountMap.entries()].sort((a, b) => b[1] - a[1]);
    const [topTrainerId] = sorted[0];

    const trainer = await Trainer.findById(topTrainerId)
      .select("firstName lastName email")
      .lean();
    if (trainer) {
      const fullName = `${trainer.firstName || ""} ${trainer.lastName || ""}`.trim();
      topTrainer = fullName || trainer.email || "N/A";
    }
  }

  const issuesReported = await Complaint.countDocuments({
    companyId: company._id,
    createdAt: { $gte: weekStart.toDate(), $lte: weekEnd.toDate() },
    type: "Complaint",
  });

  return {
    weekRange: `${weekStart.format("DD MMM YYYY")} - ${weekEnd.format("DD MMM YYYY")}`,
    weekNumber: getIsoWeekNumber(weekEnd.toDate()),
    totalSessions,
    totalAttendance,
    topTrainer,
    issuesReported,
  };
};

const sendWeeklySummaryReports = async (dateRef = dayjs()) => {
  const companies = await Company.find({
    isActive: { $ne: false },
    status: { $in: ["active", "Active"] },
  })
    .select("_id name companyCode email adminId")
    .lean();

  const runDate = dayjs(dateRef).format("DD MMM YYYY");
  console.log(`[WEEKLY-REPORT] Running weekly summary for ${runDate}`);

  for (const company of companies) {
    try {
      let recipientEmail = company.email || null;

      if (!recipientEmail && company.adminId) {
        const admin = await User.findById(company.adminId).select("email").lean();
        recipientEmail = admin?.email || null;
      }

      if (!recipientEmail) {
        console.log(`[WEEKLY-REPORT] Skipped ${company.name}: no coNDAct email`);
        continue;
      }

      const summary = await buildWeeklySummary(company, dateRef);
      const subject = `MBK Weekly Activity Summary - Week ${summary.weekNumber}`;
      const text = [
        `Company: ${company.name}`,
        `Week: ${summary.weekRange}`,
        `Total Sessions Conducted: ${summary.totalSessions}`,
        `Attendance Records Submitted: ${summary.totalAttendance}`,
        `Top Performing Trainer: ${summary.topTrainer}`,
        `Issues Reported: ${summary.issuesReported}`,
      ].join("\n");

      await sendMail(
        recipientEmail,
        subject,
        text,
        weeklySummaryEmail({
          companyName: company.name,
          weekRange: summary.weekRange,
          totalSessions: summary.totalSessions,
          totalAttendance: summary.totalAttendance,
          topTrainer: summary.topTrainer,
          issuesReported: summary.issuesReported,
        }),
      );

      console.log(`[WEEKLY-REPORT] Sent: ${company.name} -> ${recipientEmail}`);
    } catch (error) {
      console.error(
        `[WEEKLY-REPORT] Failed for ${company?.name || "Unknown Company"}:`,
        error.message,
      );
    }
  }
};

const init = () => {
  const cronExpr = process.env.WEEKLY_ACTIVITY_REPORT_CRON || "0 21 * * 0";
  const timezone = process.env.WEEKLY_ACTIVITY_REPORT_TIMEZONE || "Asia/Kolkata";

  cron.schedule(
    cronExpr,
    () => {
      sendWeeklySummaryReports().catch((error) => {
        console.error("[WEEKLY-REPORT] Job crashed:", error);
      });
    },
    { timezone },
  );

  console.log(
    `[WEEKLY-REPORT] Service initialized (cron: ${cronExpr}, timezone: ${timezone})`,
  );
};

module.exports = {
  init,
  sendWeeklySummaryReports,
  buildWeeklySummary,
};
