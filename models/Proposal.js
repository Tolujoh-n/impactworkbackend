const mongoose = require('mongoose');

const DAO_VOTE_OPTIONS = [
  'approve',
  'reject',
  'abstain',
  'client_refund',
  'talent_refund',
  'split_funds'
];

const proposalSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  summary: {
    type: String,
    default: ''
  },
  description: {
    type: String,
    required: true
  },
  proposer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  proposalType: {
    type: String,
    enum: ['platform', 'dispute'],
    required: true
  },
  category: {
    type: String,
    enum: ['platform', 'feature', 'policy', 'dispute', 'other'],
    required: true
  },
  status: {
    type: String,
    enum: ['voting', 'awaiting_resolution', 'passed', 'rejected', 'resolved'],
    default: 'voting'
  },
  voting: {
    startsAt: {
      type: Date,
      default: Date.now
    },
    endsAt: {
      type: Date,
      required: true
    },
    durationDays: {
      type: Number,
      default: 5
    },
    minActivityPoints: {
      type: Number,
      default: 9
    },
    finalDecision: {
      type: String,
      enum: DAO_VOTE_OPTIONS
    },
    finalizedAt: Date,
    autoFinalized: {
      type: Boolean,
      default: false
    },
    quorum: {
      type: Number,
      default: 0
    }
  },
  votes: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    vote: {
      type: String,
      enum: DAO_VOTE_OPTIONS,
      required: true
    },
    reason: {
      type: String,
      default: ''
    },
    votedAt: {
      type: Date,
      default: Date.now
    }
  }],
  voteTallies: {
    approve: {
      type: Number,
      default: 0
    },
    reject: {
      type: Number,
      default: 0
    },
    abstain: {
      type: Number,
      default: 0
    },
    client_refund: {
      type: Number,
      default: 0
    },
    talent_refund: {
      type: Number,
      default: 0
    },
    split_funds: {
      type: Number,
      default: 0
    },
    total: {
      type: Number,
      default: 0
    }
  },
  analytics: {
    participationRate: {
      type: Number,
      default: 0
    },
    totalEligibleVoters: {
      type: Number,
      default: 0
    },
    uniqueVoters: {
      type: Number,
      default: 0
    }
  },
  tags: [{
    type: String,
    trim: true
  }],
  attachments: [{
    filename: String,
    originalName: String,
    mimeType: String,
    size: Number,
    url: String
  }],
  platformDetails: {
    problemStatement: String,
    proposedSolution: String,
    impact: String,
    implementationPlan: String,
    successMetrics: String,
    dependencies: String
  },
  disputeContext: {
    job: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'disputeContext.jobModel'
    },
    jobModel: {
      type: String,
      enum: ['Job', 'Order', 'Gig', 'Chat']
    },
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    talent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    issueSummary: String,
    clientNarrative: String,
    talentNarrative: String,
    attachments: [{
      filename: String,
      originalName: String,
      mimeType: String,
      size: Number,
      url: String
    }],
    history: [{
      label: String,
      description: String,
      occurredAt: Date
    }],
    collaborationThread: [{
      sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      role: {
        type: String,
        enum: ['client', 'talent', 'dao']
      },
      message: String,
      attachments: [{
        filename: String,
        originalName: String,
        mimeType: String,
        size: Number,
        url: String
      }],
      createdAt: {
        type: Date,
        default: Date.now
      }
    }],
    generalComments: [{
      commenter: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      comment: String,
      createdAt: {
        type: Date,
        default: Date.now
      }
    }],
    settlement: {
      talentAmount: {
        type: Number,
        default: null
      },
      clientAmount: {
        type: Number,
        default: null
      },
      talentApproved: {
        type: Boolean,
        default: false
      },
      clientApproved: {
        type: Boolean,
        default: false
      },
      settledByAgreement: {
        type: Boolean,
        default: false
      },
      settledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      resolvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      resolvedAt: Date,
      updatedAt: Date
    }
  },
  comments: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    comment: String,
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  resolution: {
    outcome: {
      type: String,
      enum: DAO_VOTE_OPTIONS
    },
    summary: String,
    decidedAt: Date,
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    resolvedAt: Date,
    notes: String
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for search functionality
proposalSchema.index({ title: 'text', description: 'text', summary: 'text', tags: 'text' });
proposalSchema.index({ category: 1, status: 1, proposalType: 1 });
proposalSchema.index({ proposer: 1 });
proposalSchema.index({ 'voting.endsAt': 1 });
proposalSchema.index({ createdAt: -1 });

proposalSchema.methods.isVotingOpen = function() {
  const now = new Date();
  return this.status === 'voting' && now <= this.voting.endsAt;
};

proposalSchema.methods.allowedVoteOptions = function() {
  if (this.proposalType === 'platform') {
    return ['approve', 'reject', 'abstain'];
  }
  return ['client_refund', 'talent_refund', 'split_funds'];
};

proposalSchema.methods.recalculateTallies = function() {
  if (!this.voteTallies) {
    this.voteTallies = {};
  }

  const tallies = {
    approve: 0,
    reject: 0,
    abstain: 0,
    client_refund: 0,
    talent_refund: 0,
    split_funds: 0,
    total: 0
  };

  this.votes.forEach(vote => {
    if (tallies[vote.vote] !== undefined) {
      tallies[vote.vote] += 1;
      tallies.total += 1;
    }
  });

  this.voteTallies = tallies;
  this.markModified('voteTallies');
  if (!this.analytics) {
    this.analytics = {};
  }
  this.analytics.uniqueVoters = this.votes.length;
  this.markModified('analytics');
};

proposalSchema.methods.finalizeIfNeeded = function() {
  const now = new Date();

  if (this.voting.autoFinalized || this.voting.endsAt > now) {
    return;
  }

  this.recalculateTallies();

  let decision;
  const options = this.allowedVoteOptions();
  const optionTallies = options.map(option => ({
    option,
    total: this.voteTallies[option] || 0
  }));

  optionTallies.sort((a, b) => b.total - a.total);

  if (optionTallies[0] && optionTallies[0].total > 0) {
    decision = optionTallies[0].option;
  }

  this.voting.finalDecision = decision || undefined;
  this.voting.finalizedAt = now;
  this.voting.autoFinalized = true;
  this.markModified('voting');

  if (!decision) {
    this.status = 'rejected';
  } else if (this.proposalType === 'platform') {
    this.status = decision === 'approve' ? 'passed' : 'rejected';
  } else {
    this.status = 'awaiting_resolution';
  }

  if (!this.resolution) {
    this.resolution = {};
  }

  this.resolution.outcome = decision || undefined;
  this.resolution.decidedAt = now;
  this.markModified('resolution');
};

module.exports = mongoose.model('Proposal', proposalSchema);
