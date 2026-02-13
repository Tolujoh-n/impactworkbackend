const mongoose = require('mongoose');

const configSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for faster lookups
configSchema.index({ key: 1 });

// Static method to get config value with default
configSchema.statics.getValue = async function(key, defaultValue = null) {
  const config = await this.findOne({ key });
  return config ? config.value : defaultValue;
};

// Static method to set config value
configSchema.statics.setValue = async function(key, value, description = '', updatedBy = null) {
  const config = await this.findOneAndUpdate(
    { key },
    {
      value,
      description,
      updatedBy,
      updatedAt: new Date()
    },
    {
      upsert: true,
      new: true
    }
  );
  return config;
};

module.exports = mongoose.model('Config', configSchema);
