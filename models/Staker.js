const mongoose = require('mongoose');

const stakerSchema = new mongoose.Schema({
  walletAddress: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    index: true
  },
  totalStaked: {
    type: Number,
    default: 0
  },
  totalLocked: {
    type: Number,
    default: 0
  },
  claimableRewards: {
    type: Number,
    default: 0
  },
  lastSyncedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Staker', stakerSchema);
