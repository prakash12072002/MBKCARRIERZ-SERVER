const cron = require("node-cron");
const dayjs = require("dayjs");
const { Trainer, TrainerDocument, Notification } = require("../models");
const {
  evaluateTrainerDocumentWorkflow,
  resolveTrainerRegistrationStatus,
  resolveTrainerResumeStep,
} = require("../utils/trainerDocumentWorkflow");
const {
  sendTrainerRegistrationReminderEmail,
} = require("../utils/emailService");

const REMINDER_DAY_MILESTONES = [1, 3];
const TRAINER_SIGNUP_BASE_URL = `${
  process.env.FRONTEND_URL || "http://localhost:3000"
}/trainer-signup`;

const getPendingDetailItems = (trainer = {}) => {
  const pendingItems = [];

  if (!String(trainer.firstName || "").trim()) pendingItems.push("First Name");
  if (!String(trainer.lastName || "").trim()) pendingItems.push("Last Name");
  if (!String(trainer.mobile || trainer.phone || "").trim()) {
    pendingItems.push("Phone Number");
  }
  if (!String(trainer.city || "").trim() && !trainer.cityId) pendingItems.push("City");
  if (!String(trainer.qualification || "").trim()) pendingItems.push("Qualification");
  if (!String(trainer.specialization || "").trim()) pendingItems.push("Specialization");
  if (trainer.experience === null || trainer.experience === undefined || trainer.experience === "") {
    pendingItems.push("Experience");
  }
  if (!String(trainer.address || "").trim()) pendingItems.push("Full Address");

  return pendingItems;
};

const getStepUrl = (step) =>
  step <= 1 ? TRAINER_SIGNUP_BASE_URL : `${TRAINER_SIGNUP_BASE_URL}/step${step}`;

const buildReminderContext = async (trainer) => {
  const trainerDocuments = await TrainerDocument.find({ trainerId: trainer._id });
  const workflow = evaluateTrainerDocumentWorkflow(trainer, trainerDocuments);
  const registrationStatus = resolveTrainerRegistrationStatus(trainer, workflow);
  const currentStep =
    registrationStatus === "pending"
      ? resolveTrainerResumeStep(trainer, workflow)
      : 6;

  if (registrationStatus !== "pending" || currentStep >= 6) {
    return {
      canRemind: false,
      workflow,
      currentStep,
      actionKey: `closed:${registrationStatus}:${currentStep}`,
    };
  }

  if (currentStep === 2) {
    return {
      canRemind: true,
      workflow,
      currentStep,
      actionKey: "step2:details",
      nextStepLabel: "Personal Details",
      pendingLabel: "Pending profile fields",
      pendingItems: getPendingDetailItems(trainer),
      actionLabel: "Complete Personal Details",
      loginUrl: getStepUrl(2),
      notificationMessage:
        "Your trainer registration is pending at Personal Details. Complete your profile to continue onboarding.",
    };
  }

  if (currentStep === 3) {
    if (workflow.hasRejectedDocuments) {
      const rejectedKeys = workflow.rejectedDocuments
        .map((item) => item.key)
        .sort()
        .join(",");

      return {
        canRemind: true,
        workflow,
        currentStep,
        actionKey: `step3:rejected:${rejectedKeys}`,
        nextStepLabel: "Upload Documents",
        pendingLabel: "Rejected documents to replace",
        pendingItems: workflow.rejectedDocuments.map((item) => item.label),
        actionLabel: "Upload Corrected Documents",
        loginUrl: getStepUrl(3),
        notificationMessage:
          "Some of your trainer documents were rejected. Re-upload the rejected documents to continue onboarding.",
      };
    }

    if (!workflow.hasAllRequiredDocuments) {
      const missingKeys = workflow.missingDocuments
        .map((item) => item.key)
        .sort()
        .join(",");

      return {
        canRemind: true,
        workflow,
        currentStep,
        actionKey: `step3:missing:${missingKeys}`,
        nextStepLabel: "Upload Documents",
        pendingLabel: "Pending documents",
        pendingItems: workflow.missingDocuments.map((item) => item.label),
        actionLabel: "Upload Missing Documents",
        loginUrl: getStepUrl(3),
        notificationMessage:
          "Your trainer registration is waiting for document uploads. Upload the pending documents to continue onboarding.",
      };
    }

    return {
      canRemind: false,
      workflow,
      currentStep,
      actionKey: "step3:admin-review",
    };
  }

  if (currentStep === 4) {
    return {
      canRemind: true,
      workflow,
      currentStep,
      actionKey: "step4:agreement",
      nextStepLabel: "Agreement",
      pendingLabel: "Pending action",
      pendingItems: ["Review the NDA and submit your signature"],
      actionLabel: "Complete Agreement",
      loginUrl: getStepUrl(4),
      notificationMessage:
        "Your documents are approved. Complete the Agreement step to continue trainer onboarding.",
    };
  }

  if (currentStep === 5) {
    return {
      canRemind: true,
      workflow,
      currentStep,
      actionKey: "step5:password",
      nextStepLabel: "Set Password",
      pendingLabel: "Pending action",
      pendingItems: ["Create your account password to finish registration"],
      actionLabel: "Set Password",
      loginUrl: getStepUrl(5),
      notificationMessage:
        "Your trainer onboarding is almost complete. Set your password to finish registration.",
    };
  }

  return {
    canRemind: false,
    workflow,
    currentStep,
    actionKey: `step${currentStep}:idle`,
  };
};

