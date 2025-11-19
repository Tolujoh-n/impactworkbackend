const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  participants: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    role: {
      type: String,
      enum: ['talent', 'client'],
      required: true
    },
    joinedAt: {
      type: Date,
      default: Date.now
    }
  }],
  type: {
    type: String,
    enum: ['job', 'gig', 'general'],
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'archived', 'completed'],
    default: 'active'
  },
  workflowStatus: {
    type: String,
    enum: ['offered', 'deposit', 'in-progress', 'completed', 'confirmed'],
    default: 'offered'
  },
  escrow: {
    type: {
      // Identifiers used for smart contract calls (stored during deposit)
      identifiers: {
        jobId: String,
        customerId: String,
        talentId: String,
        chatId: String
      },
      deposit: {
        txHash: String,
        amountUSD: Number,
        amountETH: Number,
        fromAddress: String,
        toAddress: String,
        performedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        },
        occurredAt: Date
      },
      completion: {
        txHash: String,
        fromAddress: String,
        performedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        },
        occurredAt: Date
      },
      confirmation: {
        txHash: String,
        fromAddress: String,
        toAddress: String,
        performedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        },
        occurredAt: Date
      }
    },
    default: {}
  },
  price: {
    original: Number,
    current: Number,
    currency: {
      type: String,
      default: 'USD'
    }
  },
  priceHistory: [{
    amount: Number,
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reason: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  job: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job'
  },
  gig: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig'
  },
  lastMessage: {
    content: String,
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    timestamp: Date
  },
  unreadCount: {
    type: Map,
    of: Number,
    default: new Map()
  }
}, {
  timestamps: true
});

// Index for efficient queries
chatSchema.index({ 'participants.user': 1, status: 1 });
chatSchema.index({ type: 1, status: 1 });
chatSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('Chat', chatSchema);