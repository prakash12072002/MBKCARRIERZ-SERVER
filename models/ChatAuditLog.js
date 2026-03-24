const mongoose = require('mongoose');

const chatAuditLogSchema = new mongoose.Schema({
  messageId: { type: String, default: null, index: true },
  channelId: { type: String, default: null, index: true },
  chatId: { type: String, default: null, index: true },
  roomId: { type: String, default: null, index: true },
  action: { type: String, required: true, index: true },
  event: { type: String, default: null, index: true },
  status: {
    type: String,
    enum: ['success', 'failed', 'info'],
    default: 'info',
    index: true,
  },
  lane: {
    type: String,
    enum: ['chat', 'group', 'broadcast', 'system', 'unknown'],
    default: 'unknown',
    index: true,
  },
  source: {
    type: String,
    enum: ['api', 'socket', 'stream', 'system'],
    default: 'system',
    index: true,
  },
  actorId: { type: String, required: true },
  actorName: { type: String },
  actorRole: { type: String },
  senderId: { type: String, default: null, index: true },
  senderRole: { type: String, default: null, index: true },
  targetUserIds: { type: [String], default: [] },
  uiEvent: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed },
  errorMessage: { type: String, default: null },
  timestamp: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('ChatAuditLog', chatAuditLogSchema);
