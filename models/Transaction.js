const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  fromUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  toUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  type: {
    type: String,
    enum: [
      'deposit',
      'withdrawal',
      'transfer',
      'swap',
      'escrow_deposit',
      'escrow_in_progress',
      'escrow_completion',
      'escrow_disburse',
      'escrow_confirm',
      'escrow_release',
      'job_payment',
      'gig_payment',
      'refund',
      'bonus',
      'referral',
      'deployer_set_fee',
      'deployer_add_funds',
      'deployer_withdraw',
      'deployer_check_balance',
      'deployer_verify',
      'staking_pool_fund',
      'staking_pool_add',
      'staking_pool_withdraw',
      'dao_pool_fund_eth',
      'dao_pool_withdraw_eth',
      'dao_pool_fund_lob',
      'dao_pool_withdraw_lob',
      'dao_set_voter_reward',
      'blog_withdrawal'
    ],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  description: {
    type: String,
    required: true
  },
  job: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job'
  },
  gig: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig'
  },
  paymentMethod: {
    type: String,
    enum: ['credit_card', 'bank_transfer', 'paypal', 'stripe', 'wallet']
  },
  bankAccount: {
    accountNumber: String,
    routingNumber: String,
    bankName: String
  },
  externalId: String, // External payment processor ID
  fees: {
    type: Number,
    default: 0
  },
  currency: {
    type: String,
    default: 'USD'
  },
  chat: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat'
  },
  // On-chain transaction fields
  isOnChain: {
    type: Boolean,
    default: false
  },
  txHash: {
    type: String,
    unique: true,
    sparse: true
  },
  tokenAddress: String,
  tokenSymbol: String,
  fromAddress: String,
  toAddress: String,
  blockNumber: Number,
  gasUsed: Number,
  gasPrice: Number,
  direction: {
    type: String,
    enum: ['credit', 'debit'],
    default: 'credit'
  },
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true
});

// Index for efficient queries
transactionSchema.index({ fromUser: 1, createdAt: -1 });
transactionSchema.index({ toUser: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);