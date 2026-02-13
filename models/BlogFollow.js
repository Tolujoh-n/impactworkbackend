const mongoose = require('mongoose');

const blogFollowSchema = new mongoose.Schema({
  follower: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  following: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Ensure unique follower-following pairs
blogFollowSchema.index({ follower: 1, following: 1 }, { unique: true });
blogFollowSchema.index({ following: 1 });

module.exports = mongoose.model('BlogFollow', blogFollowSchema);
