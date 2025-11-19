const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  referrer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  referredUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  bonusEarned: {
    type: Number,
    default: 10,
    min: 0
  },
  lobTokens: {
    type: Number,
    default: 100,
    min: 0
  },
  activityPoints: {
    type: Number,
    default: 5,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'withdrawn', 'cancelled'],
    default: 'pending'
  },
  approvedAt: {
    type: Date
  },
  withdrawnAt: {
    type: Date
  },
  notes: String
}, {
  timestamps: true
});

// Index for efficient queries
referralSchema.index({ referrer: 1, createdAt: -1 });
referralSchema.index({ referredUser: 1 });
referralSchema.index({ status: 1 });

// Ensure unique referral per user
referralSchema.index({ referrer: 1, referredUser: 1 }, { unique: true });

module.exports = mongoose.model('Referral', referralSchema);
