const mongoose = require('mongoose');

const governanceSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  category: {
    type: String,
    enum: ['conflict', 'policy', 'platform', 'feature', 'bug'],
    required: true
  },
  initiator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['draft', 'voting', 'passed', 'rejected', 'implementation'],
    default: 'voting'
  },
  votes: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    vote: {
      type: String,
      enum: ['yes', 'no', 'abstain']
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    activityPoints: Number
  }
  ],
  proposalData: {
    description: String,
    impact: String,
    implementation: String,
    timeline: String
  },
  voteStats: {
    totalVotes: {
      type: Number,
      default: 0
    },
    yesVotes: {
      type: Number,
      default: 0
    },
    noVotes: {
      type: Number,
      default: 0
    },
    abstainVotes: {
      type: Number,
      default: 0
    },
    requiredQuorum: {
      type: Number,
      default: 10
    }
  },
  votingPeriod: {
    startDate: {
      type: Date,
      default: Date.now
    },
    endDate: {
      type: Date,
      default: function() {
        return new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days
      }
    }
  },
  resolution: {
    description: String,
    actions: [String],
    implementedAt: Date
  },
  isActive: {
    type: Boolean
  }
}, {
  timestamps: true
});

// Index for queries
governanceSchema.index({ status: 1, createdAt: -1 });
governanceSchema.index({ category: 1 });
governanceSchema.index({ initiator: 1 });

// Virtual for vote count
governanceSchema.virtual('voteCount').get(function() {
  return this.votes.length;
});

// Check if voting period is active
governanceSchema.methods.isVotingActive = function() {
  return this.status === 'voting' && 
         new Date() >= this.votingPeriod.startDate && 
         new Date() <= this.votingPeriod.endDate;
};

// Add vote
governanceSchema.methods.addVote = function(userId, voteType, userActivityPoints) {
  // Remove existing vote from user
  this.votes = this.votes.filter(vote => !vote.user.equals(userId));
  
  // Add new vote
  this.votes.push({
    user: userId,
    vote: voteType,
    activityPoints: userActivityPoints,
    timestamp: new Date()
  });

  // Update vote stats
  this.updateVoteStats();
  
  // Check if proposal should be passed/failed
  this.checkVotingResult();
  
  return this.save();
};

// Update vote statistics
governanceSchema.methods.updateVoteStats = function() {
  this.voteStats.totalVotes = this.votes.length;
  this.voteStats.yesVotes = this.votes.filter(v => v.vote === 'yes').length;
  this.voteStats.noVotes = this.votes.filter(v => v.vote === 'no').length;
  this.voteStats.abstainVotes = this.votes.filter(v => v.vote === 'abstain').length;
};

// Check voting result
governanceSchema.methods.checkVotingResult = function() {
  if (!this.isVotingActive()) return;

  const totalActivityPoints = this.votes.reduce((sum, vote) => sum + (vote.activityPoints || 0), 0);
  
  if (totalActivityPoints >= this.voteStats.requiredQuorum) {
    if (this.voteStats.yesVotes > this.voteStats.noVotes) {
      this.status = 'passed';
    } else {
      this.status = 'rejected';
    }
  }
};

module.exports = mongoose.model('Governance', governanceSchema);
