const mongoose = require("mongoose");
const {
  NDA_TEMPLATE_KEY,
  DEFAULT_NDA_TEMPLATE,
} = require("../utils/ndaTemplate");

const ndaTemplateSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: NDA_TEMPLATE_KEY,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      default: DEFAULT_NDA_TEMPLATE.title,
      trim: true,
    },
    introText: {
      type: String,
      required: true,
      default: DEFAULT_NDA_TEMPLATE.introText,
      trim: true,
    },
    content: {
      type: String,
      required: true,
      default: DEFAULT_NDA_TEMPLATE.content,
      trim: true,
    },
    checkboxLabel: {
      type: String,
      required: true,
      default: DEFAULT_NDA_TEMPLATE.checkboxLabel,
      trim: true,
    },
    acceptanceConditions: {
      type: [String],
      default: () => [...DEFAULT_NDA_TEMPLATE.acceptanceConditions],
    },
    version: {
      type: Number,
      default: DEFAULT_NDA_TEMPLATE.version,
      min: 1,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("NdaTemplate", ndaTemplateSchema);
