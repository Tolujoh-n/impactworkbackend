const mongoose = require('mongoose');

const stakingSchema = new mongoose.Schema({
  stakeId: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  stakedAt: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  unlockTime: {
    type: Date,
    default: null
  },
  isLocked: {
    type: Boolean,
    default: false,
    index: true
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  unstakedAt: {
    type: Date,
    default: null
  },
  txHash: {
    type: String,
    required: true
  },
  unstakeTxHash: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
stakingSchema.index({ walletAddress: 1, isActive: 1 });
stakingSchema.index({ isActive: 1, isLocked: 1 });
stakingSchema.index({ unlockTime: 1 });

module.exports = mongoose.model('Staking', stakingSchema);
