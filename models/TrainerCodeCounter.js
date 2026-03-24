const mongoose = require("mongoose");

const trainerCodeCounterSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    seq: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("TrainerCodeCounter", trainerCodeCounterSchema);
