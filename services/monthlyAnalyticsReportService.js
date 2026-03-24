const cron = require("node-cron");
const dayjs = require("dayjs");
const {
  Company,
  User,
  Trainer,
  Schedule,
  Attendance,
  College,
} = require("../models");
const { sendMail } = require("../utils/emailService");
const monthlyAnalyticsEmail = require("../utils/monthlyAnalyticsEmail");

const getMonthlyBoundaries = (dateRef = dayjs()) => {
  const currentMonthStart = dayjs(dateRef).startOf("month");
  const reportMonthStart = currentMonthStart.subtract(1, "month");
  const reportMonthEnd = reportMonthStart.endOf("month");

  const previousMonthStart = reportMonthStart.subtract(1, "month");
  const previousMonthEnd = previousMonthStart.endOf("month");

  return {
    reportMonthStart,
    reportMonthEnd,
    previousMonthStart,
    previousMonthEnd,
  };
};

const buildMonthlyAnalytics = async (company, dateRef = dayjs()) => {
  const {
    reportMonthStart,
    reportMonthEnd,
    previousMonthStart,
    previousMonthEnd,
  } = getMonthlyBoundaries(dateRef);

  const companyScope = [
    ...(company.companyCode ? [{ companyCode: company.companyCode }] : []),
    { companyId: company._id },
  ];

  const currentSchedules = await Schedule.find({
    scheduledDate: {
      $gte: reportMonthStart.toDate(),
      $lte: reportMonthEnd.toDate(),
    },
    $or: companyScope,
  })
    .select("_id collegeId")
    .lean();

  const previousMonthSessions = await Schedule.countDocuments({
    scheduledDate: {
      $gte: previousMonthStart.toDate(),
      $lte: previousMonthEnd.toDate(),
    },
    $or: companyScope,
  });

  const totalSessions = currentSchedules.length;
  const scheduleIds = currentSchedules.map((schedule) => schedule._id);

  const totalTrainers = company.companyCode
    ? await Trainer.countDocuments({ companyCode: company.companyCode })
    : 0;

  const totalColleges = await College.countDocuments({
    $or: [
      ...(company.companyCode ? [{ companyCode: company.companyCode }] : []),
      { companyId: company._id },
    ],
  });

  let attendanceRate = 0;
  if (scheduleIds.length > 0) {
    const submittedDistinctSchedules = await Attendance.distinct("scheduleId", {
      scheduleId: { $in: scheduleIds },
      date: { $gte: reportMonthStart.toDate(), $lte: reportMonthEnd.toDate() },
    });
    attendanceRate = (submittedDistinctSchedules.length / totalSessions) * 100;
  }

  let growthPercent = 0;
  if (previousMonthSessions > 0) {
    growthPercent =
      ((totalSessions - previousMonthSessions) / previousMonthSessions) * 100;
  } else if (totalSessions > 0) {
    growthPercent = 100;
  }

  return {
    monthLabel: reportMonthStart.format("MMMM YYYY"),
    totalTrainers,
    totalSessions,
    totalColleges,
    attendanceRate: attendanceRate.toFixed(1),
    growthPercent: growthPercent.toFixed(1),
  };
};

const sendMonthlyAnalyticsReports = async (dateRef = dayjs()) => {
  const companies = await Company.find({
    isActive: { $ne: false },
    status: { $in: ["active", "Active"] },
  })
    .select("_id name companyCode email adminId")
    .lean();

  for (const company of companies) {
    try {
      let recipientEmail = company.email || null;
      if (!recipientEmail && company.adminId) {
        const admin = await User.findById(company.adminId).select("email").lean();
        recipientEmail = admin?.email || null;
      }

      if (!recipientEmail) {
        console.log(`[MONTHLY-REPORT] Skipped ${company.name}: no coNDAct email`);
        continue;
      }

      const metrics = await buildMonthlyAnalytics(company, dateRef);
      const subject = `MBK Monthly Performance Report - ${metrics.monthLabel}`;
      const text = [
        `Company: ${company.name}`,
        `Month: ${metrics.monthLabel}`,
        `Total Trainers: ${metrics.totalTrainers}`,
        `Total Sessions: ${metrics.totalSessions}`,
        `Colleges Covered: ${metrics.totalColleges}`,
        `Attendance Rate: ${metrics.attendanceRate}%`,
        `Growth: ${metrics.growthPercent}%`,
      ].join("\n");

      await sendMail(
        recipientEmail,
        subject,
        text,
        monthlyAnalyticsEmail({
          companyName: company.name,
          month: metrics.monthLabel,
          totalTrainers: metrics.totalTrainers,
          totalSessions: metrics.totalSessions,
          totalColleges: metrics.totalColleges,
          attendanceRate: metrics.attendanceRate,
          growthPercent: metrics.growthPercent,
        }),
      );

      console.log(`[MONTHLY-REPORT] Sent: ${company.name} -> ${recipientEmail}`);
    } catch (error) {
      console.error(
        `[MONTHLY-REPORT] Failed for ${company?.name || "Unknown Company"}:`,
        error.message,
      );
    }
  }
};

const init = () => {
  const cronExpr = process.env.MONTHLY_ANALYTICS_REPORT_CRON || "0 8 1 * *";
  const timezone = process.env.MONTHLY_ANALYTICS_REPORT_TIMEZONE || "Asia/Kolkata";

  cron.schedule(
    cronExpr,
    () => {
      sendMonthlyAnalyticsReports().catch((error) => {
        console.error("[MONTHLY-REPORT] Job crashed:", error);
      });
    },
    { timezone },
  );

  console.log(
    `[MONTHLY-REPORT] Service initialized (cron: ${cronExpr}, timezone: ${timezone})`,
  );
};

module.exports = {
  init,
  sendMonthlyAnalyticsReports,
  buildMonthlyAnalytics,
};
