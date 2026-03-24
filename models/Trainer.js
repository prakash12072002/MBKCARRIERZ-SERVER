const mongoose = require("mongoose");
const TrainerCodeCounter = require("./TrainerCodeCounter");

function generateTrainerCode(sequence) {
  return `MBK${String(sequence).padStart(3, "0")}`;
}

async function getNextTrainerCodeCandidate() {
  const counter = await TrainerCodeCounter.findOneAndUpdate(
    { key: "trainer" },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return generateTrainerCode(counter.seq);
}

async function createUniqueTrainerCode() {
  let trainerCode;
  let exists = true;

  while (exists) {
    trainerCode = await getNextTrainerCodeCandidate();
    const activeTrainer = await mongoose
      .model("Trainer")
      .findOne({ trainerId: trainerCode })
      .select("_id");

    exists = Boolean(activeTrainer);
  }

  return trainerCode;
}

const trainerSchema = new mongoose.Schema(
  {
    // STEP 1: Auth and Verification
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      default: null,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },

    // STEP 2: Personal Details
    firstName: {
      type: String,
      trim: true,
    },
    lastName: {
      type: String,
      trim: true,
    },
    qualification: {
      type: String,
      trim: true,
    },
    mobile: {
      type: String,
      trim: true,
      alias: "phone",
    },
    city: {
      type: String,
      trim: true,
    },
    cityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "City",
    },
    specialization: {
      type: String,
      trim: true,
    },
    experience: {
      type: Number,
      min: 0,
      default: null,
    },
    address: {
      type: String,
      trim: true,
    },

    // STEP 3: Document Uploads (Flat structure as requested)
    documents: {
      aadharFront: { type: String, default: null },
      aadharBack: { type: String, default: null },
      pan: { type: String, default: null },
      degreePdf: { type: String, default: null },
      passbook: { type: String, default: null },
      resumePdf: { type: String, default: null },
      passportPhoto: { type: String, default: null },
      selfiePhoto: { type: String, default: null },
      ndaAgreement: {
        type: String,
        default: null,
        alias: "NDAAgreement",
      },
      ntaAgreement: {
        type: String,
        default: null,
      },
      verification: {
        type: Map,
        of: new mongoose.Schema(
          {
            verified: { type: Boolean, default: false },
            reason: { type: String, default: null },
            updatedAt: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
        default: {},
      },
    },

    // STEP 4: NDA Agreement & Signature
    agreementAccepted: {
      type: Boolean,
      default: false,
      alias: "agreemeNDAccepted",
    },
    signature: {
      type: String, // Store signature as dataURL or file path
      default: null,
    },
    agreementDate: {
      type: Date,
      default: null,
    },
    ndaAgreementPdf: {
      type: String,
      default: null,
      alias: "NDAAgreementPdf",
    },
    ntaAgreementPdf: {
      type: String,
      default: null,
    },

    verificationStatus: {
      type: String,
      enum: ["NOT_SUBMITTED", "PENDING", "VERIFIED", "REJECTED", "APPROVED"],
      default: "NOT_SUBMITTED",
    },
    documentStatus: {
      type: String,
      enum: ["pending", "uploaded", "under_review", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    // STATUS FLOW (Final enum as requested)
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },

    // Approval Information
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    lastApproachedAt: {
      type: Date,
      default: null,
    },
    lastApproachedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // Legacy Support / Internal tracking
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    companyCode: {
      type: String,
      default: null,
      index: true,
      uppercase: true,
      trim: true,
    },
    trainerId: {
      type: String,
      unique: true,
      sparse: true,
    },
    driveFolderId: {
      type: String,
      default: null,
    },
    driveFolderName: {
      type: String,
      default: null,
    },
    profilePicture: {
      type: String, // Maps from selfiePhoto on approval
      default: null,
    },
    registrationStep: {
      type: Number,
      default: 1, // 1: Email verify, 2: Profile, 3: Documents, 4: Agreement, 5: Password, 6: Complete
    },
    registrationStatus: {
      type: String,
      enum: ["pending", "under_review", "approved"],
      default: "pending",
      index: true,
    },
    registrationReminderState: {
      activeStep: {
        type: Number,
        default: null,
      },
      activeActionKey: {
        type: String,
        default: null,
      },
      anchorAt: {
        type: Date,
        default: null,
      },
      milestonesSent: {
        type: [Number],
        default: [],
      },
      lastReminderSentAt: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  },
);

// Auto-generate trainerId as MBK001, MBK002, ... once registration is verified
trainerSchema.pre("save", async function (next) {
  if (!this.trainerId && (this.emailVerified || this.status === "APPROVED")) {
    try {
      this.trainerId = await createUniqueTrainerCode();
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const Trainer = mongoose.model("Trainer", trainerSchema);

module.exports = Trainer;
