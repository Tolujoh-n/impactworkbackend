const mongoose = require('mongoose');

const blogSectionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['text', 'heading', 'image', 'video', 'quote', 'code', 'table', 'list'],
    required: true
  },
  content: mongoose.Schema.Types.Mixed, // Can be string, object, array depending on type
  order: {
    type: Number,
    required: true
  }
}, { _id: true });

const blogSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  excerpt: {
    type: String,
    maxlength: 300,
    trim: true
  },
  thumbnail: {
    type: String,
    required: true
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: ['Recruiting', 'News', 'Sport', 'Business', 'Innovation', 'Health', 'Culture', 'Arts', 'Travel', 'Earth', 'Technology', 'Education', 'Entertainment'],
    default: 'News'
  },
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  sections: [blogSectionSchema],
  status: {
    type: String,
    enum: ['draft', 'published', 'archived'],
    default: 'draft'
  },
  featured: {
    type: Boolean,
    default: false
  },
  sponsored: {
    type: Boolean,
    default: false
  },
  priority: {
    type: Number,
    default: 0 // Higher number = higher priority
  },
  // Analytics
  views: {
    type: Number,
    default: 0
  },
  impressions: {
    type: Number,
    default: 0
  },
  likes: {
    type: Number,
    default: 0
  },
  likesBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  // Earnings
  earnings: {
    totalEarned: {
      type: Number,
      default: 0 // Total LOB earned
    },
    available: {
      type: Number,
      default: 0 // Available to withdraw
    },
    withdrawn: {
      type: Number,
      default: 0 // Total withdrawn
    }
  },
  // View/Impression tracking (to prevent spam)
  viewTracking: [{
    ipAddress: String,
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  impressionTracking: [{
    ipAddress: String,
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      sparse: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  // Comments
  comments: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    content: {
      type: String,
      required: true,
      trim: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    likes: {
      type: Number,
      default: 0
    },
    likedBy: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }]
  }],
  publishedAt: {
    type: Date
  },
  // Action Button
  actionButton: {
    text: {
      type: String,
      trim: true
    },
    link: {
      type: String,
      trim: true
    }
  }
}, {
  timestamps: true
});

// Indexes for performance
blogSchema.index({ author: 1, createdAt: -1 });
blogSchema.index({ category: 1, createdAt: -1 });
blogSchema.index({ status: 1, createdAt: -1 });
blogSchema.index({ featured: 1, priority: -1, createdAt: -1 });
blogSchema.index({ sponsored: 1, priority: -1, createdAt: -1 });
blogSchema.index({ slug: 1 });
blogSchema.index({ 'viewTracking.ipAddress': 1, 'viewTracking.timestamp': 1 });
blogSchema.index({ 'impressionTracking.ipAddress': 1, 'impressionTracking.timestamp': 1 });

// Generate slug from title
blogSchema.pre('save', function(next) {
  if (this.isModified('title') && !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
  if (this.isModified('status') && this.status === 'published' && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  next();
});

module.exports = mongoose.model('Blog', blogSchema);
