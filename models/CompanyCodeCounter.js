const mongoose = require("mongoose");

const companyCodeCounterSchema = new mongoose.Schema(
  {
    year: {
      type: Number,
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

module.exports = mongoose.model("CompanyCodeCounter", companyCodeCounterSchema);
