const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlenth: 30
  },
  email: {
    type: String,
    required: false, // Not required in schema - validation handled in route
    unique: true,
    sparse: true, // Sparse index: only indexes documents where email exists
    lowercase: true, // Will only apply if email is provided
    trim: true,
    // Don't set default - leave it completely undefined if not provided
    default: undefined
  },
  password: {
    type: String,
    required: false, // Not required in schema - validation handled in route
    validate: {
      validator: function(value) {
        // If password is not provided (undefined/null/empty), validation passes
        // This allows wallet-only users to skip password
        if (value === undefined || value === null || value === '' || !value) {
          return true; // Skip validation for missing passwords
        }
        // If password is provided, it must be at least 6 characters
        if (typeof value === 'string' && value.length >= 6) {
          return true;
        }
        return false;
      },
      message: 'Password must be at least 6 characters'
    },
    select: false // Don't include password in queries by default
  },
  walletAddress: {
    type: String,
    unique: true,
    sparse: true,
    trim: true
  },
  role: {
    type: String,
    enum: ['talent', 'client'],
    default: 'talent'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  profile: {
    firstName: String,
    lastName: String,
    bio: String,
    location: String,
    phone: String,
    avatar: String,
    skills: [String],
    languages: [String],
    socialLinks: {
      website: String,
      github: String,
      linkedin: String,
      twitter: String
    },
    experience: [{
      company: String,
      position: String,
      startDate: Date,
      endDate: Date,
      description: String,
      current: Boolean
    }],
    portfolio: [{
      title: String,
      description: String,
      url: String,
      image: String
    }]
  },
  stats: {
    activityPoints: {
      type: Number,
      default: 0
    },
    dao: {
      votesCast: {
        type: Number,
        default: 0
      },
      proposalsSubmitted: {
        type: Number,
        default: 0
      },
      disputesRaised: {
        type: Number,
        default: 0
      },
      disputesResolved: {
        type: Number,
        default: 0
      },
      commentsPosted: {
        type: Number,
        default: 0
      }
    },
    rating: {
      average: {
        type: Number,
        default: 0
      },
      count: {
        type: Number,
        default: 0
      },
      totalScore: {
        type: Number,
        default: 0
      }
    },
    jobsOffered: {
      type: Number,
      default: 0
    },
    jobsInProgress: {
      type: Number,
      default: 0
    },
    jobsCompleted: {
      type: Number,
      default: 0
    },
    jobsArchived: {
      type: Number,
      default: 0
    }
  },
  wallet: {
    balance: {
      type: Number,
      default: 1000
    },
    escrowBalance: {
      type: Number,
      default: 0
    }
  },
  referral: {
    referralCode: {
      type: String,
      unique: true
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    referrals: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    referralBonus: {
      type: Number,
      default: 0
    },
    lobTokens: {
      pending: {
        type: Number,
        default: 0
      },
      available: {
        type: Number,
        default: 0
      },
      withdrawn: {
        type: Number,
        default: 0
      }
    }
  },
  preferences: {
    theme: {
      type: String,
      enum: ['light', 'dark'],
      default: 'light'
    },
    notifications: {
      email: {
        type: Boolean,
        default: true
      },
      push: {
        type: Boolean,
        default: true
      },
      chat: {
        type: Boolean,
        default: true
      }
    }
  },
  lastSeen: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// CRITICAL: Remove email/password from document if walletAddress is present
// This must run BEFORE validation to prevent sparse unique index issues with null values
userSchema.pre('validate', function(next) {
  try {
    // Only process if walletAddress exists (wallet registration)
    const hasWallet = this.walletAddress || (this._doc && this._doc.walletAddress);
    
    if (hasWallet) {
      console.log('=== PRE-VALIDATE HOOK: Wallet user detected ===');
      console.log('  walletAddress:', this.walletAddress);
      
      // ALWAYS remove email field for wallet users, regardless of its value
      if (this._doc && this._doc.email !== undefined) {
        console.log('  Removing email from _doc (was:', this._doc.email, ')');
        delete this._doc.email;
      }
      if (this.email !== undefined) {
        console.log('  Removing email from instance (was:', this.email, ')');
        delete this.email;
      }
      
      // ALWAYS remove password field for wallet users
      if (this._doc && this._doc.password !== undefined) {
        console.log('  Removing password from _doc');
        delete this._doc.password;
      }
      if (this.password !== undefined) {
        console.log('  Removing password from instance');
        delete this.password;
      }
      
      console.log('  After cleanup - _doc keys:', this._doc ? Object.keys(this._doc) : 'no _doc');
      console.log('  After cleanup - email in _doc?', this._doc && this._doc.email !== undefined);
    }
    next();
  } catch (error) {
    console.error('Error in pre-validate hook:', error);
    next(error);
  }
});

// Additional cleanup in pre-save as backup (runs after pre-validate)
userSchema.pre('save', function(next) {
  try {
    // Double-check for wallet users - ensure email/password are completely gone
    if (this.walletAddress) {
      console.log('=== PRE-SAVE HOOK: Wallet user - final cleanup ===');
      
      // Force remove email field
      if (this._doc && this._doc.email !== undefined) {
        console.log('  PRE-SAVE: Removing email from _doc (was:', this._doc.email, ')');
        delete this._doc.email;
      }
      if (this.email !== undefined) {
        console.log('  PRE-SAVE: Removing email from instance');
        this.email = undefined;
        delete this.email;
      }
      
      // Force remove password field
      if (this._doc && this._doc.password !== undefined) {
        console.log('  PRE-SAVE: Removing password from _doc');
        delete this._doc.password;
      }
      if (this.password !== undefined) {
        console.log('  PRE-SAVE: Removing password from instance');
        this.password = undefined;
        delete this.password;
      }
      
      // Final verification
      console.log('  PRE-SAVE: Final _doc keys:', this._doc ? Object.keys(this._doc) : 'no _doc');
      console.log('  PRE-SAVE: Email still in _doc?', this._doc && this._doc.email !== undefined);
      
      // Final attempt: if email is still in _doc, mark it for removal using Mongoose's isNew check
      // For new documents, we can directly modify _doc
      if (this.isNew && this._doc && this._doc.email !== undefined) {
        console.log('  PRE-SAVE: WARNING - Email still exists in new document, forcing removal');
        // Delete it one more time
        delete this._doc.email;
        // Set the field to undefined explicitly
        this.set('email', undefined, { strict: false });
      }
    }
    next();
  } catch (error) {
    console.error('Error in pre-save hook:', error);
    next(error);
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password') || !this.password) return next();
  
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Generate referral code before saving
userSchema.pre('save', function(next) {
  if (this.isNew && !this.referral.referralCode) {
    this.referral.referralCode = this.username + Math.random().toString(36).substr(2, 6).toUpperCase();
  }
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Check if user can vote in governance
userSchema.methods.canVote = function() {
  return this.stats.activityPoints >= 9;
};

// Check if user can create proposals/disputes
userSchema.methods.canCreateDaoProposal = function() {
  return this.stats.activityPoints >= 10;
};

// Track DAO activity
userSchema.methods.incrementDaoStat = async function(statKey = 'votesCast', incrementBy = 1) {
  if (!this.stats.dao) {
    this.stats.dao = {};
  }
  const currentValue = this.stats.dao[statKey] || 0;
  this.stats.dao[statKey] = currentValue + incrementBy;
  return this.save();
};

// Update activity points
userSchema.methods.addActivityPoints = function(points = 5) {
  this.stats.activityPoints += points;
  return this.save();
};

module.exports = mongoose.model('User', userSchema);
