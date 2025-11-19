const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true
  },
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  talent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  gig: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig',
    required: true
  },
  package: {
    name: String,
    price: Number,
    deliveryTime: {
      value: Number,
      unit: String
    },
    features: [String]
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'USD'
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'in-progress', 'delivered', 'completed', 'cancelled'],
    default: 'pending'
  },
  deliveryDate: Date,
  completedDate: Date,
  requirements: String,
  deliverables: [{
    description: String,
    status: {
      type: String,
      enum: ['pending', 'submitted', 'approved'],
      default: 'pending'
    },
    file: String
  }],
  revisions: {
    requested: {
      type: Number,
      default: 0
    },
    maxAllowed: {
      type: Number,
      default: 1
    }
  },
  chat: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat'
  },
  payment: {
    status: {
      type: String,
      enum: ['pending', 'completed', 'refunded'],
      default: 'pending'
    },
    method: String,
    transactionId: String
  }
}, {
  timestamps: true
});

// Generate order number before saving
orderSchema.pre('save', function(next) {
  if (this.isNew && !this.orderNumber) {
    this.orderNumber = `WL${Date.now()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
  }
  next();
});

// Index for queries
orderSchema.index({ client: 1, createdAt: -1 });
orderSchema.index({ talent: 1, createdAt: -1 });
orderSchema.index({ gig: 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ orderNumber: 1 });

module.exports = mongoose.model('Order', orderSchema);
