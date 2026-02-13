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
    enum: ['graphics-design', 'digital-marketing', 'writing-translation', 'video-animation', 'music-audio', 'programming-tech', 'business', 'lifestyle', 'data', 'photography', 'online-marketing', 'translation', 'other']
  },
  subCategory: {
    type: String,
    required: false
  },
  type: {
    type: String,
    required: true,
    enum: ['professional', 'labour']
  },
  pricing: {
    // New structure: basic/premium offers with details
    basic: {
      price: Number,
      deliveryTime: {
        value: Number,
        unit: String
      },
      pros: [String],
      cons: [String]
    },
    premium: {
      price: Number,
      deliveryTime: {
        value: Number,
        unit: String
      },
      pros: [String],
      cons: [String]
    },
    // Legacy support for old pricing format
    standard: Number,
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
    enum: ['active', 'paused', 'completed', 'cancelled', 'archived'],
    default: 'active'
  },
  orders: [{
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    package: {
      type: String,
      enum: ['basic', 'premium'],
      default: 'basic'
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
    },
    approvedAt: {
      type: Date
    },
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chat'
    }
  }],
  orderCount: {
    type: Number,
    default: 0
  },
  tags: [String],
  imageUrl: {
    type: String,
    required: true // Mandatory for gigs
  },
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