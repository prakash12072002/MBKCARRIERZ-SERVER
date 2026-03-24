const cron = require("node-cron");
const dayjs = require("dayjs");
const fs = require("fs/promises");
const {
  Company,
  User,
  Trainer,
  Schedule,
  Attendance,
} = require("../models");
const { sendMail } = require("../utils/emailService");
const dailyTrainerReportEmail = require("../utils/dailyTrainerReportEmail");
const generateReportPDF = require("../utils/generateReportPDF");

const COMPLETED_SCHEDULE_STATUSES = new Set(["completed", "COMPLETED"]);
const ACTIVE_ATTENDANCE_STATUSES = new Set(["Present", "Late"]);

const getDayRange = (dateRef = dayjs()) => ({
  dayStart: dayjs(dateRef).startOf("day").toDate(),
  dayEnd: dayjs(dateRef).endOf("day").toDate(),
});

const buildCompanyReport = async (company, dateRef = dayjs()) => {
  const { dayStart, dayEnd } = getDayRange(dateRef);

  const scheduleQuery = {
    scheduledDate: { $gte: dayStart, $lte: dayEnd },
    $or: [
      ...(company.companyCode ? [{ companyCode: company.companyCode }] : []),
      { companyId: company._id },
    ],
  };

  const schedules = await Schedule.find(scheduleQuery)
    .select("_id trainerId status")
    .lean();

  const scheduleIds = schedules.map((schedule) => schedule._id);
  const completedSessions = schedules.filter((schedule) =>
    COMPLETED_SCHEDULE_STATUSES.has(String(schedule.status || "")),
  ).length;

  const totalTrainers = company.companyCode
    ? await Trainer.countDocuments({ companyCode: company.companyCode })
    : 0;

  if (scheduleIds.length === 0) {
    return {
      totalTrainers,
      activeToday: 0,
      completedSessions,
      pendingAttendance: 0,
    };
  }

  const attendanceRecords = await Attendance.find({
    scheduleId: { $in: scheduleIds },
    date: { $gte: dayStart, $lte: dayEnd },
  })
    .select("scheduleId trainerId status attendanceStatus verificationStatus")
    .lean();

  const activeTrainerIds = new Set();
  const attendanceBySchedule = new Map();

  for (const attendance of attendanceRecords) {
    const scheduleId = String(attendance.scheduleId);
    if (!attendanceBySchedule.has(scheduleId)) {
      attendanceBySchedule.set(scheduleId, []);
    }
    attendanceBySchedule.get(scheduleId).push(attendance);

    const isActive =
      ACTIVE_ATTENDANCE_STATUSES.has(String(attendance.status || "")) ||
      String(attendance.attendanceStatus || "").toUpperCase() === "PRESENT";
    if (isActive && attendance.trainerId) {
      activeTrainerIds.add(String(attendance.trainerId));
    }
  }

  let pendingAttendance = 0;
  for (const schedule of schedules) {
    const key = String(schedule._id);
    const entries = attendanceBySchedule.get(key) || [];
    if (entries.length === 0) {
      pendingAttendance += 1;
      continue;
    }

    const hasPendingVerification = entries.some(
      (entry) => String(entry.verificationStatus || "").toLowerCase() === "pending",
    );
    if (hasPendingVerification) pendingAttendance += 1;
  }

  return {
    totalTrainers,
    activeToday: activeTrainerIds.size,
    completedSessions,
    pendingAttendance,
  };
};

const sendDailyTrainerReports = async (dateRef = dayjs()) => {
  const reportDateLabel = dayjs(dateRef).format("DD MMM YYYY");
  console.log(`[DAILY-REPORT] Running daily trainer report for ${reportDateLabel}`);

  const companies = await Company.find({
    isActive: { $ne: false },
    status: { $in: ["active", "Active"] },
  })
    .select("_id name companyCode email adminId")
    .lean();

  for (const company of companies) {
    let tempFilePath = null;
    try {
      let recipientEmail = company.email || null;

      if (!recipientEmail && company.adminId) {
        const admin = await User.findById(company.adminId).select("email").lean();
        recipientEmail = admin?.email || null;
      }

      if (!recipientEmail) {
        console.log(`[DAILY-REPORT] Skipped ${company.name}: no coNDAct email`);
        continue;
      }

      const metrics = await buildCompanyReport(company, dateRef);
      const subject = `MBK Daily Trainer Activity Report - ${reportDateLabel}`;
      const text = [
        `Company: ${company.name}`,
        `Date: ${reportDateLabel}`,
        `Total Trainers: ${metrics.totalTrainers}`,
        `Active Today: ${metrics.activeToday}`,
        `Completed Sessions: ${metrics.completedSessions}`,
        `Pending Attendance: ${metrics.pendingAttendance}`,
      ].join("\n");

      const fileName = `DailyReport-${company.companyCode || company._id}-${dayjs(dateRef).format("YYYYMMDD")}.pdf`;
      tempFilePath = await generateReportPDF(
        {
          companyName: company.name,
          date: reportDateLabel,
          totalTrainers: metrics.totalTrainers,
          activeToday: metrics.activeToday,
          completedSessions: metrics.completedSessions,
          pendingAttendance: metrics.pendingAttendance,
        },
        fileName,
      );

      await sendMail(
        recipientEmail,
        subject,
        text,
        dailyTrainerReportEmail({
          companyName: company.name,
          date: reportDateLabel,
          totalTrainers: metrics.totalTrainers,
          activeToday: metrics.activeToday,
          completedSessions: metrics.completedSessions,
          pendingAttendance: metrics.pendingAttendance,
        }),
        [
          {
            filename: fileName,
            path: tempFilePath,
          },
        ],
      );

      console.log(`[DAILY-REPORT] Sent: ${company.name} -> ${recipientEmail}`);
    } catch (error) {
      console.error(
        `[DAILY-REPORT] Failed for ${company?.name || "Unknown Company"}:`,
        error.message,
      );
    } finally {
      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath);
        } catch (cleanupError) {
          console.error(
            `[DAILY-REPORT] Temp file cleanup failed (${tempFilePath}):`,
            cleanupError.message,
          );
        }
      }
    }
  }
};

const init = () => {
  const cronExpr = process.env.DAILY_TRAINER_REPORT_CRON || "0 19 * * *";
  const timezone = process.env.DAILY_TRAINER_REPORT_TIMEZONE || "Asia/Kolkata";

  cron.schedule(
    cronExpr,
    () => {
      sendDailyTrainerReports().catch((error) => {
        console.error("[DAILY-REPORT] Job crashed:", error);
      });
    },
    { timezone },
  );

  console.log(
    `[DAILY-REPORT] Service initialized (cron: ${cronExpr}, timezone: ${timezone})`,
  );
};

module.exports = {
  init,
  sendDailyTrainerReports,
  buildCompanyReport,
};
