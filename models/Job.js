const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: ['graphics-design', 'digital-marketing', 'writing-translation', 'video-animation', 'music-audio', 'programming-tech', 'business', 'lifestyle', 'data', 'photography', 'online-marketing', 'translation', 'other']
  },
  subCategory: {
    type: String,
    required: false
  },
  type: {
    type: String,
    required: true,
    enum: ['full-time', 'part-time', 'freelance', 'contract']
  },
  budget: {
    fixed: Number,
    min: Number,
    max: Number
  },
  duration: {
    value: Number,
    unit: {
      type: String,
      enum: ['hours', 'days', 'weeks', 'months']
    }
  },
  location: {
    city: String,
    country: String,
    remote: {
      type: Boolean,
      default: false
    }
  },
  skills: [String],
  requirements: [String],
  deliverables: [String],
  status: {
    type: String,
    enum: ['open', 'in-progress', 'completed', 'cancelled', 'archived'],
    default: 'open'
  },
  applications: [{
    talent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    coverLetter: String,
    bidAmount: Number,
    estimatedDuration: Number,
    attachments: [String],
    status: {
      type: String,
      enum: ['pending', 'accepted', 'in-progress', 'completed', 'rejected'],
      default: 'pending'
    },
    appliedAt: {
      type: Date,
      default: Date.now
    },
    approvedAt: {
      type: Date
    },
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chat'
    }
  }],
  applicationCount: {
    type: Number,
    default: 0
  },
  hiredTalent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  startDate: Date,
  endDate: Date,
  tags: [String],
  imageUrl: {
    type: String,
    required: false // Optional for jobs
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for search functionality
jobSchema.index({ title: 'text', description: 'text', skills: 'text' });
jobSchema.index({ category: 1, type: 1, status: 1 });
jobSchema.index({ client: 1, status: 1 });

// Update application count when applications are added/removed
jobSchema.pre('save', function(next) {
  this.applicationCount = this.applications.length;
  next();
});

module.exports = mongoose.model('Job', jobSchema);