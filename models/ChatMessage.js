const mongoose = require("mongoose");

const MESSAGE_TYPES = ["text", "image", "video", "pdf", "audio", "voice"];
const MESSAGE_STATUS = ["sent", "delivered", "read"];

const chatMessageSchema = new mongoose.Schema(
  {
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    roomId: {
      type: String,
      trim: true,
      index: true,
      default: null,
    },
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: MESSAGE_TYPES,
      default: "text",
      required: true,
    },
    text: {
      type: String,
      trim: true,
      default: "",
    },
    content: {
      type: String,
      trim: true,
      default: "",
    },
    mediaUrl: {
      type: String,
      trim: true,
      default: null,
    },
    fileUrl: {
      type: String,
      trim: true,
      default: null,
    },
    mimeType: {
      type: String,
      trim: true,
      default: null,
    },
    fileName: {
      type: String,
      trim: true,
      default: null,
    },
    fileSize: {
      type: Number,
      default: null,
    },
    tempId: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    duration: {
      type: Number,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: MESSAGE_STATUS,
      default: "sent",
    },
    hiddenFor: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedForEveryoneAt: {
      type: Date,
      default: null,
    },
    deletedForEveryoneBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

chatMessageSchema.pre("validate", function syncLegacyAndCanonicalFields(next) {
  if (!this.content && this.text) {
    this.content = this.text;
  }
  if (!this.text && this.content) {
    this.text = this.content;
  }
  if (!this.fileUrl && this.mediaUrl) {
    this.fileUrl = this.mediaUrl;
  }
  if (!this.mediaUrl && this.fileUrl) {
    this.mediaUrl = this.fileUrl;
  }
  next();
});

chatMessageSchema.index({ roomId: 1, createdAt: -1 });
chatMessageSchema.index({ chatId: 1, createdAt: -1 });
chatMessageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });
chatMessageSchema.index({ hiddenFor: 1 });
chatMessageSchema.index({ content: "text", text: "text" });

module.exports = mongoose.model("ChatMessage", chatMessageSchema);
