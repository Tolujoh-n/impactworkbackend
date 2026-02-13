const express = require('express');
const { body, query, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { auth } = require('../middleware/auth');
const Proposal = require('../models/Proposal');
const User = require('../models/User');
const Job = require('../models/Job');
const Order = require('../models/Order');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Config = require('../models/Config');

// Configure multer for file uploads
const uploadDir = path.join(__dirname, '../uploads/governance');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `governance-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const fileFilter = (req, file, cb) => {
  // Allow images, PDFs, and common document types
  const allowedMimes = [
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  ];
  
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images, PDFs, and documents are allowed.'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: fileFilter
});

const router = express.Router();

// Helper function to get MIN_VOTE_ACTIVITY_POINTS from config
const getMinVoteActivityPoints = async () => {
  return await Config.getValue('min_activity_points_governance', 20);
};

const MIN_LOCKED_STAKING_LOB = 100; // Minimum 100 LOB locked staking required
const MIN_PROPOSAL_ACTIVITY_POINTS = 10;
const MAX_LIST_LIMIT = 50;

// Helper function to get voting duration days from config
const getVotingDurationDays = async () => {
  return await Config.getValue('voting_duration_days', 5);
};

// Helper function to get settlement percentage from config
const getSettlementPercentage = async () => {
  return await Config.getValue('settlement_percentage', 90);
};

const voteOptionLabels = {
  approve: 'Approve',
  reject: 'Reject',
  abstain: 'Abstain',
  client_refund: 'Client Refund',
  talent_refund: 'Talent Refund',
  split_funds: 'Split Funds'
};

const tryAuth = (req, res, next) => {
  if (!req.headers.authorization) {
    return next();
  }
  return auth(req, res, next);
};

const ensureDaoProposalEligibility = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!user.canCreateDaoProposal()) {
      return res.status(403).json({
        error: `Minimum ${MIN_PROPOSAL_ACTIVITY_POINTS} activity points required to access this resource`
      });
    }
    req.daoUser = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  return next();
};

const getTimeRemaining = (endsAt) => {
  if (!endsAt) return 0;
  const diff = new Date(endsAt).getTime() - Date.now();
  return diff > 0 ? diff : 0;
};

const humanizeDuration = (milliseconds) => {
  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds <= 0) return 'Voting ended';

  const days = Math.floor(totalSeconds / (24 * 3600));
  const hours = Math.floor((totalSeconds % (24 * 3600)) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h remaining`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m remaining`;
  }
  return `${minutes}m remaining`;
};

const eligibleJobStatuses = ['in-progress', 'completed'];
const eligibleOrderStatuses = ['in-progress', 'delivered', 'completed'];

async function finalizeProposalIfExpired(proposal) {
  const priorAutoFinalized = proposal.voting?.autoFinalized;
  proposal.finalizeIfNeeded();

  if (!priorAutoFinalized && proposal.voting?.autoFinalized) {
    if (proposal.voteTallies) {
      proposal.markModified('voteTallies');
    }
    if (proposal.analytics) {
      proposal.markModified('analytics');
    }
    await proposal.save();
  }
}

const mapUserPreview = (userDoc) => {
  if (!userDoc || typeof userDoc === 'string') {
    return userDoc;
  }

  return {
    _id: userDoc._id,
    username: userDoc.username,
    email: userDoc.email,
    profile: userDoc.profile
  };
};

const buildProposalResponse = async (proposal, viewer, eligibleVoters = 0) => {
  const now = new Date();
  const votingEnds = proposal.voting?.endsAt ? new Date(proposal.voting.endsAt) : null;
  const allowedVotes = proposal.allowedVoteOptions();
  const hasVotingEnded = votingEnds ? now > votingEnds : true;
  const viewerId = viewer?._id?.toString();
  const viewerHasVoted = viewerId
    ? proposal.votes.some((vote) => vote.user?.toString() === viewerId)
    : false;
  const canViewerVote = Boolean(
    viewer &&
    viewer.canVote() &&
    proposal.status === 'voting' &&
    !hasVotingEnded &&
    !viewerHasVoted
  );

  const participationRate = eligibleVoters > 0
    ? Number(((proposal.voteTallies.total / eligibleVoters) * 100).toFixed(2))
    : 0;

  const comments = (proposal.comments || []).map((comment) => ({
    _id: comment._id,
    comment: comment.comment,
    createdAt: comment.createdAt,
    user: mapUserPreview(comment.user)
  }));

  const votes = (proposal.votes || []).map((vote) => ({
    _id: vote._id,
    vote: vote.vote,
    reason: vote.reason,
    votedAt: vote.votedAt,
    user: mapUserPreview(vote.user)
  }));

  let disputeContext = null;
  if (proposal.proposalType === 'dispute' && proposal.disputeContext) {
    const ctx = proposal.disputeContext;
    let workItemSummary = null;

    if (ctx.job) {
      if (ctx.jobModel === 'Job') {
        // Extract budget - can be fixed, min, or max
        let budget = null;
        if (ctx.job.budget) {
          if (ctx.job.budget.fixed) {
            budget = ctx.job.budget.fixed;
          } else if (ctx.job.budget.min && ctx.job.budget.max) {
            budget = `${ctx.job.budget.min}-${ctx.job.budget.max}`;
          } else if (ctx.job.budget.min) {
            budget = ctx.job.budget.min;
          } else if (ctx.job.budget.max) {
            budget = ctx.job.budget.max;
          }
        }
        workItemSummary = {
          _id: ctx.job._id,
          title: ctx.job.title,
          status: ctx.job.status,
          type: 'Job',
          budget: budget,
          startDate: ctx.job.startDate,
          endDate: ctx.job.endDate
        };
      } else if (ctx.jobModel === 'Order') {
        workItemSummary = {
          _id: ctx.job._id,
          orderNumber: ctx.job.orderNumber,
          status: ctx.job.status,
          type: 'Order',
          amount: ctx.job.amount,
          gig: ctx.job.gig
            ? {
                _id: ctx.job.gig._id,
                title: ctx.job.gig.title,
                talent: mapUserPreview(ctx.job.gig.talent)
              }
            : null
        };
      } else if (ctx.jobModel === 'Chat') {
        // For Chat model, try to get amount from chat price, linked job budget, or find order
        let amount = null;
        
        // First try chat's price field
        if (ctx.job.price && ctx.job.price.current) {
          amount = ctx.job.price.current;
        } else if (ctx.job.price && ctx.job.price.original) {
          amount = ctx.job.price.original;
        }
        // Then try job budget
        else if (ctx.job.job && ctx.job.job.budget) {
          if (ctx.job.job.budget.fixed) {
            amount = ctx.job.job.budget.fixed;
          } else if (ctx.job.job.budget.min && ctx.job.job.budget.max) {
            amount = `${ctx.job.job.budget.min}-${ctx.job.job.budget.max}`;
          } else if (ctx.job.job.budget.min) {
            amount = ctx.job.job.budget.min;
          }
        }
        // Try to find order linked to this chat
        else {
          try {
            const chatId = ctx.job._id || ctx.job;
            const order = await Order.findOne({ chat: chatId }).select('amount').lean();
            if (order && order.amount) {
              amount = order.amount;
            }
          } catch (err) {
            console.log('[governance:buildProposalResponse] Could not find order for chat:', err.message);
          }
        }
        
        // For Chat model, create a summary from chat data
        workItemSummary = {
          _id: ctx.job._id || ctx.job,
          type: 'Chat',
          status: ctx.job.status || ctx.job.workflowStatus || 'active',
          workflowStatus: ctx.job.workflowStatus,
          amount: amount,
          participants: ctx.job.participants ? ctx.job.participants.map(p => ({
            user: mapUserPreview(p.user),
            role: p.role
          })) : [],
          gig: ctx.job.gig ? {
            _id: ctx.job.gig._id || ctx.job.gig,
            title: ctx.job.gig.title || 'Gig'
          } : null,
          job: ctx.job.job ? {
            _id: ctx.job.job._id || ctx.job.job,
            title: ctx.job.job.title || 'Job',
            budget: ctx.job.job.budget
          } : null
        };
      }
    }

    disputeContext = {
      jobModel: ctx.jobModel,
      job: workItemSummary,
      client: mapUserPreview(ctx.client),
      talent: mapUserPreview(ctx.talent),
      issueSummary: ctx.issueSummary,
      clientNarrative: ctx.clientNarrative,
      talentNarrative: ctx.talentNarrative,
      history: ctx.history || [],
      collaborationThread: (ctx.collaborationThread || []).map((message) => ({
        _id: message._id,
        message: message.message,
        role: message.role,
        createdAt: message.createdAt,
        sender: mapUserPreview(message.sender),
        attachments: message.attachments || []
      })),
      generalComments: (ctx.generalComments || []).map((entry) => ({
        _id: entry._id,
        comment: entry.comment,
        createdAt: entry.createdAt,
        commenter: mapUserPreview(entry.commenter)
      })),
      attachments: ctx.attachments || [],
      settlement: ctx.settlement ? {
        talentAmount: ctx.settlement.talentAmount,
        clientAmount: ctx.settlement.clientAmount,
        talentApproved: ctx.settlement.talentApproved || false,
        clientApproved: ctx.settlement.clientApproved || false,
        settledByAgreement: ctx.settlement.settledByAgreement || false,
        settledBy: mapUserPreview(ctx.settlement.settledBy),
        resolvedBy: mapUserPreview(ctx.settlement.resolvedBy),
        resolvedAt: ctx.settlement.resolvedAt,
        updatedAt: ctx.settlement.updatedAt
      } : null
    };
  }

  const votingTimeRemainingMs = votingEnds ? getTimeRemaining(votingEnds) : 0;

  // Get min activity points from config if not set in proposal
  const minActivityPoints = proposal.voting?.minActivityPoints ?? await getMinVoteActivityPoints();

  return {
    _id: proposal._id,
    title: proposal.title,
    summary: proposal.summary,
    description: proposal.description,
    proposalType: proposal.proposalType,
    category: proposal.category,
    status: proposal.status,
    tags: proposal.tags || [],
    proposer: mapUserPreview(proposal.proposer),
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    voting: {
      startsAt: proposal.voting?.startsAt,
      endsAt: proposal.voting?.endsAt,
      durationDays: proposal.voting?.durationDays ?? await getVotingDurationDays(),
      minActivityPoints: minActivityPoints,
      finalDecision: proposal.voting?.finalDecision,
      finalizedAt: proposal.voting?.finalizedAt,
      autoFinalized: proposal.voting?.autoFinalized ?? false,
      quorum: proposal.voting?.quorum ?? 0,
      timeRemainingMs: votingTimeRemainingMs,
      timeRemainingLabel: votingTimeRemainingMs === 0
        ? 'Voting ended'
        : humanizeDuration(votingTimeRemainingMs)
    },
    voteTallies: proposal.voteTallies,
    voteOptions: allowedVotes.map((option) => ({
      id: option,
      label: voteOptionLabels[option] || option,
      votes: proposal.voteTallies[option] || 0
    })),
    analytics: {
      ...proposal.analytics,
      participationRate,
      totalEligibleVoters: eligibleVoters,
      uniqueVoters: proposal.analytics?.uniqueVoters ?? proposal.votes.length
    },
    results: {
      outcome: proposal.resolution?.outcome || proposal.voting?.finalDecision || null,
      decidedAt: proposal.resolution?.decidedAt || proposal.voting?.finalizedAt || null,
      resolvedAt: proposal.resolution?.resolvedAt || null,
      resolvedBy: mapUserPreview(proposal.resolution?.resolvedBy),
      summary: proposal.resolution?.summary || null,
      notes: proposal.resolution?.notes || null
    },
    comments,
    disputeContext,
    platformDetails: proposal.platformDetails || null,
    attachments: proposal.attachments || [],
    votes,
    chatData: proposal._chatData || null, // Include chat messages for dispute proposals
    viewerContext: {
      canVote: canViewerVote,
      hasVoted: viewerHasVoted,
      canComment: Boolean(viewer && viewer.canVote()),
      canResolve: Boolean(
        viewer &&
        viewer.canVote() &&
        proposal.voting?.autoFinalized &&
        !proposal.resolution?.resolvedAt
      )
    }
  };
};

const withFinalizedProposal = async (proposalId) => {
  // First fetch without populating job to check jobModel
  let proposal = await Proposal.findById(proposalId)
    .populate('proposer', 'username email profile')
    .populate('votes.user', 'username email profile')
    .populate('comments.user', 'username email profile')
    .populate('disputeContext.client', 'username email profile')
    .populate('disputeContext.talent', 'username email profile')
    .populate('disputeContext.generalComments.commenter', 'username email profile')
    .populate('disputeContext.collaborationThread.sender', 'username email profile');

  if (!proposal) {
    return null;
  }

  // Conditionally populate job based on jobModel
  if (proposal.disputeContext?.job && proposal.disputeContext?.jobModel) {
    const jobModel = proposal.disputeContext.jobModel;
    
    if (jobModel === 'Chat') {
      // For Chat model, populate participants and related job/gig with budget
      await proposal.populate({
        path: 'disputeContext.job',
        select: 'participants type status workflowStatus job gig price',
        populate: [
          {
            path: 'participants.user',
            select: 'username email profile'
          },
          {
            path: 'job',
            select: 'title budget'
          },
          {
            path: 'gig',
            select: 'title'
          }
        ]
      });
    } else if (jobModel === 'Job') {
      // For Job model, populate client and hiredTalent
      await proposal.populate({
        path: 'disputeContext.job',
        select: 'title status client hiredTalent startDate endDate budget',
        populate: [
          { path: 'client', select: 'username email profile' },
          { path: 'hiredTalent', select: 'username email profile' }
        ]
      });
    } else if (jobModel === 'Order') {
      // For Order model, populate client, talent, and gig
      await proposal.populate({
        path: 'disputeContext.job',
        select: 'orderNumber status client talent gig amount',
        populate: [
          { path: 'client', select: 'username email profile' },
          { path: 'talent', select: 'username email profile' },
          {
            path: 'gig',
            select: 'title talent',
            populate: { path: 'talent', select: 'username email profile' }
          }
        ]
      });
    } else {
      // For other models (like Gig), just populate the job field
      await proposal.populate('disputeContext.job');
    }
  }

  // If this is a dispute proposal and we can find the chat, fetch chat messages
  if (proposal.proposalType === 'dispute' && proposal.disputeContext?.job) {
    try {
      let chat = null;
      const jobOrGigId = proposal.disputeContext.job._id || proposal.disputeContext.job;
      
      // If jobModel is 'Chat', the job field already contains the chat
      if (proposal.disputeContext.jobModel === 'Chat') {
        // The job field is already the chat and should be populated
        chat = proposal.disputeContext.job;
        // If it's not a full object (just an ID), fetch it
        if (!chat || typeof chat === 'string' || !chat.participants) {
          chat = await Chat.findById(jobOrGigId)
            .populate('participants.user', 'username email profile')
            .populate('job', 'title')
            .populate('gig', 'title talent')
            .lean();
        } else if (chat && (!chat.participants?.[0]?.user?.username)) {
          // If participants aren't populated, populate them
          await chat.populate('participants.user', 'username email profile');
        }
      }
      // If this is an Order, try to find chat linked to the order first
      else if (proposal.disputeContext.jobModel === 'Order') {
        const order = await Order.findById(jobOrGigId).select('chat gig').lean();
        if (order?.chat) {
          // Find chat by order's chat field
          chat = await Chat.findById(order.chat)
            .populate('participants.user', 'username email profile')
            .lean();
        }
        // If no chat linked to order, try to find by gig
        if (!chat && order?.gig) {
          chat = await Chat.findOne({
            gig: order.gig._id || order.gig,
            'participants.user': { $in: [proposal.disputeContext.client, proposal.disputeContext.talent] }
          })
            .populate('participants.user', 'username email profile')
            .lean();
        }
      }
      
      // If still no chat found, try by job/gig reference (for Job disputes)
      if (!chat) {
        chat = await Chat.findOne({
          $or: [{ job: jobOrGigId }, { gig: jobOrGigId }],
          'participants.user': { $in: [proposal.disputeContext.client, proposal.disputeContext.talent] }
        })
          .populate('participants.user', 'username email profile')
          .lean();
      }

      if (chat) {
        // Fetch messages from chat
        const messages = await Message.find({ chatId: chat._id })
          .populate('senderId', 'username email profile')
          .sort({ timestamp: 1 })
          .lean();

        // Store chat data in proposal for later use
        proposal._chatData = {
          chat,
          messages: messages.map(msg => ({
            _id: msg._id,
            content: msg.content,
            type: msg.type,
            timestamp: msg.timestamp,
            senderId: {
              _id: msg.senderId?._id || msg.senderId,
              username: msg.senderId?.username || 'Unknown',
              profile: msg.senderId?.profile
            },
            attachments: msg.attachments || []
          }))
        };
      }
    } catch (error) {
      console.error('[governance:withFinalizedProposal] Error fetching chat messages:', error);
      // Don't fail if chat fetch fails
    }
  }

  await finalizeProposalIfExpired(proposal);

  return proposal;
};

// GET /api/governance
router.get(
  '/',
  tryAuth,
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: MAX_LIST_LIMIT }).toInt(),
    query('status').optional().isString(),
    query('proposalType').optional().isIn(['platform', 'dispute']),
    query('search').optional().isString(),
    query('sortBy').optional().isIn(['createdAt', 'updatedAt', 'voting.endsAt']),
    query('sortOrder').optional().isIn(['asc', 'desc'])
  ],
  handleValidation,
  async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
        proposalType,
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

      const queryFilter = { isActive: { $ne: false } }; // Include null/undefined as active

      if (status && status.trim() !== '') {
        queryFilter.status = status;
    }

      if (proposalType && proposalType.trim() !== '') {
        queryFilter.proposalType = proposalType;
    }

      if (search && search.trim() !== '') {
        queryFilter.$text = { $search: search };
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

      console.log('[governance:list] Query filter:', JSON.stringify(queryFilter, null, 2));
      
      const [proposals, total, typeStats, statusStats, eligibleVoters] = await Promise.all([
        Proposal.find(queryFilter)
          .populate('proposer', 'username email profile stats.activityPoints')
      .sort(sortOptions)
          .limit(limit)
          .skip((page - 1) * limit),
        Proposal.countDocuments(queryFilter),
        Proposal.aggregate([
          { $match: queryFilter },
          { $group: { _id: '$proposalType', count: { $sum: 1 } } }
        ]),
        Proposal.aggregate([
          { $match: queryFilter },
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ]),
        (async () => {
          const minPoints = await getMinVoteActivityPoints();
          return User.countDocuments({ 'stats.activityPoints': { $gte: minPoints } });
        })()
      ]);

      await Promise.all(proposals.map((proposal) => finalizeProposalIfExpired(proposal)));

      console.log('[governance:list] Found proposals:', {
        count: proposals.length,
        total,
        proposals: proposals.map(p => ({
          id: p._id,
          title: p.title,
          status: p.status,
          isActive: p.isActive,
          proposalType: p.proposalType
        }))
      });

      const viewer = req.user?.id ? await User.findById(req.user.id) : null;

      const formatted = await Promise.all(
        proposals.map((proposal) =>
          buildProposalResponse(proposal, viewer, eligibleVoters)
        )
      );
      
      console.log('[governance:list] Formatted proposals count:', formatted.length);

      const statsByStatus = statusStats.reduce((acc, entry) => {
        acc[entry._id] = entry.count;
        return acc;
      }, {});

      const statsByType = typeStats.reduce((acc, entry) => {
        acc[entry._id] = entry.count;
        return acc;
      }, {});

      res.json({
        proposals: formatted,
        pagination: {
          total,
          totalPages: Math.ceil(total / limit),
          currentPage: page,
          pageSize: limit
        },
        stats: {
          total,
          byStatus: {
            voting: statsByStatus.voting || 0,
            awaiting_resolution: statsByStatus.awaiting_resolution || 0,
            passed: statsByStatus.passed || 0,
            rejected: statsByStatus.rejected || 0,
            resolved: statsByStatus.resolved || 0
          },
          byType: {
            platform: statsByType.platform || 0,
            dispute: statsByType.dispute || 0
          },
          eligibleVoters
        },
        filters: {
          status,
          proposalType,
          search
        }
      });
    } catch (error) {
      console.error('[governance:list] error', error);
      res.status(500).json({ error: 'Unable to fetch proposals' });
    }
  }
);

// GET /api/governance/leaderboard
router.get(
  '/leaderboard',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('sortBy').optional().isIn(['votesCast', 'activityPoints', 'proposalsSubmitted', 'disputesResolved']),
    query('sortOrder').optional().isIn(['asc', 'desc'])
  ],
  handleValidation,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        sortBy = 'votesCast',
        sortOrder = 'desc'
      } = req.query;

      const sortOptions = {};
      const sortField = sortBy === 'votesCast' 
        ? 'stats.dao.votesCast' 
        : sortBy === 'activityPoints'
        ? 'stats.activityPoints'
        : sortBy === 'proposalsSubmitted'
        ? 'stats.dao.proposalsSubmitted'
        : 'stats.dao.disputesResolved';
      
      sortOptions[sortField] = sortOrder === 'desc' ? -1 : 1;
      // Secondary sort by activity points for consistency
      if (sortBy !== 'activityPoints') {
        sortOptions['stats.activityPoints'] = -1;
      }

      const minActivityPoints = await getMinVoteActivityPoints();
      const [leaders, total] = await Promise.all([
        User.find(
          { 'stats.activityPoints': { $gte: minActivityPoints } },
          {
            username: 1,
            email: 1,
            'profile.avatar': 1,
            'profile.firstName': 1,
            'profile.lastName': 1,
            'stats.activityPoints': 1,
            'stats.dao': 1,
            createdAt: 1
          }
        )
          .sort(sortOptions)
          .limit(limit)
          .skip((page - 1) * limit),
        User.countDocuments({ 'stats.activityPoints': { $gte: minActivityPoints } })
      ]);

      const leaderboard = leaders.map((member) => ({
        _id: member._id,
        username: member.username,
        email: member.email,
        avatar: member.profile?.avatar,
        firstName: member.profile?.firstName,
        lastName: member.profile?.lastName,
        activityPoints: member.stats?.activityPoints || 0,
        votesCast: member.stats?.dao?.votesCast || 0,
        proposalsSubmitted: member.stats?.dao?.proposalsSubmitted || 0,
        disputesRaised: member.stats?.dao?.disputesRaised || 0,
        disputesResolved: member.stats?.dao?.disputesResolved || 0,
        commentsPosted: member.stats?.dao?.commentsPosted || 0,
        joinedAt: member.createdAt
      }));

      res.json({
        leaderboard,
        pagination: {
          total,
          totalPages: Math.ceil(total / limit),
          currentPage: page,
          pageSize: limit
        },
        filters: {
          sortBy,
          sortOrder
        }
      });
    } catch (error) {
      console.error('[governance:leaderboard] error', error);
      res.status(500).json({ error: 'Unable to fetch leaderboard' });
    }
  }
);

// GET /api/governance/eligibility
// Check voting eligibility (activity points + locked staking info)
router.get('/eligibility', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const activityPoints = user.stats?.activityPoints || 0;
    const minActivityPoints = await getMinVoteActivityPoints();
    const hasMinActivityPoints = activityPoints >= minActivityPoints;
    
    // Get minimum locked staking from config (default: 100)
    const minLockedStaking = await Config.getValue('min_locked_staking_governance', 100);
    
    // Get voter reward amount from config
    const voterRewardAmount = await Config.getValue('voter_reward_amount', 0);
    
    // Get voting duration and activity points for voting from config
    const votingDurationDays = await getVotingDurationDays();
    const activityPointsForVoting = await Config.getValue('activity_points_voting', 5);
    
    // Locked staking check must be done on frontend via blockchain
    // Backend only checks activity points
    res.json({
      eligible: hasMinActivityPoints,
      activityPoints: activityPoints,
      requiredActivityPoints: minActivityPoints,
      requiredLockedStaking: minLockedStaking,
      voterRewardAmount: voterRewardAmount, // Include voter reward amount for frontend
      votingDurationDays: votingDurationDays, // Include voting duration for frontend
      activityPointsForVoting: activityPointsForVoting, // Include activity points earned per vote
      message: hasMinActivityPoints 
        ? `You meet activity points requirement. Please ensure you have ${minLockedStaking}+ LOB locked staking.`
        : `You need ${minActivityPoints} activity points to vote. Current: ${activityPoints}`
    });
  } catch (error) {
    console.error('[governance:eligibility] error', error);
    res.status(500).json({ error: 'Unable to check eligibility' });
  }
});

// GET /api/governance/eligible-work
// This endpoint uses the SAME approach as /api/chats to fetch chats
// but filters for workflowStatus: 'in-progress' or 'completed'
// Note: No activity point requirement - anyone involved in jobs/gigs can see eligible work for disputes
router.get('/eligible-work', auth, async (req, res) => {
  try {
    const requester = await User.findById(req.user.id);
    if (!requester) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Use req.user.id (same as chats route) for consistency
    const userId = req.user.id;

    console.log('[governance:eligible-work] Fetching for user:', userId);

    // Use EXACTLY the same query format as the chats route
    // The chats route: 'participants.user': req.user.id
    // Display ALL chats with jobs/gigs, regardless of status or workflowStatus
    const allUserChats = await Chat.find({
      'participants.user': userId,
      $or: [
        { job: { $exists: true, $ne: null } },
        { gig: { $exists: true, $ne: null } }
      ]
    })
      .populate('participants.user', 'username email profile')
      .populate('job', 'title status client hiredTalent startDate endDate budget')
      .populate('gig', 'title status talent pricing')
      .sort({ updatedAt: -1 })
      .lean();

    console.log('[governance:eligible-work] Found all chats with jobs/gigs:', allUserChats.length);

    // Log ALL chats found for debugging
    if (allUserChats.length > 0) {
      console.log('[governance:eligible-work] All chats with jobs/gigs:');
      allUserChats.forEach((chat, index) => {
        console.log(`  ${index + 1}. Chat ${chat._id}:`);
        console.log(`     - type: ${chat.type}`);
        console.log(`     - workflowStatus: "${chat.workflowStatus || 'none'}"`);
        console.log(`     - status: "${chat.status || 'none'}"`);
        console.log(`     - hasJob: ${!!chat.job}, hasGig: ${!!chat.gig}`);
        if (chat.job && typeof chat.job === 'object' && chat.job._id) {
          console.log(`     - job: ${chat.job._id} "${chat.job.title}" (status: ${chat.job.status})`);
        }
        if (chat.gig && typeof chat.gig === 'object' && chat.gig._id) {
          console.log(`     - gig: ${chat.gig._id} "${chat.gig.title}"`);
        }
      });
    } else {
      // Debug: Check total chats for user
      const totalChats = await Chat.countDocuments({ 'participants.user': userId });
      console.log('[governance:eligible-work] Debug info:', {
        totalChats,
        chatsWithJobsOrGigs: 0,
        userId
      });
    }

    // Use all chats - no filtering by workflowStatus
    const eligibleChats = allUserChats;

    // Separate into jobs and orders
    const jobItems = [];
    const orderItems = [];

    for (const chat of eligibleChats) {
      // Get other participant for display
      const otherParticipant = chat.participants?.find(p => {
        const participantId = p.user?._id?.toString() || p.user?.toString();
        return participantId !== userId.toString();
      });

      if (chat.job && chat.job._id) {
        // This is a job chat - job is already populated from the chat query
        const jobDetails = chat.job;
        
        if (jobDetails && typeof jobDetails === 'object' && jobDetails._id) {
          // Need to populate client and hiredTalent if not already populated
          let populatedJob = jobDetails;
          if (!jobDetails.client || typeof jobDetails.client !== 'object') {
            populatedJob = await Job.findById(jobDetails._id)
              .select('_id title status client hiredTalent startDate endDate budget')
              .populate('client', 'username profile')
              .populate('hiredTalent', 'username profile')
              .lean();
          }

          if (populatedJob) {
            // Include all jobs from chats, regardless of status
            const isUserClient = (populatedJob.client?._id?.toString() === userId.toString() || 
                                 populatedJob.client?.toString() === userId.toString());
            const otherParty = isUserClient ? populatedJob.hiredTalent : populatedJob.client;
            const otherUsername = otherParty?.username || otherParticipant?.user?.username || 'Unknown';

            jobItems.push({
              _id: populatedJob._id,
              title: populatedJob.title,
              status: populatedJob.status,
              client: populatedJob.client,
              hiredTalent: populatedJob.hiredTalent,
              budget: populatedJob.budget,
              chatId: chat._id,
              chatWorkflowStatus: chat.workflowStatus || populatedJob.status,
              chatStatus: chat.status,
              price: chat.price,
              otherPartyUsername: otherUsername,
              userRole: isUserClient ? 'client' : 'talent'
            });
            
            console.log(`[governance:eligible-work] Added job ${populatedJob._id}: "${populatedJob.title}" (jobStatus: ${populatedJob.status}, workflowStatus: ${chat.workflowStatus || 'none'})`);
          }
        }
      } else if (chat.gig && chat.gig._id) {
        // This is a gig chat - gig is already populated from the chat query
        const gigId = chat.gig._id || chat.gig;
        
        console.log(`[governance:eligible-work] Processing gig chat ${chat._id}: workflowStatus="${chat.workflowStatus || 'none'}", gigId=${gigId}`);
        
        // Find ALL orders for this gig/chat, regardless of status
        const [chatOrders, gigOrders] = await Promise.all([
          // Query 1: Orders linked to this chat
          Order.find({
            chat: chat._id,
            $or: [{ client: userId }, { talent: userId }]
          })
            .select('_id orderNumber status client talent gig amount createdAt updatedAt chat')
            .populate('client', 'username profile')
            .populate('talent', 'username profile')
            .populate({
              path: 'gig',
              select: 'title talent',
              populate: { path: 'talent', select: 'username profile' }
            })
            .lean(),
          // Query 2: Orders for this gig (include ALL orders regardless of status)
          Order.find({
            gig: gigId,
            $or: [{ client: userId }, { talent: userId }]
          })
            .select('_id orderNumber status client talent gig amount createdAt updatedAt chat')
            .populate('client', 'username profile')
            .populate('talent', 'username profile')
            .populate({
              path: 'gig',
              select: 'title talent',
              populate: { path: 'talent', select: 'username profile' }
            })
            .lean()
        ]);

        // Combine and deduplicate orders
        const orderMap = new Map();
        [...chatOrders, ...gigOrders].forEach(order => {
          orderMap.set(order._id.toString(), order);
        });
        const allOrders = Array.from(orderMap.values());

        console.log(`[governance:eligible-work] Found ${allOrders.length} orders (${chatOrders.length} by chat, ${gigOrders.length} by gig) for gig ${gigId} in chat ${chat._id}`);
        if (allOrders.length > 0) {
          allOrders.forEach(o => {
            console.log(`  - Order ${o._id}: status="${o.status}", client=${o.client?.username || o.client}, talent=${o.talent?.username || o.talent}`);
          });
        }

        // Include ALL orders, regardless of status
        allOrders.forEach(order => {
          const isUserClient = (order.client?._id?.toString() === userId.toString() || 
                               order.client?.toString() === userId.toString());
          const otherParty = isUserClient ? order.talent : order.client;
          const otherUsername = otherParty?.username || otherParticipant?.user?.username || chat.gig?.talent?.username || 'Unknown';

          orderItems.push({
            _id: order._id,
            orderNumber: order.orderNumber,
            status: order.status,
            client: order.client,
            talent: order.talent,
            gig: order.gig,
            amount: order.amount,
            chatId: chat._id,
            chatWorkflowStatus: chat.workflowStatus || order.status,
            chatStatus: chat.status,
            price: chat.price,
            otherPartyUsername: otherUsername,
            userRole: isUserClient ? 'client' : 'talent'
          });
          
          console.log(`[governance:eligible-work] Added order ${order._id}: gig="${order.gig?.title || 'N/A'}" (orderStatus: ${order.status}, workflowStatus: ${chat.workflowStatus || 'none'})`);
        });
      }
    }

    // Use chat-based items directly (same approach as chat list)
    // No need for fallback direct queries since we're using the same method as /api/chats
    const finalJobs = jobItems;
    const finalOrders = orderItems;

    console.log('[governance:eligible-work] Returning:', {
      jobs: finalJobs.length,
      orders: finalOrders.length,
      sampleJob: finalJobs[0] ? {
        title: finalJobs[0].title,
        otherParty: finalJobs[0].otherPartyUsername,
        status: finalJobs[0].status,
        chatWorkflowStatus: finalJobs[0].chatWorkflowStatus
      } : null,
      sampleOrder: finalOrders[0] ? {
        gig: finalOrders[0].gig?.title,
        otherParty: finalOrders[0].otherPartyUsername,
        status: finalOrders[0].status,
        chatWorkflowStatus: finalOrders[0].chatWorkflowStatus
      } : null
    });

    res.json({
      jobs: finalJobs,
      gigOrders: finalOrders
    });
  } catch (error) {
    console.error('[governance:eligible-work] error', error);
    res.status(500).json({ error: 'Unable to fetch eligible work items' });
  }
});

// GET /api/governance/metrics/activity
router.get('/metrics/activity', auth, ensureDaoProposalEligibility, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const minActivityPoints = await getMinVoteActivityPoints();
    const [activitySummaryRaw] = await User.aggregate([
      {
        $group: {
          _id: null,
          totalActivityPoints: { $sum: '$stats.activityPoints' },
          averageActivityPoints: { $avg: '$stats.activityPoints' },
          memberCount: { $sum: 1 },
          eligibleVoters: {
            $sum: {
              $cond: [
                { $gte: ['$stats.activityPoints', minActivityPoints] },
                1,
                0
              ]
            }
          },
          eligibleProposers: {
            $sum: {
              $cond: [
                { $gte: ['$stats.activityPoints', MIN_PROPOSAL_ACTIVITY_POINTS] },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    const [daoSummaryRaw] = await User.aggregate([
      {
        $group: {
          _id: null,
          votesCast: { $sum: { $ifNull: ['$stats.dao.votesCast', 0] } },
          proposalsSubmitted: { $sum: { $ifNull: ['$stats.dao.proposalsSubmitted', 0] } },
          disputesRaised: { $sum: { $ifNull: ['$stats.dao.disputesRaised', 0] } },
          disputesResolved: { $sum: { $ifNull: ['$stats.dao.disputesResolved', 0] } },
          commentsPosted: { $sum: { $ifNull: ['$stats.dao.commentsPosted', 0] } }
        }
      }
    ]);

    const voteActivity = await Proposal.aggregate([
      { $unwind: { path: '$votes', preserveNullAndEmptyArrays: false } },
      { $match: { 'votes.votedAt': { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$votes.votedAt' } },
          votes: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const proposalsByType = await Proposal.aggregate([
      {
        $group: {
          _id: '$proposalType',
          total: { $sum: 1 },
          resolved: {
            $sum: {
              $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0]
            }
          },
          awaitingResolution: {
            $sum: {
              $cond: [{ $eq: ['$status', 'awaiting_resolution'] }, 1, 0]
            }
          }
        }
      }
    ]);

    const topContributors = await User.find(
      { 'stats.dao.votesCast': { $gt: 0 } },
      {
        username: 1,
        'stats.activityPoints': 1,
        'stats.dao': 1,
        profile: 1
      }
    )
      .sort({ 'stats.dao.votesCast': -1, 'stats.dao.commentsPosted': -1 })
      .limit(5);

    const activitySummary = activitySummaryRaw || {
      totalActivityPoints: 0,
      averageActivityPoints: 0,
      memberCount: 0,
      eligibleVoters: 0,
      eligibleProposers: 0
    };

    const daoSummary = daoSummaryRaw || {
      votesCast: 0,
      proposalsSubmitted: 0,
      disputesRaised: 0,
      disputesResolved: 0,
      commentsPosted: 0
    };

    res.json({
      activity: {
        totalActivityPoints: activitySummary.totalActivityPoints || 0,
        averageActivityPoints: Number((activitySummary.averageActivityPoints || 0).toFixed(2)),
        memberCount: activitySummary.memberCount || 0,
        eligibleVoters: activitySummary.eligibleVoters || 0,
        eligibleProposers: activitySummary.eligibleProposers || 0
      },
      dao: {
        votesCast: daoSummary.votesCast || 0,
        proposalsSubmitted: daoSummary.proposalsSubmitted || 0,
        disputesRaised: daoSummary.disputesRaised || 0,
        disputesResolved: daoSummary.disputesResolved || 0,
        commentsPosted: daoSummary.commentsPosted || 0
      },
      proposals: proposalsByType.reduce((acc, entry) => {
        acc[entry._id] = {
          total: entry.total,
          resolved: entry.resolved,
          awaitingResolution: entry.awaitingResolution
        };
        return acc;
      }, {}),
      voting: {
        last30Days: voteActivity.map((entry) => ({
          date: entry._id,
          votes: entry.votes
        }))
      },
      topContributors: topContributors.map((member) => ({
        _id: member._id,
        username: member.username,
        activityPoints: member.stats?.activityPoints || 0,
        dao: member.stats?.dao || {}
      }))
    });
  } catch (error) {
    console.error('[governance:activity-metrics] error', error);
    res.status(500).json({ error: 'Unable to fetch DAO activity metrics' });
  }
});

// GET /api/governance/chat/:chatId/proposal
// @desc    Check if chat has an active dispute proposal
// @access  Private
router.get('/chat/:chatId/proposal', auth, async (req, res) => {
  try {
    const { chatId } = req.params;
    const Proposal = require('../models/Proposal');
    
    // Find active dispute proposals that reference this chat
    // For job disputes, the job field in disputeContext might be an application ID
    // For gig disputes, the job field might be an order ID or chat ID
    const activeProposals = await Proposal.find({
      proposalType: 'dispute',
      status: { $in: ['voting', 'awaiting_resolution'] },
      isActive: { $ne: false },
      $or: [
        // Check if disputeContext.job references this chat (for Chat-based disputes)
        { 'disputeContext.job': chatId },
        // Also check if the jobModel is 'Chat' and jobId matches
        { 
          'disputeContext.jobModel': 'Chat',
          'disputeContext.job': chatId
        }
      ]
    })
    .select('_id title status proposalType disputeContext')
    .lean();
    
    // Also check if any job applications or orders linked to this chat have proposals
    const chat = await Chat.findById(chatId)
      .populate('job', '_id')
      .populate('gig', '_id')
      .lean();
    
    if (chat) {
      // For jobs, check if any application has a proposal
      if (chat.job) {
        const Job = require('../models/Job');
        const job = await Job.findById(chat.job._id || chat.job)
          .select('applications')
          .lean();
        
        if (job && job.applications) {
          const applicationIds = job.applications.map(app => app._id.toString());
          const jobProposals = await Proposal.find({
            proposalType: 'dispute',
            status: { $in: ['voting', 'awaiting_resolution'] },
            isActive: { $ne: false },
            'disputeContext.jobModel': 'Job',
            'disputeContext.job': { $in: applicationIds }
          })
          .select('_id title status proposalType disputeContext')
          .lean();
          
          activeProposals.push(...jobProposals);
        }
      }
      
      // For gigs, check if any order has a proposal
      if (chat.gig) {
        const Order = require('../models/Order');
        const orders = await Order.find({
          $or: [
            { chat: chatId },
            { gig: chat.gig._id || chat.gig }
          ]
        })
        .select('_id')
        .lean();
        
        if (orders.length > 0) {
          const orderIds = orders.map(o => o._id.toString());
          const orderProposals = await Proposal.find({
            proposalType: 'dispute',
            status: { $in: ['voting', 'awaiting_resolution'] },
            isActive: { $ne: false },
            'disputeContext.jobModel': 'Order',
            'disputeContext.job': { $in: orderIds }
          })
          .select('_id title status proposalType disputeContext')
          .lean();
          
          activeProposals.push(...orderProposals);
        }
      }
    }
    
    // Deduplicate by proposal ID
    const uniqueProposals = Array.from(
      new Map(activeProposals.map(p => [p._id.toString(), p])).values()
    );
    
    res.json({
      hasActiveProposal: uniqueProposals.length > 0,
      proposals: uniqueProposals,
      proposalId: uniqueProposals.length > 0 ? uniqueProposals[0]._id.toString() : null
    });
  } catch (error) {
    console.error('[governance:chat-proposal] Error:', error);
    res.status(500).json({ error: 'Unable to check for proposals' });
  }
});

// GET /api/governance/:id/contract-history
// @desc Get contract status history and transactions for a dispute proposal
// @access Public (everyone can view)
// NOTE: This route must be defined BEFORE /:id to ensure proper matching
router.get('/:id/contract-history', tryAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid proposal id' });
    }

    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    if (proposal.proposalType !== 'dispute') {
      return res.status(400).json({ error: 'This endpoint is only for dispute proposals' });
    }

    const Transaction = require('../models/Transaction');
    let chat = null;
    const jobOrGigId = proposal.disputeContext?.job?._id || proposal.disputeContext?.job;

    // Find the chat associated with this dispute
    if (proposal.disputeContext?.jobModel === 'Chat') {
      chat = await Chat.findById(jobOrGigId)
        .populate('participants.user', 'username email profile')
        .lean();
    } else if (proposal.disputeContext?.jobModel === 'Order') {
      const order = await Order.findById(jobOrGigId).select('chat').lean();
      if (order?.chat) {
        chat = await Chat.findById(order.chat)
          .populate('participants.user', 'username email profile')
          .lean();
      }
    } else if (proposal.disputeContext?.jobModel === 'Job') {
      // For jobs, find chat by job ID
      chat = await Chat.findOne({ job: jobOrGigId })
        .populate('participants.user', 'username email profile')
        .lean();
    }

    if (!chat) {
      return res.json({
        statusHistory: [],
        transactions: []
      });
    }

    // Build status history from chat escrow data
    const statusHistory = [];
    const { client, talent } = getParticipantsByRole(chat);

    // Deposit status
    if (chat.escrow?.deposit) {
      statusHistory.push({
        status: 'deposit',
        label: 'Deposit',
        performedBy: chat.escrow.deposit.performedBy,
        performedByUser: client?.user || null,
        role: 'client',
        occurredAt: chat.escrow.deposit.occurredAt,
        txHash: chat.escrow.deposit.txHash,
        amountUSD: chat.escrow.deposit.amountUSD,
        amountETH: chat.escrow.deposit.amountETH
      });
    }

    // In-Progress status
    if (chat.escrow?.inProgress) {
      statusHistory.push({
        status: 'in-progress',
        label: 'In-Progress',
        performedBy: chat.escrow.inProgress.performedBy,
        performedByUser: talent?.user || null,
        role: 'talent',
        occurredAt: chat.escrow.inProgress.occurredAt,
        txHash: chat.escrow.inProgress.txHash
      });
    }

    // Completion status
    if (chat.escrow?.completion) {
      statusHistory.push({
        status: 'completed',
        label: 'Completed',
        performedBy: chat.escrow.completion.performedBy,
        performedByUser: talent?.user || null,
        role: 'talent',
        occurredAt: chat.escrow.completion.occurredAt,
        txHash: chat.escrow.completion.txHash
      });
    }

    // Confirmation status
    if (chat.escrow?.confirmation) {
      statusHistory.push({
        status: 'confirmed',
        label: 'Confirmed',
        performedBy: chat.escrow.confirmation.performedBy,
        performedByUser: client?.user || null,
        role: 'client',
        occurredAt: chat.escrow.confirmation.occurredAt,
        txHash: chat.escrow.confirmation.txHash
      });
    }

    // Sort by occurredAt
    statusHistory.sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));

    // Get current status
    const currentStatus = chat.workflowStatus || 'offered';

    // Fetch transactions related to this chat
    const transactions = await Transaction.find({
      chat: chat._id,
      type: { $in: ['escrow_deposit', 'escrow_disburse'] }
    })
      .populate('fromUser', 'username email')
      .populate('toUser', 'username email')
      .sort({ createdAt: -1 })
      .lean();

    // Calculate remaining amount: deposit - total disbursed
    let depositAmount = 0;
    let totalDisbursed = 0;
    
    if (chat.escrow?.deposit?.amountUSD) {
      depositAmount = chat.escrow.deposit.amountUSD;
    }
    
    // Sum all disbursement transactions
    transactions.forEach(tx => {
      if (tx.type === 'escrow_disburse') {
        totalDisbursed += tx.amount || 0;
      }
    });
    
    const remainingAmount = Math.max(0, depositAmount - totalDisbursed);

    // Format transactions
    const formattedTransactions = transactions.map(tx => ({
      _id: tx._id,
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency || 'USD',
      txHash: tx.txHash,
      fromUser: tx.fromUser,
      toUser: tx.toUser,
      description: tx.description,
      createdAt: tx.createdAt,
      status: tx.status
    }));

    // Get settlement percentage from config
    const settlementPercentage = await getSettlementPercentage();

    res.json({
      statusHistory,
      currentStatus,
      transactions: formattedTransactions,
      remainingAmount,
      depositAmount,
      totalDisbursed,
      settlementPercentage
    });
  } catch (error) {
    console.error('[governance:contract-history] error', error);
    res.status(500).json({ error: 'Unable to fetch contract history' });
  }
});

// Helper function to get participants by role
function getParticipantsByRole(chat) {
  const client = chat.participants?.find((p) => p.role === 'client');
  const talent = chat.participants?.find((p) => p.role === 'talent');
  return { client, talent };
}

// GET /api/governance/:id (public - everyone can view)
// NOTE: This route must be defined AFTER /:id/contract-history to ensure proper matching
router.get('/:id', tryAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid proposal id' });
    }

    const proposal = await withFinalizedProposal(req.params.id);

    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    // Try to get viewer if authenticated, otherwise use null
    const viewer = req.user ? await User.findById(req.user.id) : null;
    const minActivityPoints = await getMinVoteActivityPoints();
    const eligibleVoters = await User.countDocuments({
      'stats.activityPoints': { $gte: minActivityPoints }
    });

    const response = await buildProposalResponse(proposal, viewer, eligibleVoters);
    return res.json(response);
  } catch (error) {
    console.error('[governance:get-proposal] error', error);
    res.status(500).json({ error: 'Unable to fetch proposal' });
  }
});

// POST /api/governance
router.post(
  '/',
  auth,
  [
  body('title').notEmpty().withMessage('Title is required'),
    body('description').isString().notEmpty().withMessage('Description is required'),
    body('proposalType').isIn(['platform', 'dispute']).withMessage('Invalid proposal type'),
    body('category').optional().isString(),
    body('tags').optional().isArray(),
    body('platformDetails').optional().isObject(),
    body('disputeContext').optional().isObject()
  ],
  handleValidation,
  async (req, res) => {
    try {
      const proposer = await User.findById(req.user.id);
      if (!proposer) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { title, description, summary, proposalType, category, tags, platformDetails, disputeContext } = req.body;

      // Only check activity points for platform proposals, not dispute proposals
      // Dispute proposals can be created by anyone involved in the job/gig
      if (proposalType === 'platform' && !proposer.canCreateDaoProposal()) {
        return res.status(403).json({
          error: `Minimum ${MIN_PROPOSAL_ACTIVITY_POINTS} activity points required to create platform proposals`
        });
      }

      const baseProposal = new Proposal({
        title,
        summary,
        description,
        proposalType,
        category: category || (proposalType === 'platform' ? 'platform' : 'dispute'),
        proposer: proposer._id,
        tags,
        voting: {
          startsAt: new Date(),
          endsAt: new Date(Date.now() + (await getVotingDurationDays()) * 24 * 60 * 60 * 1000),
          durationDays: await getVotingDurationDays(),
          minActivityPoints: await getMinVoteActivityPoints(),
          quorum: 0
        },
      status: 'voting',
        isActive: true
      });

      if (proposalType === 'platform') {
        baseProposal.platformDetails = {
          problemStatement: platformDetails?.problemStatement,
          proposedSolution: platformDetails?.proposedSolution,
          impact: platformDetails?.impact,
          implementationPlan: platformDetails?.implementationPlan,
          successMetrics: platformDetails?.successMetrics,
          dependencies: platformDetails?.dependencies
        };
      } else if (proposalType === 'dispute') {
        if (!disputeContext?.jobId || !disputeContext?.jobModel) {
          return res.status(400).json({ error: 'Dispute proposals must include job reference' });
        }

        // Support both 'Job'/'Order' and 'Chat' (for chat-based gig/job resolution)
        if (!['Job', 'Order', 'Chat'].includes(disputeContext.jobModel)) {
          return res.status(400).json({ error: 'Invalid dispute job model' });
        }

        let workItem;
        let actualJobModel = disputeContext.jobModel;

        // If jobModel is 'Chat', resolve to Order (for gigs) or Application (for jobs)
        if (disputeContext.jobModel === 'Chat') {
          // Find order linked to this chat
          const chatId = disputeContext.jobId;
          console.log('[governance:create] Resolving Chat to Order, chatId:', chatId);
          
          const chat = await Chat.findById(chatId)
            .populate('gig', 'title talent')
            .populate('job', 'title client applications')
            .populate('participants.user', 'username email profile')
            .lean();

          if (!chat) {
            console.log('[governance:create] Chat not found:', chatId);
            return res.status(404).json({ error: 'Chat not found' });
          }

          // Handle job-based chats
          if (chat.job) {
            console.log('[governance:create] Chat associated with a job:', chat.job._id);
            const jobId = chat.job._id || chat.job;
            
            // Find the application linked to this chat
            const Job = require('../models/Job');
            const job = await Job.findById(jobId)
              .populate('client', 'username profile')
              .populate('applications.talent', 'username profile')
              .lean();
            
            if (!job) {
              return res.status(404).json({ error: 'Job not found' });
            }
            
            console.log('[governance:create] Job found:', {
              jobId: job._id,
              clientId: job.client?._id || job.client,
              applicationsCount: job.applications?.length || 0,
              chatId
            });
            
            // Find the SPECIFIC application for this chat
            // For jobs: The job creator (client) can dispute any application, OR a talent can dispute their own application
            let application = null;
            const proposerIdStr = proposer._id.toString();
            const jobClientId = job.client?._id?.toString() || job.client?.toString();
            const isProposerJobCreator = jobClientId === proposerIdStr;
            
            // Strategy 1: Find application by chatId
            application = job.applications?.find(app => {
              const appChatId = app.chatId?._id || app.chatId;
              return appChatId && appChatId.toString() === chatId.toString();
            });
            
            if (application) {
              console.log('[governance:create] Application found by chatId:', application._id);
            }
            
            // Strategy 2: If proposer is job creator, find application by chatId (any application)
            if (!application && isProposerJobCreator) {
              // Job creator can dispute any application linked to this chat
              application = job.applications?.find(app => {
                const appChatId = app.chatId?._id || app.chatId;
                return appChatId && appChatId.toString() === chatId.toString();
              });
              
              if (application) {
                console.log('[governance:create] Application found for job creator by chatId:', application._id);
              }
            }
            
            // Strategy 3: Find application by proposer (talent) - talent can only dispute their own application
            if (!application && !isProposerJobCreator) {
              application = job.applications?.find(app => {
                const appTalentId = app.talent?._id || app.talent;
                const appTalentIdStr = appTalentId?.toString();
                return appTalentIdStr === proposerIdStr;
              });
              
              if (application) {
                console.log('[governance:create] Application found by proposer (talent) ID:', application._id);
              }
            }
            
            // Strategy 4: Try to find by talent ID from chat participants
            if (!application) {
              const talentParticipant = chat.participants?.find(p => p.role === 'talent');
              const talentId = talentParticipant?.user?._id || talentParticipant?.user;
              
              console.log('[governance:create] Application not found, trying by chat talent participant:', {
                talentParticipantId: talentId,
                proposerId: proposerIdStr,
                isProposerJobCreator
              });
              
              if (talentId) {
                const matchingApp = job.applications?.find(app => {
                  const appTalentId = app.talent?._id || app.talent;
                  const match = appTalentId && appTalentId.toString() === talentId.toString();
                  
                  // If proposer is job creator, they can dispute any application
                  // If proposer is talent, they can only dispute their own
                  if (isProposerJobCreator) {
                    return match; // Job creator can dispute any application
                  } else {
                    // Talent can only dispute their own application
                    return match && appTalentId.toString() === proposerIdStr;
                  }
                });
                
                if (matchingApp) {
                  application = matchingApp;
                  console.log('[governance:create] Found application by chat talent participant');
                }
              }
            }
            
            if (!application) {
              console.error('[governance:create] Application not found:', {
                chatId,
                jobId: job._id,
                proposerId: proposerIdStr,
                isProposerJobCreator,
                applications: job.applications?.map(app => ({
                  appId: app._id,
                  appChatId: app.chatId?._id || app.chatId,
                  appTalentId: app.talent?._id || app.talent
                }))
              });
              return res.status(404).json({ 
                error: 'Application not found for this chat. Only the job creator or the talent who applied can create a dispute for a specific application.' 
              });
            }
            
            // Helper to extract ID - handles ObjectId, populated objects, and strings
            const extractIdValue = (value) => {
              if (!value) return null;
              if (typeof value === 'string') return value;
              if (value._id) return value._id.toString();
              if (value.toString) return value.toString();
              return null;
            };
            
            // Extract talent ID - handle both populated and non-populated cases
            const applicationTalentId = extractIdValue(application.talent);
            
            console.log('[governance:create] Application found:', {
              applicationId: application._id,
              applicationTalent: application.talent,
              applicationTalentId: applicationTalentId,
              applicationTalentType: typeof application.talent,
              proposerId: proposer._id.toString(),
              proposerUsername: proposer.username
            });
            
            // Create a virtual work item from the application
            // Ensure IDs are stored as strings for consistent comparison
            workItem = {
              _id: application._id,
              job: job._id,
              chat: chatId,
              client: extractIdValue(job.client),
              talent: applicationTalentId,
              status: application.status || 'pending',
              applicationNumber: `APP-${application._id.toString().slice(-8).toUpperCase()}`,
              isApplicationBased: true,
              jobTitle: job.title,
              bidAmount: application.bidAmount,
              estimatedDuration: application.estimatedDuration
            };
            actualJobModel = 'Job';
            
            console.log('[governance:create] Created workItem for job application:', {
              applicationId: workItem._id,
              jobId: job._id,
              chatId,
              clientId: workItem.client,
              talentId: workItem.talent,
              status: workItem.status,
              proposerId: proposer._id.toString(),
              proposerUsername: proposer.username,
              willMatch: workItem.talent === proposer._id.toString()
            });
            
            // Skip the gig order resolution logic - continue to set clientId and talentId
          } else if (chat.gig) {
            // Original gig handling logic
          const gigId = chat.gig._id || chat.gig;
          console.log('[governance:create] Chat found, gigId:', gigId);
          console.log('[governance:create] Chat participants:', chat.participants?.map(p => ({
            userId: p.user?._id || p.user,
            username: p.user?.username,
            role: p.role
          })));
          console.log('[governance:create] Proposer ID:', proposer._id);

          // Get participant IDs from chat
          const chatParticipantIds = chat.participants?.map(p => {
            const pid = p.user?._id || p.user;
            return pid?.toString() || pid;
          }) || [];

          // Find the SPECIFIC order for this chat where the proposer is a participant
          // For gigs: A client who ordered can dispute their order, OR the talent (gig creator) can dispute any order
          let order = null;

          // Strategy 1: Find order by chat field where proposer is participant
          order = await Order.findOne({
            chat: chatId,
            $or: [{ client: proposer._id }, { talent: proposer._id }]
          })
            .populate('client', 'username profile')
            .populate('talent', 'username profile')
            .populate('gig', 'title talent')
            .populate('gig.talent', 'username profile')
            .lean();

          console.log('[governance:create] Order found by chat field (proposer participant):', order ? order._id : 'none');

          // Strategy 2: Find order by gig and proposer (if chat field not set)
          if (!order) {
            order = await Order.findOne({
              gig: gigId,
              $or: [{ client: proposer._id }, { talent: proposer._id }]
            })
              .populate('client', 'username profile')
              .populate('talent', 'username profile')
              .populate('gig', 'title talent')
              .populate('gig.talent', 'username profile')
              .sort({ createdAt: -1 })
              .lean();

            console.log('[governance:create] Order found by gig and proposer:', order ? order._id : 'none');
          }

          // Strategy 3: Find order by chat participants (if proposer is one of the chat participants)
          if (!order && chatParticipantIds.length > 0) {
            const proposerIdStr = proposer._id.toString();
            if (chatParticipantIds.includes(proposerIdStr)) {
              // Find order where one of the chat participants is the client or talent
              for (const participantId of chatParticipantIds) {
                const participantObjId = mongoose.Types.ObjectId.isValid(participantId) 
                  ? new mongoose.Types.ObjectId(participantId) 
                  : participantId;
                
                order = await Order.findOne({
                  gig: gigId,
                  $or: [{ client: participantObjId }, { talent: participantObjId }]
                })
                  .populate('client', 'username profile')
                  .populate('talent', 'username profile')
                  .populate('gig', 'title talent')
                  .populate('gig.talent', 'username profile')
                  .sort({ createdAt: -1 })
                  .lean();

                if (order) {
                  // Verify proposer is actually a participant of this order
                  const orderClientId = order.client?._id?.toString() || order.client?.toString();
                  const orderTalentId = order.talent?._id?.toString() || order.talent?.toString();
                  
                  if (orderClientId === proposerIdStr || orderTalentId === proposerIdStr) {
                    console.log('[governance:create] Order found by chat participant:', order._id);
                    break;
                  } else {
                    order = null; // Proposer is not a participant of this order
                  }
                }
              }
            }
          }

          if (!order) {
            // Final check: count all orders for debugging
            const totalOrdersForGig = await Order.countDocuments({ gig: gigId });
            const allOrdersDebug = await Order.find({ gig: gigId })
              .select('_id client talent chat status')
              .lean();
            
            console.log('[governance:create] No order found after all strategies');
            console.log('[governance:create] Debug info:', {
              chatId,
              gigId: gigId.toString(),
              proposerId: proposer._id.toString(),
              proposerIdType: typeof proposer._id,
              chatParticipants: chatParticipantIds,
              totalOrdersForGig,
              allOrders: allOrdersDebug.map(o => ({
                orderId: o._id.toString(),
                client: o.client?.toString() || o.client,
                talent: o.talent?.toString() || o.talent,
                chat: o.chat?.toString() || o.chat || 'none',
                status: o.status
              }))
            });
            
            // If there are orders but we couldn't match, provide more specific error
            if (totalOrdersForGig > 0) {
              return res.status(404).json({ 
                error: `Found ${totalOrdersForGig} order(s) for this gig, but you are not a participant of the order linked to this chat. Only the client who placed the order or the talent (gig creator) for this specific order can create a dispute.` 
              });
            }
            
            // Allow dispute creation even without an order - use chat as work item reference
            // Extract client and talent from chat participants
            const clientParticipant = chat.participants?.find(p => p.role === 'client');
            const talentParticipant = chat.participants?.find(p => p.role === 'talent');
            
            const clientId = clientParticipant?.user?._id || clientParticipant?.user;
            const talentId = talentParticipant?.user?._id || talentParticipant?.user || chat.gig?.talent?._id || chat.gig?.talent;
            
            if (!clientId || !talentId) {
              return res.status(400).json({ 
                error: 'Unable to identify both client and talent from chat. Please ensure the chat has both participants.' 
              });
            }
            
            // Check if proposer is a participant
            const proposerIdStr = proposer._id.toString();
            const isParticipant = [clientId?.toString(), talentId?.toString()].includes(proposerIdStr);
            
            if (!isParticipant) {
              return res.status(403).json({
                error: 'Only participants of the chat can initiate a dispute'
              });
            }
            
            // Create a virtual work item from chat for dispute context
            // Ensure chatId is a valid ObjectId
            const chatObjectId = mongoose.Types.ObjectId.isValid(chatId) 
              ? (typeof chatId === 'string' ? new mongoose.Types.ObjectId(chatId) : chatId)
              : chatId;
            
            workItem = {
              _id: chatObjectId, // Use chat ID as work item ID
              chat: chatObjectId,
              gig: chat.gig,
              client: clientId,
              talent: talentId,
              status: chat.workflowStatus || chat.status || 'active',
              orderNumber: `CHAT-${chatObjectId.toString().slice(-8).toUpperCase()}`,
              isChatBased: true
            };
            actualJobModel = 'Chat'; // Keep as Chat since no order exists
            
            console.log('[governance:create] Creating dispute from chat without order:', {
              chatId,
              clientId,
              talentId,
              proposerId: proposer._id
            });
          }

          // If order exists and doesn't have chat field set, update it
          if (order && (!order.chat || order.chat.toString() !== chatId.toString())) {
            console.log('[governance:create] Updating order chat field:', order._id, '->', chatId);
            await Order.findByIdAndUpdate(order._id, { chat: chatId });
            order.chat = chatId;
          }

          if (order) {
            workItem = order;
            actualJobModel = 'Order';
            console.log('[governance:create] Successfully resolved Chat to Order:', {
              chatId,
              orderId: workItem._id,
              gigId: chat.gig._id,
              orderClient: workItem.client?._id,
              orderTalent: workItem.talent?._id
            });
          } else {
            // workItem is already set as virtual object above
            console.log('[governance:create] Creating dispute from chat (no order):', {
              chatId,
              workItemId: workItem._id,
              gigId: chat.gig._id,
              clientId: workItem.client,
              talentId: workItem.talent
            });
          }
          }
        } else {
          // Normal Job or Order lookup (when jobModel is 'Job' or 'Order' directly, not 'Chat')
          if (disputeContext.jobModel === 'Job') {
            // For Job model, the jobId could be either a chatId or a jobId
            // First try to find chat by jobId (in case it's actually a chatId)
            // Then try to find chat by job reference
            const Job = require('../models/Job');
            const jobIdOrChatId = disputeContext.jobId;
            
            console.log('[governance:create] Job model lookup, jobIdOrChatId:', jobIdOrChatId);
            
            // First try to find chat directly by ID (in case jobId is actually a chatId)
            let chat = await Chat.findById(jobIdOrChatId)
              .populate('job', 'title client applications')
              .populate('participants.user', 'username email profile')
              .lean();
            
            // If chat not found by ID, try to find chat by job reference and proposer
            if (!chat || !chat.job) {
              console.log('[governance:create] Chat not found by ID, trying to find by job and proposer');
              const job = await Job.findById(jobIdOrChatId)
                .populate('client', 'username profile')
                .lean();
              
              if (job) {
                // Find chat that links to this job and involves the proposer
                chat = await Chat.findOne({
                  job: job._id,
                  'participants.user': proposer._id
                })
                  .populate('job', 'title client applications')
                  .populate('participants.user', 'username email profile')
                  .lean();
                
                console.log('[governance:create] Found chat by job and proposer:', {
                  chatId: chat?._id,
                  jobId: job._id,
                  proposerId: proposer._id.toString()
                });
              }
            }
            
            if (chat && chat.job) {
              const job = await Job.findById(chat.job._id || chat.job)
                .populate('client', 'username profile')
                .populate('applications.talent', 'username profile')
                .lean();
              
              if (job) {
                // Find application by chatId
                let application = job.applications?.find(app => {
                  const appChatId = app.chatId?._id || app.chatId;
                  return appChatId && appChatId.toString() === chat._id.toString();
                });
                
                // If not found by chatId, try by talent from chat participants
                if (!application) {
                  const talentParticipant = chat.participants?.find(p => p.role === 'talent');
                  const talentId = talentParticipant?.user?._id || talentParticipant?.user;
                  
                  if (talentId) {
                    application = job.applications?.find(app => {
                      const appTalentId = app.talent?._id || app.talent;
                      return appTalentId && appTalentId.toString() === talentId.toString();
                    });
                  }
                }
                
                if (application) {
                  // Helper to extract ID - handles ObjectId, populated objects, and strings
                  const extractIdValue = (value) => {
                    if (!value) return null;
                    if (typeof value === 'string') return value;
                    if (value._id) return value._id.toString();
                    if (value.toString) return value.toString();
                    return null;
                  };
                  
                  const applicationTalentId = extractIdValue(application.talent);
                  
                  console.log('[governance:create] Found application (Job model path):', {
                    applicationId: application._id,
                    applicationTalentId: applicationTalentId,
                    proposerId: proposer._id.toString(),
                    willMatch: applicationTalentId === proposer._id.toString()
                  });
                  
                  workItem = {
                    _id: application._id,
                    job: job._id,
                    chat: chat._id,
                    client: extractIdValue(job.client),
                    talent: applicationTalentId,
                    status: application.status || 'pending',
                    applicationNumber: `APP-${application._id.toString().slice(-8).toUpperCase()}`,
                    isApplicationBased: true,
                    jobTitle: job.title,
                    bidAmount: application.bidAmount,
                    estimatedDuration: application.estimatedDuration
                  };
                  actualJobModel = 'Job';
                  
                  console.log('[governance:create] Created workItem (Job model path):', {
                    workItemId: workItem._id,
                    clientId: workItem.client,
                    talentId: workItem.talent,
                    proposerId: proposer._id.toString()
                  });
                } else {
                  console.error('[governance:create] Application not found for chat:', {
                    chatId,
                    jobId: job._id,
                    applications: job.applications?.map(app => ({
                      appId: app._id,
                      appChatId: app.chatId?._id || app.chatId,
                      appTalentId: app.talent?._id || app.talent
                    }))
                  });
                  return res.status(404).json({ error: 'Application not found for this chat' });
                }
              } else {
                return res.status(404).json({ error: 'Job not found' });
              }
            } else {
              // If jobId is actually a job ID (not chatId), find the job directly
              // This is a fallback - should not happen in normal flow
              console.log('[governance:create] Chat not found, trying direct job lookup:', disputeContext.jobId);
              const job = await Job.findById(disputeContext.jobId)
                .populate('client', 'username profile')
                .populate('applications.talent', 'username profile')
                .lean();
              
              if (!job) {
                return res.status(404).json({ error: 'Job not found' });
              }
              
              // Find the specific application
              // Job creator can dispute any application, talent can only dispute their own
              const proposerIdStr = proposer._id.toString();
              const jobClientId = job.client?._id?.toString() || job.client?.toString();
              const isProposerJobCreator = jobClientId === proposerIdStr;
              
              let application = null;
              
              if (isProposerJobCreator) {
                // Job creator can dispute any application - find by jobIdOrChatId if it's a chatId
                // or use the first application if it's a jobId
                if (mongoose.Types.ObjectId.isValid(disputeContext.jobId)) {
                  // Try to find application by chatId first
                  application = job.applications?.find(app => {
                    const appChatId = app.chatId?._id || app.chatId;
                    return appChatId && appChatId.toString() === disputeContext.jobId;
                  });
                  
                  // If not found by chatId, use first application (job creator can dispute any)
                  if (!application && job.applications?.length > 0) {
                    application = job.applications[0];
                  }
                }
              } else {
                // Talent can only dispute their own application
                application = job.applications?.find(app => {
                  const appTalentId = app.talent?._id || app.talent;
                  return appTalentId && appTalentId.toString() === proposerIdStr;
                });
              }
              
              if (application) {
                const extractIdValue = (value) => {
                  if (!value) return null;
                  if (typeof value === 'string') return value;
                  if (value._id) return value._id.toString();
                  if (value.toString) return value.toString();
                  return null;
                };
                
                workItem = {
                  _id: application._id,
                  job: job._id,
                  client: extractIdValue(job.client),
                  talent: extractIdValue(application.talent),
                  status: application.status || 'pending',
                  applicationNumber: `APP-${application._id.toString().slice(-8).toUpperCase()}`,
                  isApplicationBased: true,
                  jobTitle: job.title,
                  bidAmount: application.bidAmount,
                  estimatedDuration: application.estimatedDuration
                };
                actualJobModel = 'Job';
              } else {
                // No application found - return error
                return res.status(404).json({ 
                  error: isProposerJobCreator 
                    ? 'No application found for this job. Please select a specific application to dispute.'
                    : 'Application not found. You can only dispute your own application for this job.'
                });
              }
            }
          } else {
            // Order lookup
            const Model = Order;
          workItem = await Model.findById(disputeContext.jobId)
            .populate('client', 'username profile')
            .populate('talent', 'username profile')
            .populate('gig', 'title talent')
            .populate('gig.talent', 'username profile');

          if (!workItem) {
              return res.status(404).json({ error: 'Referenced order not found' });
            }
            actualJobModel = 'Order';
          }
        }

        let clientId;
        let talentId;

        // Helper function to extract ID from various formats
        const extractId = (value) => {
          if (!value) return null;
          if (typeof value === 'string') return value;
          if (value._id) return value._id.toString();
          if (value.toString) return value.toString();
          return null;
        };

        if (actualJobModel === 'Job') {
          // For job applications:
          // - clientId: The job creator (job.client)
          // - talentId: The talent who applied (application.talent)
          // Either the job creator OR the applicant can submit a dispute
          clientId = extractId(workItem.client);
          talentId = extractId(workItem.talent); // This is the application's talent
        } else if (actualJobModel === 'Chat') {
          // For Chat-based disputes (fallback when no order/application found)
          // client and talent are already set in workItem from chat participants
          clientId = extractId(workItem.client);
          talentId = extractId(workItem.talent);
        } else {
          // Order case (for gigs):
          // - clientId: The client who made the order (order.client)
          // - talentId: The talent (gig creator) (order.talent)
          // Either the client who ordered OR the talent (gig creator) can submit a dispute
          clientId = extractId(workItem.client);
          talentId = extractId(workItem.talent); // order.talent is the gig creator
        }

        const proposerIdStr = proposer._id.toString();

        console.log('[governance:create] Participant check:', {
          proposerId: proposerIdStr,
          proposerUsername: proposer.username,
          clientId: clientId,
          talentId: talentId,
          actualJobModel,
          workItemClient: workItem.client,
          workItemTalent: workItem.talent,
          workItemType: typeof workItem.client,
          workItemTalentType: typeof workItem.talent,
          isClient: clientId && clientId === proposerIdStr,
          isTalent: talentId && talentId === proposerIdStr
        });

        const isClient = clientId && clientId === proposerIdStr;
        const isTalent = talentId && talentId === proposerIdStr;
        const isParticipant = isClient || isTalent;

        if (!isParticipant) {
          const errorMessage = actualJobModel === 'Job' 
            ? 'Only participants of the job application can initiate a dispute. You must be either the job creator (client) or the talent who applied for this specific job application.'
            : actualJobModel === 'Order'
            ? 'Only participants of the gig order can initiate a dispute. You must be either the client who placed this order or the talent (gig creator) for this specific order.'
            : 'Only participants of the job or gig can initiate a dispute. You must be either the client or the talent involved.';
          
          console.error('[governance:create] Participant check failed:', {
            proposerId: proposerIdStr,
            proposerUsername: proposer.username,
            proposerRole: proposer.role,
            clientId: clientId,
            talentId: talentId,
            workItem: {
              _id: workItem._id,
              client: workItem.client,
              talent: workItem.talent,
              clientType: typeof workItem.client,
              talentType: typeof workItem.talent
            },
            actualJobModel,
            comparison: {
              clientMatch: clientId === proposerIdStr,
              talentMatch: talentId === proposerIdStr,
              clientIdType: typeof clientId,
              talentIdType: typeof talentId,
              proposerIdType: typeof proposerIdStr
            }
          });
          return res.status(403).json({
            error: errorMessage
          });
        }

        console.log('[governance:create] Participant check passed:', {
          proposerId: proposerIdStr,
          isClient,
          isTalent,
          actualJobModel
        });

        baseProposal.disputeContext = {
          job: workItem._id,
          jobModel: actualJobModel, // Use resolved model (Order if Chat was provided)
          client: clientId,
          talent: talentId,
          issueSummary: disputeContext.issueSummary,
          clientNarrative: disputeContext.clientNarrative,
          talentNarrative: disputeContext.talentNarrative,
          attachments: disputeContext.attachments || [],
          history: disputeContext.history || []
        };
      }

      await baseProposal.save();
      
      console.log('[governance:create] Proposal created:', {
        id: baseProposal._id,
        title: baseProposal.title,
        isActive: baseProposal.isActive,
        status: baseProposal.status,
        proposalType: baseProposal.proposalType
      });

      await proposer.incrementDaoStat(
        proposalType === 'dispute' ? 'disputesRaised' : 'proposalsSubmitted'
      );

      const hydrated = await withFinalizedProposal(baseProposal._id);
      const minActivityPoints = await getMinVoteActivityPoints();
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: minActivityPoints }
      });

      const response = await buildProposalResponse(hydrated, proposer, eligibleVoters);
      console.log('[governance:create] Returning proposal response:', {
        id: response._id,
        status: response.status
      });

      res.status(201).json(response);
    } catch (error) {
      console.error('[governance:create] error', error);
      res.status(500).json({ error: 'Unable to create proposal' });
    }
  }
);

// POST /api/governance/:id/vote
router.post(
  '/:id/vote',
  auth,
  [
    body('vote').notEmpty().withMessage('Vote selection is required'),
    body('reason').optional().isString().isLength({ max: 1000 })
  ],
  handleValidation,
  async (req, res) => {
    try {
      const { vote, reason } = req.body;

      const voter = await User.findById(req.user.id);
      if (!voter) {
        return res.status(404).json({ error: 'User not found' });
      }

      const minActivityPoints = await getMinVoteActivityPoints();
      if (!voter.canVote()) {
        return res.status(403).json({
          error: `Minimum ${minActivityPoints} activity points required to vote`
        });
    }

    const proposal = await Proposal.findById(req.params.id);

    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

      await finalizeProposalIfExpired(proposal);

      if (!proposal.isVotingOpen()) {
        return res.status(400).json({ error: 'Voting period has ended for this proposal' });
      }

      const allowedVotes = proposal.allowedVoteOptions();
      if (!allowedVotes.includes(vote)) {
        return res.status(400).json({ error: 'Invalid vote option for this proposal' });
      }

      const alreadyVoted = proposal.votes.some(
        (existingVote) => existingVote.user.toString() === voter._id.toString()
      );

      if (alreadyVoted) {
        // Return the current proposal state so frontend can display the user's vote
        const refreshed = await withFinalizedProposal(proposal._id);
        const eligibleVoters = await User.countDocuments({
          'stats.activityPoints': { $gte: minActivityPoints }
        });
        
        return res.status(400).json({ 
          error: 'You have already voted on this proposal',
          proposal: await buildProposalResponse(refreshed, voter, eligibleVoters)
        });
      }

    proposal.votes.push({
        user: voter._id,
        vote,
        reason
      });

      proposal.recalculateTallies();
    await proposal.save();

      // Get activity points from config (default: 5)
      const Config = require('../models/Config');
      const activityPoints = await Config.getValue('activity_points_voting', 5);
      await voter.addActivityPoints(activityPoints);
      await voter.incrementDaoStat('votesCast');

      const refreshed = await withFinalizedProposal(proposal._id);
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: minActivityPoints }
      });

      // Calculate vote power: votes cast + activity points + locked tokens (locked tokens checked on frontend)
      const votePower = (voter.stats?.dao?.votesCast || 0) + voter.stats?.activityPoints || 0;
      
      // Get voter reward amount from config (stored in backend, not contract)
      const voterRewardAmount = await Config.getValue('voter_reward_amount', 0);
      
      res.json({
        message: 'Vote recorded successfully. You can now claim your voter reward.',
        proposal: await buildProposalResponse(refreshed, voter, eligibleVoters),
        votePower: votePower,
        shouldClaimReward: voterRewardAmount > 0, // Only claim if reward amount is set
        voterRewardAmount: voterRewardAmount // Return the reward amount from config
      });
  } catch (error) {
      console.error('[governance:vote] error', error);
      res.status(500).json({ error: 'Unable to record vote' });
    }
  }
);

// POST /api/governance/:id/comments
router.post(
  '/:id/comments',
  auth,
  [
    body('comment')
      .isString()
      .isLength({ min: 5, max: 1500 })
      .withMessage('Comment must be between 5 and 1500 characters')
  ],
  handleValidation,
  async (req, res) => {
    try {
      const viewer = await User.findById(req.user.id);
      if (!viewer) {
        return res.status(404).json({ error: 'User not found' });
      }

      const minActivityPoints = await getMinVoteActivityPoints();
      if (!viewer.canVote()) {
        return res.status(403).json({
          error: `Only DAO members with ${minActivityPoints}+ activity points can comment`
        });
      }

    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

      if (proposal.proposalType === 'dispute') {
        if (!proposal.disputeContext) {
          proposal.disputeContext = {};
        }
        if (!proposal.disputeContext.generalComments) {
          proposal.disputeContext.generalComments = [];
        }

        proposal.disputeContext.generalComments.push({
          commenter: viewer._id,
          comment: req.body.comment,
          createdAt: new Date()
        });

        proposal.markModified('disputeContext');
      } else {
        proposal.comments.push({
          user: viewer._id,
          comment: req.body.comment
        });
        proposal.markModified('comments');
      }

      await proposal.save();
      await viewer.incrementDaoStat('commentsPosted');

      const refreshed = await withFinalizedProposal(proposal._id);
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: minActivityPoints }
      });

      const response = await buildProposalResponse(refreshed, viewer, eligibleVoters);
      res.status(201).json(response);
  } catch (error) {
      console.error('[governance:comment] error', error);
      res.status(500).json({ error: 'Unable to add comment' });
    }
  }
);

// POST /api/governance/:id/dispute/messages
router.post(
  '/:id/dispute/messages',
  auth,
  upload.array('attachments', 5), // Allow up to 5 attachments
  async (req, res) => {
    try {
      // Manual validation for message (since we're using multer)
      const message = req.body.message || '';
      if (message.length < 2 && (!req.files || req.files.length === 0)) {
        return res.status(400).json({ 
          error: 'Message must be at least 2 characters or include at least one attachment' 
        });
      }
      if (message.length > 4000) {
        return res.status(400).json({ error: 'Message must not exceed 4000 characters' });
      }

      const member = await User.findById(req.user.id);
      if (!member) {
        return res.status(404).json({ error: 'User not found' });
      }

      const minActivityPoints = await getMinVoteActivityPoints();
      if (!member.canVote()) {
        return res.status(403).json({
          error: `Minimum ${minActivityPoints}+ activity points required for DAO messaging`
        });
      }

      const proposal = await Proposal.findById(req.params.id);
      if (!proposal || proposal.proposalType !== 'dispute') {
        return res.status(404).json({ error: 'Dispute proposal not found' });
      }

      // Process uploaded files
      const baseUrl = process.env.BACKEND_URL || 'http://localhost:5000';
      const attachments = (req.files || []).map(file => ({
        filename: file.filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url: `${baseUrl}/uploads/governance/${file.filename}` // Full URL for frontend
      }));

      if (!proposal.disputeContext) {
        proposal.disputeContext = {};
      }
      if (!proposal.disputeContext.collaborationThread) {
        proposal.disputeContext.collaborationThread = [];
      }

      proposal.disputeContext.collaborationThread.push({
        sender: member._id,
        role: 'dao',
        message: message,
        attachments: attachments,
        createdAt: new Date()
      });
      proposal.markModified('disputeContext');

      await proposal.save();

      const refreshed = await withFinalizedProposal(proposal._id);
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: minActivityPoints }
      });

      res.status(201).json(buildProposalResponse(refreshed, member, eligibleVoters));
  } catch (error) {
      console.error('[governance:dispute-message] error', error);
      res.status(500).json({ error: 'Unable to post message' });
    }
  }
);

// POST /api/governance/:id/resolve
router.post('/:id/resolve', auth, async (req, res) => {
  try {
    const resolver = await User.findById(req.user.id);
    if (!resolver) {
      return res.status(404).json({ error: 'User not found' });
    }

    const minActivityPoints = await getMinVoteActivityPoints();
    if (!resolver.canVote()) {
      return res.status(403).json({
        error: `Minimum ${minActivityPoints}+ activity points required to resolve proposals`
      });
    }

    const proposal = await Proposal.findById(req.params.id);

    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    await finalizeProposalIfExpired(proposal);

    if (!proposal.voting?.autoFinalized) {
      return res.status(400).json({
        error: 'Voting must be completed before resolving a proposal'
      });
    }

    if (proposal.resolution?.resolvedAt) {
      return res.status(400).json({ error: 'Proposal already resolved' });
    }

    // For dispute proposals, calculate settlement amounts and return contract call data
    let resolveDisputeData = null;
    if (proposal.proposalType === 'dispute') {
      // Get chat to extract wallet addresses from escrow transactions
      let chat = null;
      let clientWalletAddress = null;
      let talentWalletAddress = null;
      
      if (proposal.disputeContext.jobModel === 'Chat') {
        chat = await Chat.findById(proposal.disputeContext.job);
        
        if (chat?.escrow) {
          // Get client wallet from deposit transaction (client deposits)
          if (chat.escrow.deposit?.fromAddress) {
            clientWalletAddress = chat.escrow.deposit.fromAddress.toLowerCase();
          }
          
          // Get talent wallet from in-progress transaction (talent signs in-progress)
          // Or from completion transaction, or from deposit toAddress
          if (chat.escrow.inProgress?.fromAddress) {
            talentWalletAddress = chat.escrow.inProgress.fromAddress.toLowerCase();
          } else if (chat.escrow.completion?.fromAddress) {
            talentWalletAddress = chat.escrow.completion.fromAddress.toLowerCase();
          } else if (chat.escrow.deposit?.toAddress) {
            talentWalletAddress = chat.escrow.deposit.toAddress.toLowerCase();
          }
        }
      }
      
      // Fallback to user profile wallet addresses if not found in escrow
      if (!clientWalletAddress) {
        const clientUser = await User.findById(proposal.disputeContext.client);
        clientWalletAddress = clientUser?.walletAddress || clientUser?.connectedWalletAddress;
        if (clientWalletAddress) {
          clientWalletAddress = clientWalletAddress.toLowerCase();
        }
      }
      
      if (!talentWalletAddress) {
        const talentUser = await User.findById(proposal.disputeContext.talent);
        talentWalletAddress = talentUser?.walletAddress || talentUser?.connectedWalletAddress;
        if (talentWalletAddress) {
          talentWalletAddress = talentWalletAddress.toLowerCase();
        }
      }
      
      if (!clientWalletAddress || !talentWalletAddress) {
        return res.status(400).json({ 
          error: 'Client or talent wallet address not found. Please ensure both parties have completed escrow transactions (deposit and in-progress) or have connected wallets in their profile.' 
        });
      }

      // Get remaining amount from contract history (chat already loaded above)
      let remainingAmountUSD = 0;
      if (chat?.escrow?.deposit?.amountUSD) {
        const totalDisbursed = chat.escrow.disbursements?.reduce((sum, d) => sum + (d.amountUSD || 0), 0) || 0;
        remainingAmountUSD = chat.escrow.deposit.amountUSD - totalDisbursed;
      }

      // Get settlement percentage from config
      const Config = require('../models/Config');
      const settlementPercentage = parseFloat(await Config.getValue('settlement_percentage')) || 90;
      const maxSettlementAmountUSD = remainingAmountUSD * (settlementPercentage / 100);

      let clientAmountUSD = 0;
      let talentAmountUSD = 0;
      let resolutionType = 'voting_outcome';

      // Check if there's a mutual agreement (both parties approved settlement)
      const settlement = proposal.disputeContext?.settlement;
      if (settlement?.clientApproved && settlement?.talentApproved && 
          settlement.talentAmount !== null && settlement.talentAmount !== undefined &&
          settlement.clientAmount !== null && settlement.clientAmount !== undefined) {
        // Use settlement amounts from mutual agreement
        clientAmountUSD = settlement.clientAmount || 0;
        talentAmountUSD = settlement.talentAmount || 0;
        resolutionType = 'mutual_agreement';
      } else {
        // Calculate amounts based on voting outcome
        const finalDecision = proposal.voting?.finalDecision || 'split_funds'; // Default to split if no decision
        
        if (finalDecision === 'client_refund') {
          clientAmountUSD = maxSettlementAmountUSD;
          talentAmountUSD = 0;
        } else if (finalDecision === 'talent_refund') {
          clientAmountUSD = 0;
          talentAmountUSD = maxSettlementAmountUSD;
        } else {
          // split_funds or no votes (equal split)
          clientAmountUSD = maxSettlementAmountUSD / 2;
          talentAmountUSD = maxSettlementAmountUSD / 2;
        }
      }

      // Convert USD to ETH
      const ethPriceUsd = parseFloat(process.env.ETH_PRICE_USD || 3000);
      const minAmountETH = 0.000005; // Minimum $1 USD in ETH (approximately)
      
      let clientAmountETH = clientAmountUSD > 0 
        ? clientAmountUSD / ethPriceUsd 
        : minAmountETH;
      let talentAmountETH = talentAmountUSD > 0
        ? talentAmountUSD / ethPriceUsd
        : minAmountETH;

      // Ensure minimum amounts (contract requires minimum if amount > 0)
      if (clientAmountUSD > 0 && clientAmountETH < minAmountETH) {
        clientAmountETH = minAmountETH;
      }
      if (talentAmountUSD > 0 && talentAmountETH < minAmountETH) {
        talentAmountETH = minAmountETH;
      }

      // If amount is 0, set to 0 (don't use minimum)
      if (clientAmountUSD === 0) {
        clientAmountETH = 0;
      }
      if (talentAmountUSD === 0) {
        talentAmountETH = 0;
      }

      resolveDisputeData = {
        clientWalletAddress,
        talentWalletAddress,
        clientAmountETH,
        talentAmountETH,
        shouldCallContract: !!(clientWalletAddress && talentWalletAddress),
        resolutionType,
        finalDecision: proposal.voting?.finalDecision || 'split_funds',
        clientAmountUSD,
        talentAmountUSD
      };
    }

    // Don't save yet - wait for contract call to succeed
    // Return data for frontend to call contract first
    res.json({
      message: proposal.proposalType === 'dispute' 
        ? 'Ready to resolve dispute. Please confirm contract transaction.' 
        : 'Proposal ready to resolve',
      resolveDisputeData,
      proposalId: proposal._id.toString()
    });
  } catch (error) {
    console.error('[governance:resolve] error', error);
    res.status(500).json({ error: 'Unable to resolve proposal' });
  }
});

// POST /api/governance/:id/resolve/confirm
// Confirm resolution after successful contract call
router.post('/:id/resolve/confirm', auth, async (req, res) => {
  try {
    const resolver = await User.findById(req.user.id);
    if (!resolver) {
      return res.status(404).json({ error: 'User not found' });
    }

    const minActivityPoints = await getMinVoteActivityPoints();
    if (!resolver.canVote()) {
      return res.status(403).json({
        error: `Minimum ${minActivityPoints}+ activity points required to resolve proposals`
      });
    }

    const proposal = await Proposal.findById(req.params.id);
    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    if (proposal.resolution?.resolvedAt) {
      return res.status(400).json({ error: 'Proposal already resolved' });
    }

    // Verify contract transaction hash if provided
    const { txHash } = req.body;
    if (proposal.proposalType === 'dispute' && !txHash) {
      return res.status(400).json({ error: 'Transaction hash required for dispute resolution' });
    }

    proposal.status = 'resolved';
    if (!proposal.resolution) {
      proposal.resolution = {};
    }
    proposal.resolution.resolvedBy = resolver._id;
    proposal.resolution.resolvedAt = new Date();
    
    // For disputes, set outcome based on resolution type
    if (proposal.proposalType === 'dispute') {
      const { resolutionType, finalDecision, clientAmountUSD, talentAmountUSD } = req.body;
      
      // Check if there's a mutual agreement
      const settlement = proposal.disputeContext?.settlement;
      if (settlement?.clientApproved && settlement?.talentApproved && resolutionType === 'mutual_agreement') {
        proposal.resolution.outcome = 'split_funds'; // Settlement is essentially a split
        proposal.resolution.summary = `Dispute resolved by mutual agreement. Client: $${clientAmountUSD || 0}, Talent: $${talentAmountUSD || 0}`;
        proposal.disputeContext.settlement.settledByAgreement = true;
        proposal.disputeContext.settlement.resolvedBy = resolver._id;
        proposal.disputeContext.settlement.resolvedAt = new Date();
      } else {
        // Voting outcome
        const decision = finalDecision || proposal.voting?.finalDecision || 'split_funds';
        proposal.resolution.outcome = decision;
        
        // Create summary
        if (decision === 'client_refund') {
          proposal.resolution.summary = 'Dispute resolved: Full refund to client based on voting outcome.';
        } else if (decision === 'talent_refund') {
          proposal.resolution.summary = 'Dispute resolved: Full refund to talent based on voting outcome.';
        } else {
          proposal.resolution.summary = 'Dispute resolved: Funds split equally between client and talent based on voting outcome.';
        }
      }
      
      if (txHash) {
        proposal.resolution.notes = `Resolved via DAO contract. Transaction: ${txHash}`;
      }
    }

    await proposal.save();
    
    if (proposal.proposalType === 'dispute') {
      await resolver.incrementDaoStat('disputesResolved');
    }

    const hydrated = await withFinalizedProposal(proposal._id);
    const eligibleVoters = await User.countDocuments({
      'stats.activityPoints': { $gte: minActivityPoints }
    });

    const proposalResponse = await buildProposalResponse(hydrated, resolver, eligibleVoters);

    // Emit socket event for real-time updates
    const io = req.app.get('io');
    if (io) {
      io.emit('proposal:updated', {
        proposalId: proposal._id.toString(),
        proposal: proposalResponse
      });
    }

    res.json({
      message: 'Proposal marked as resolved',
      proposal: proposalResponse
    });
  } catch (error) {
    console.error('[governance:resolve/confirm] error', error);
    res.status(500).json({ error: 'Unable to confirm resolution' });
  }
});

// Settlement routes for dispute resolution
// Set/update settlement amounts (DAO members with voting rights, not talent/client)
router.post(
  '/:id/settlement',
  auth,
  [
    body('talentAmount').optional().isFloat({ min: 0 }).withMessage('Talent amount must be a positive number'),
    body('clientAmount').optional().isFloat({ min: 0 }).withMessage('Client amount must be a positive number'),
  ],
  handleValidation,
  async (req, res) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Allow any DAO member with voting rights to set settlement
      const minActivityPoints = await getMinVoteActivityPoints();
      if (!user.canVote()) {
        return res.status(403).json({
          error: `Minimum ${minActivityPoints} activity points required to set settlement amounts`
        });
      }

      const proposal = await Proposal.findById(req.params.id);
      if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      if (proposal.proposalType !== 'dispute') {
        return res.status(400).json({ error: 'Settlement is only available for dispute proposals' });
      }

      const clientId = proposal.disputeContext?.client?.toString();
      const talentId = proposal.disputeContext?.talent?.toString();
      const userId = req.user.id.toString();

      // Check if user is client or talent (even if they're DAO members, they can't set amounts)
      if (userId === clientId || userId === talentId) {
        return res.status(403).json({ 
          error: 'Client and talent cannot set settlement amounts, even if they are DAO members' 
        });
      }

      if (!proposal.disputeContext) {
        proposal.disputeContext = {};
      }
      if (!proposal.disputeContext.settlement) {
        proposal.disputeContext.settlement = {};
      }

      const { talentAmount, clientAmount } = req.body;
      if (talentAmount !== undefined) {
        proposal.disputeContext.settlement.talentAmount = talentAmount;
      }
      if (clientAmount !== undefined) {
        proposal.disputeContext.settlement.clientAmount = clientAmount;
      }
      proposal.disputeContext.settlement.settledBy = req.user.id;
      proposal.disputeContext.settlement.updatedAt = new Date();

      await proposal.save();

      const hydrated = await withFinalizedProposal(proposal._id);
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: minActivityPoints }
      });

      const proposalResponse = await buildProposalResponse(hydrated, user, eligibleVoters);

      // Emit socket event for real-time updates
      const io = req.app.get('io');
      if (io) {
        io.emit('proposal:updated', {
          proposalId: proposal._id.toString(),
          proposal: proposalResponse
        });
      }

      res.json({
        message: 'Settlement amounts updated',
        proposal: proposalResponse
      });
    } catch (error) {
      console.error('[governance:settlement] error', error);
      res.status(500).json({ error: 'Unable to update settlement amounts' });
    }
  }
);

// Approve settlement (talent or client only)
router.post(
  '/:id/settlement/approve',
  auth,
  async (req, res) => {
    try {
      const proposal = await Proposal.findById(req.params.id);
      if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      if (proposal.proposalType !== 'dispute') {
        return res.status(400).json({ error: 'Settlement is only available for dispute proposals' });
      }

      const clientId = proposal.disputeContext?.client?.toString();
      const talentId = proposal.disputeContext?.talent?.toString();
      const userId = req.user.id.toString();

      const isClient = userId === clientId;
      const isTalent = userId === talentId;

      if (!isClient && !isTalent) {
        return res.status(403).json({ error: 'Only the client or talent can approve settlement' });
      }

      if (!proposal.disputeContext.settlement) {
        return res.status(400).json({ error: 'Settlement amounts must be set first' });
      }

      if (isClient) {
        proposal.disputeContext.settlement.clientApproved = true;
      }
      if (isTalent) {
        proposal.disputeContext.settlement.talentApproved = true;
      }

      // If both approved, stop voting countdown
      if (proposal.disputeContext.settlement.clientApproved && 
          proposal.disputeContext.settlement.talentApproved) {
        proposal.disputeContext.settlement.settledByAgreement = true;
        // Stop countdown by setting endsAt to now
        proposal.voting.endsAt = new Date();
        proposal.voting.autoFinalized = true;
      }

      proposal.disputeContext.settlement.updatedAt = new Date();
      await proposal.save();

      const hydrated = await withFinalizedProposal(proposal._id);
      const minActivityPoints = await getMinVoteActivityPoints();
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: minActivityPoints }
      });

      const user = await User.findById(req.user.id);
      const proposalResponse = await buildProposalResponse(hydrated, user, eligibleVoters);

      // Emit socket event for real-time updates
      const io = req.app.get('io');
      if (io) {
        io.emit('proposal:updated', {
          proposalId: proposal._id.toString(),
          proposal: proposalResponse
        });
      }

      res.json({
        message: isClient ? 'Client approved settlement' : 'Talent approved settlement',
        proposal: proposalResponse
      });
    } catch (error) {
      console.error('[governance:settlement/approve] error', error);
      res.status(500).json({ error: 'Unable to approve settlement' });
    }
  }
);

// Resolve dispute after both parties approved (DAO members only)
router.post(
  '/:id/settlement/resolve',
  auth,
  ensureDaoProposalEligibility,
  async (req, res) => {
    try {
      const proposal = await Proposal.findById(req.params.id);
      if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      if (proposal.proposalType !== 'dispute') {
        return res.status(400).json({ error: 'Settlement resolution is only available for dispute proposals' });
      }

      if (!proposal.disputeContext.settlement) {
        return res.status(400).json({ error: 'Settlement must be configured first' });
      }

      if (!proposal.disputeContext.settlement.clientApproved || 
          !proposal.disputeContext.settlement.talentApproved) {
        return res.status(400).json({ error: 'Both parties must approve before resolving' });
      }

      if (proposal.disputeContext.settlement.settledByAgreement && proposal.resolution?.resolvedAt) {
        return res.status(400).json({ error: 'Dispute already resolved' });
      }

      // Don't save yet - wait for contract call to succeed
      // Return data for frontend to call contract first

      // Get chat to extract wallet addresses from escrow transactions
      let chat = null;
      let clientWalletAddress = null;
      let talentWalletAddress = null;
      
      if (proposal.disputeContext.jobModel === 'Chat') {
        chat = await Chat.findById(proposal.disputeContext.job);
        
        if (chat?.escrow) {
          // Get client wallet from deposit transaction (client deposits)
          if (chat.escrow.deposit?.fromAddress) {
            clientWalletAddress = chat.escrow.deposit.fromAddress.toLowerCase();
          }
          
          // Get talent wallet from in-progress transaction (talent signs in-progress)
          // Or from completion transaction, or from deposit toAddress
          if (chat.escrow.inProgress?.fromAddress) {
            talentWalletAddress = chat.escrow.inProgress.fromAddress.toLowerCase();
          } else if (chat.escrow.completion?.fromAddress) {
            talentWalletAddress = chat.escrow.completion.fromAddress.toLowerCase();
          } else if (chat.escrow.deposit?.toAddress) {
            talentWalletAddress = chat.escrow.deposit.toAddress.toLowerCase();
          }
        }
      }
      
      // Fallback to user profile wallet addresses if not found in escrow
      if (!clientWalletAddress) {
        const clientUser = await User.findById(proposal.disputeContext.client);
        clientWalletAddress = clientUser?.walletAddress || clientUser?.connectedWalletAddress;
        if (clientWalletAddress) {
          clientWalletAddress = clientWalletAddress.toLowerCase();
        }
      }
      
      if (!talentWalletAddress) {
        const talentUser = await User.findById(proposal.disputeContext.talent);
        talentWalletAddress = talentUser?.walletAddress || talentUser?.connectedWalletAddress;
        if (talentWalletAddress) {
          talentWalletAddress = talentWalletAddress.toLowerCase();
        }
      }
      
      if (!clientWalletAddress || !talentWalletAddress) {
        return res.status(400).json({ 
          error: 'Client or talent wallet address not found. Please ensure both parties have completed escrow transactions (deposit and in-progress) or have connected wallets in their profile.' 
        });
      }
      
      // Settlement amounts are in USD, convert to ETH
      // Use current ETH price or fallback
      const ethPriceUsd = parseFloat(process.env.ETH_PRICE_USD || 3000);
      
      // Calculate ETH amounts from USD settlement amounts
      // These amounts are already 90% of the job amount (as per requirements)
      const talentAmountUSD = proposal.disputeContext.settlement.talentAmount || 0;
      const clientAmountUSD = proposal.disputeContext.settlement.clientAmount || 0;
      
      // Convert USD to ETH
      const talentAmountETH = talentAmountUSD > 0 
        ? talentAmountUSD / ethPriceUsd 
        : 0.000005; // Minimum 0.000005 ETH if 0
      const clientAmountETH = clientAmountUSD > 0
        ? clientAmountUSD / ethPriceUsd
        : 0.000005; // Minimum 0.000005 ETH if 0

      res.json({
        message: 'Ready to resolve dispute by mutual agreement. Please confirm contract transaction.',
        // Return wallet addresses and amounts for frontend to call DAO contract
        resolveDisputeData: {
          clientWalletAddress,
          talentWalletAddress,
          clientAmountETH: clientAmountETH || 0.000005, // Minimum 0.000005 ETH if 0
          talentAmountETH: talentAmountETH || 0.000005, // Minimum 0.000005 ETH if 0
          shouldCallContract: !!(clientWalletAddress && talentWalletAddress)
        },
        proposalId: proposal._id.toString()
      });
    } catch (error) {
      console.error('[governance:settlement/resolve] error', error);
      res.status(500).json({ error: 'Unable to resolve dispute' });
    }
  }
);

// POST /api/governance/:id/settlement/resolve/confirm
// Confirm settlement resolution after successful contract call
router.post(
  '/:id/settlement/resolve/confirm',
  auth,
  ensureDaoProposalEligibility,
  async (req, res) => {
    try {
      const proposal = await Proposal.findById(req.params.id);
      if (!proposal) {
        return res.status(404).json({ error: 'Proposal not found' });
      }
      if (proposal.proposalType !== 'dispute') {
        return res.status(400).json({ error: 'Settlement resolution is only available for dispute proposals' });
      }

      if (!proposal.disputeContext.settlement) {
        return res.status(400).json({ error: 'Settlement must be configured first' });
      }

      if (!proposal.disputeContext.settlement.clientApproved || 
          !proposal.disputeContext.settlement.talentApproved) {
        return res.status(400).json({ error: 'Both parties must approve before resolving' });
      }

      if (proposal.disputeContext.settlement.settledByAgreement && proposal.resolution?.resolvedAt) {
        return res.status(400).json({ error: 'Dispute already resolved' });
      }

      // Verify contract transaction hash
      const { txHash } = req.body;
      if (!txHash) {
        return res.status(400).json({ error: 'Transaction hash required for settlement resolution' });
      }

      proposal.status = 'resolved';
      proposal.disputeContext.settlement.settledByAgreement = true;
      proposal.disputeContext.settlement.resolvedBy = req.user.id;
      proposal.disputeContext.settlement.resolvedAt = new Date();

      if (!proposal.resolution) {
        proposal.resolution = {};
      }
      proposal.resolution.outcome = 'split_funds'; // Settlement is essentially a split
      proposal.resolution.resolvedBy = req.user.id;
      proposal.resolution.resolvedAt = new Date();
      proposal.resolution.summary = `Dispute resolved by mutual agreement. Talent: ${proposal.disputeContext.settlement.talentAmount}, Client: ${proposal.disputeContext.settlement.clientAmount}`;
      proposal.resolution.notes = `Resolved via DAO contract. Transaction: ${txHash}`;

      await proposal.save();

      const resolver = await User.findById(req.user.id);
      if (resolver) {
        await resolver.incrementDaoStat('disputesResolved');
      }

      const hydrated = await withFinalizedProposal(proposal._id);
      const minActivityPoints = await getMinVoteActivityPoints();
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: minActivityPoints }
      });

      const user = await User.findById(req.user.id);
      const proposalResponse = await buildProposalResponse(hydrated, user, eligibleVoters);

      // Emit socket event for real-time updates
      const io = req.app.get('io');
      if (io) {
        io.emit('proposal:updated', {
          proposalId: proposal._id.toString(),
          proposal: proposalResponse
        });
      }

      res.json({
        message: 'Dispute resolved by mutual agreement',
        proposal: proposalResponse
      });
    } catch (error) {
      console.error('[governance:settlement/resolve/confirm] error', error);
      res.status(500).json({ error: 'Unable to confirm settlement resolution' });
    }
  }
);

module.exports = router;
