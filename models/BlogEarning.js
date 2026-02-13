const mongoose = require('mongoose');

const blogEarningSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  blog: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Blog',
    required: true
  },
  type: {
    type: String,
    enum: ['view', 'impression'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'available', 'withdrawn'],
    default: 'available'
  },
  withdrawnAt: Date
}, {
  timestamps: true
});

blogEarningSchema.index({ user: 1, status: 1 });
blogEarningSchema.index({ blog: 1 });

module.exports = mongoose.model('BlogEarning', blogEarningSchema);
