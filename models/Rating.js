const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  fromUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  toUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  chat: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat'
  },
  job: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job'
  },
  gig: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig'
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  comment: String,
  categories: {
    communication: {
      type: Number,
      min: 1,
      max: 5
    },
    quality: {
      type: Number,
      min: 1,
      max: 5
    },
    timeliness: {
      type: Number,
      min: 1,
      max: 5
    },
    professionalism: {
      type: Number,
      min: 1,
      max: 5
    }
  },
  type: {
    type: String,
    enum: ['job', 'gig', 'profile'],
    default: 'profile'
  },
  isVisible: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for queries
ratingSchema.index({ toUser: 1, createdAt: -1 });
ratingSchema.index({ fromUser: 1 });
ratingSchema.index({ chat: 1 });
ratingSchema.index({ rating: 1 });

// Ensure one rating per chat when chat is provided
ratingSchema.index(
  { chat: 1, fromUser: 1 },
  { unique: true, partialFilterExpression: { chat: { $exists: true } } }
);

// Ensure a single rating relationship between users
ratingSchema.index({ fromUser: 1, toUser: 1 }, { unique: true });

module.exports = mongoose.model('Rating', ratingSchema);
