const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat',
    required: true
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  content: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['text', 'image', 'file', 'system'],
    default: 'text'
  },
  attachments: [{
    filename: String,
    originalName: String,
    mimeType: String,
    size: Number,
    url: String
  }],
  isRead: {
    type: Map,
    of: Boolean,
    default: new Map()
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for efficient queries
messageSchema.index({ chatId: 1, timestamp: 1 });
messageSchema.index({ senderId: 1 });
messageSchema.index({ timestamp: -1 });

module.exports = mongoose.model('Message', messageSchema);