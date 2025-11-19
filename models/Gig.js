const mongoose = require('mongoose');

const gigSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  talent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: ['web-development', 'mobile-development', 'design', 'writing', 'marketing', 'data-science', 'other']
  },
  type: {
    type: String,
    required: true,
    enum: ['professional', 'labour']
  },
  pricing: {
    basic: Number,
    standard: Number,
    premium: Number,
    min: Number,
    max: Number
  },
  deliveryTime: {
    value: Number,
    unit: {
      type: String,
      enum: ['hours', 'days', 'weeks']
    }
  },
  location: {
    city: String,
    country: String,
    remote: {
      type: Boolean,
      default: true
    }
  },
  includes: [String],
  portfolio: [{
    description: String,
    imageUrl: String,
    videoUrl: String
  }],
  skills: [String],
  status: {
    type: String,
    enum: ['active', 'paused', 'completed', 'cancelled'],
    default: 'active'
  },
  orders: [{
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    requirements: String,
    budget: Number,
    timeline: Number,
    attachments: [String],
    status: {
      type: String,
      enum: ['pending', 'accepted', 'in-progress', 'completed', 'cancelled'],
      default: 'pending'
    },
    orderedAt: {
      type: Date,
      default: Date.now
    }
  }],
  orderCount: {
    type: Number,
    default: 0
  },
  tags: [String],
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for search functionality
gigSchema.index({ title: 'text', description: 'text', skills: 'text' });
gigSchema.index({ category: 1, type: 1, status: 1 });
gigSchema.index({ talent: 1, status: 1 });

// Update order count when orders are added/removed
gigSchema.pre('save', function(next) {
  this.orderCount = this.orders.length;
  next();
});

module.exports = mongoose.model('Gig', gigSchema);