const saveReminderState = async (trainer, context, now, { clear = false } = {}) => {
  trainer.registrationReminderState = trainer.registrationReminderState || {};
  trainer.registrationReminderState.activeStep = context.currentStep || null;
  trainer.registrationReminderState.activeActionKey = clear
    ? context.actionKey || null
    : context.actionKey;
  trainer.registrationReminderState.anchorAt = clear ? null : now;
  trainer.registrationReminderState.milestonesSent = clear ? [] : [];
  trainer.registrationReminderState.lastReminderSentAt = clear ? null : null;
  await trainer.save();
};

const clearReminderStateIfNeeded = async (trainer, context) => {
  const state = trainer.registrationReminderState || {};
  const hasState = Boolean(
    state.activeStep ||
      state.activeActionKey ||
      state.anchorAt ||
      (Array.isArray(state.milestonesSent) && state.milestonesSent.length > 0) ||
      state.lastReminderSentAt,
  );

  if (!hasState) {
    return;
  }

  await saveReminderState(trainer, context, null, { clear: true });
};

const sendReminderForTrainer = async (trainer, now = dayjs()) => {
  const context = await buildReminderContext(trainer);
  const reminderState = trainer.registrationReminderState || {};

  if (!context.canRemind) {
    await clearReminderStateIfNeeded(trainer, context);
    return;
  }

  if (
    reminderState.activeStep !== context.currentStep ||
    reminderState.activeActionKey !== context.actionKey ||
    !reminderState.anchorAt
  ) {
    await saveReminderState(trainer, context, now.toDate());
    return;
  }

  const sentMilestones = Array.isArray(reminderState.milestonesSent)
    ? reminderState.milestonesSent.map((value) => Number(value))
    : [];
  const daysPending = dayjs(now).startOf("day").diff(
    dayjs(reminderState.anchorAt).startOf("day"),
    "day",
  );
  const dueMilestone = REMINDER_DAY_MILESTONES.filter(
    (milestone) => daysPending >= milestone && !sentMilestones.includes(milestone),
  ).pop();

  if (!dueMilestone) {
    return;
  }

  const trainerName =
    [trainer.firstName, trainer.lastName].filter(Boolean).join(" ").trim() ||
    trainer.email?.split("@")[0] ||
    "Trainer";
  const emailResult = await sendTrainerRegistrationReminderEmail({
    trainerEmail: trainer.email,
    trainerName,
    nextStepLabel: context.nextStepLabel,
    reminderDay: dueMilestone,
    pendingItems: context.pendingItems,
    pendingLabel: context.pendingLabel,
    actionLabel: context.actionLabel,
    loginUrl: context.loginUrl,
  });

  if (!emailResult?.success) {
    return;
  }

  if (trainer.userId) {
    await Notification.create({
      userId: trainer.userId,
      role: "Trainer",
      title: `Reminder: Complete ${context.nextStepLabel}`,
      message: context.notificationMessage,
      type: "System",
      link: context.loginUrl.replace(TRAINER_SIGNUP_BASE_URL, "/trainer-signup"),
    });
  }

  trainer.registrationReminderState = trainer.registrationReminderState || {};
  trainer.registrationReminderState.activeStep = context.currentStep;
  trainer.registrationReminderState.activeActionKey = context.actionKey;
  trainer.registrationReminderState.anchorAt = reminderState.anchorAt;
  trainer.registrationReminderState.milestonesSent = Array.from(
    new Set([...sentMilestones, dueMilestone]),
  ).sort((left, right) => left - right);
  trainer.registrationReminderState.lastReminderSentAt = now.toDate();
  await trainer.save();
};

const runTrainerOnboardingReminders = async () => {
  console.log("[TRAINER-ONBOARDING-REMINDER] Running reminder job...");

  try {
    const trainers = await Trainer.find({
      email: { $exists: true, $ne: null },
      registrationStatus: "pending",
      status: { $ne: "APPROVED" },
    }).select(
      "_id userId email firstName lastName mobile phone city cityId qualification specialization experience address documents agreementAccepted agreemeNDAccepted signature passwordHash registrationStatus registrationStep status verificationStatus registrationReminderState",
    );

    for (const trainer of trainers) {
      try {
        await sendReminderForTrainer(trainer, dayjs());
      } catch (trainerError) {
        console.error(
          `[TRAINER-ONBOARDING-REMINDER] Failed for ${trainer.email}:`,
          trainerError,
        );
      }
    }
  } catch (error) {
    console.error("[TRAINER-ONBOARDING-REMINDER] Job failed:", error);
  }
};

const init = () => {
  cron.schedule("0 10 * * *", () => {
    runTrainerOnboardingReminders();
  });

  runTrainerOnboardingReminders();
  console.log(
    "[TRAINER-ONBOARDING-REMINDER] Service initialized (Job: daily at 10:00)",
  );
};

module.exports = {
  init,
  runTrainerOnboardingReminders,
  buildReminderContext,
};

