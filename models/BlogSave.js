const mongoose = require('mongoose');

const blogSaveSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  blog: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Blog',
    required: true
  }
}, {
  timestamps: true
});

// Ensure unique user-blog pairs
blogSaveSchema.index({ user: 1, blog: 1 }, { unique: true });
blogSaveSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('BlogSave', blogSaveSchema);
