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

const MIN_VOTE_ACTIVITY_POINTS = 9;
const MIN_PROPOSAL_ACTIVITY_POINTS = 10;
const VOTING_DURATION_DAYS = 5;
const MAX_LIST_LIMIT = 50;

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
      durationDays: proposal.voting?.durationDays ?? VOTING_DURATION_DAYS,
      minActivityPoints: proposal.voting?.minActivityPoints ?? MIN_VOTE_ACTIVITY_POINTS,
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
        User.countDocuments({ 'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS } })
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

      const [leaders, total] = await Promise.all([
        User.find(
          { 'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS } },
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
        User.countDocuments({ 'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS } })
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

// GET /api/governance/eligible-work
// This endpoint uses the SAME approach as /api/chats to fetch chats
// but filters for workflowStatus: 'in-progress' or 'completed'
router.get('/eligible-work', auth, ensureDaoProposalEligibility, async (req, res) => {
  try {
    const requester = req.daoUser;
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
                { $gte: ['$stats.activityPoints', MIN_VOTE_ACTIVITY_POINTS] },
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

// GET /api/governance/:id
router.get('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid proposal id' });
    }

    const proposal = await withFinalizedProposal(req.params.id);

    if (!proposal) {
      return res.status(404).json({ error: 'Proposal not found' });
    }

    const viewer = await User.findById(req.user.id);
    const eligibleVoters = await User.countDocuments({
      'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
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

      if (!proposer.canCreateDaoProposal()) {
        return res.status(403).json({
          error: `Minimum ${MIN_PROPOSAL_ACTIVITY_POINTS} activity points required to create proposals`
        });
      }

      const { title, description, summary, proposalType, category, tags, platformDetails, disputeContext } = req.body;

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
          endsAt: new Date(Date.now() + VOTING_DURATION_DAYS * 24 * 60 * 60 * 1000),
          durationDays: VOTING_DURATION_DAYS,
          minActivityPoints: MIN_VOTE_ACTIVITY_POINTS,
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

        // Support both 'Job'/'Order' and 'Chat' (for chat-based gig resolution)
        if (!['Job', 'Order', 'Chat'].includes(disputeContext.jobModel)) {
          return res.status(400).json({ error: 'Invalid dispute job model' });
        }

        let workItem;
        let actualJobModel = disputeContext.jobModel;

        // If jobModel is 'Chat', resolve to Order
        if (disputeContext.jobModel === 'Chat') {
          // Find order linked to this chat
          const chatId = disputeContext.jobId;
          console.log('[governance:create] Resolving Chat to Order, chatId:', chatId);
          
          const chat = await Chat.findById(chatId)
            .populate('gig', 'title talent')
            .populate('participants.user', 'username email profile')
            .lean();

          if (!chat) {
            console.log('[governance:create] Chat not found:', chatId);
            return res.status(404).json({ error: 'Chat not found' });
          }

          if (!chat.gig) {
            console.log('[governance:create] Chat not associated with a gig:', chatId);
            return res.status(404).json({ error: 'Chat not associated with a gig' });
          }

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

          // Find order for this chat - try multiple strategies
          let order = null;

          // Strategy 1: Find order by chat field
          order = await Order.findOne({
            chat: chatId,
            $or: [{ client: proposer._id }, { talent: proposer._id }]
          })
            .populate('client', 'username profile')
            .populate('talent', 'username profile')
            .populate('gig', 'title talent')
            .populate('gig.talent', 'username profile')
            .lean();

          console.log('[governance:create] Order found by chat field:', order ? order._id : 'none');

          // Strategy 2: Find order by gig and chat participants (try each participant ID individually)
          if (!order && chatParticipantIds.length > 0) {
            // Try each participant as client or talent
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
                console.log('[governance:create] Order found by gig and participant:', order._id, 'participant:', participantId);
                break;
              }
            }

            if (!order) {
              console.log('[governance:create] No order found by gig and participants');
            }
          }

          // Strategy 3: Find any order for this gig where proposer is participant
          if (!order) {
            const gigOrders = await Order.find({
              gig: gigId,
              $or: [{ client: proposer._id }, { talent: proposer._id }]
            })
              .populate('client', 'username profile')
              .populate('talent', 'username profile')
              .populate('gig', 'title talent')
              .populate('gig.talent', 'username profile')
              .sort({ createdAt: -1 })
              .lean();

            console.log('[governance:create] Orders found for gig (proposer participant):', gigOrders.length);
            gigOrders.forEach((o, idx) => {
              console.log(`  ${idx + 1}. Order ${o._id}: client=${o.client?._id}, talent=${o.talent?._id}, chat=${o.chat || 'none'}`);
            });

            if (gigOrders.length > 0) {
              order = gigOrders[0];
            }
          }

          // Strategy 4: Find any order for this gig (last resort)
          if (!order) {
            const allGigOrders = await Order.find({ gig: gigId })
              .populate('client', 'username profile')
              .populate('talent', 'username profile')
              .populate('gig', 'title talent')
              .populate('gig.talent', 'username profile')
              .sort({ createdAt: -1 })
              .limit(1)
              .lean();

            console.log('[governance:create] All orders for gig (any participant):', allGigOrders.length);
            if (allGigOrders.length > 0) {
              order = allGigOrders[0];
              // Check if proposer is participant
              const isProposerClient = order.client?._id?.toString() === proposer._id.toString() || 
                                      order.client?.toString() === proposer._id.toString();
              const isProposerTalent = order.talent?._id?.toString() === proposer._id.toString() || 
                                      order.talent?.toString() === proposer._id.toString();
              
              if (!isProposerClient && !isProposerTalent) {
                console.log('[governance:create] Proposer is not participant of found order');
                order = null;
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
                error: `Found ${totalOrdersForGig} order(s) for this gig, but you are not a participant. Only the client or talent of an order can create a dispute.` 
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
        } else {
          // Normal Job or Order lookup
          const Model = disputeContext.jobModel === 'Job' ? Job : Order;
          workItem = await Model.findById(disputeContext.jobId)
            .populate('client', 'username profile')
            .populate('hiredTalent', 'username profile')
            .populate('talent', 'username profile')
            .populate('gig', 'title talent')
            .populate('gig.talent', 'username profile');

          if (!workItem) {
            return res.status(404).json({ error: 'Referenced job or gig not found' });
          }
        }

        let clientId;
        let talentId;

        if (actualJobModel === 'Job') {
          clientId = workItem.client?._id || workItem.client;
          talentId = workItem.hiredTalent?._id || workItem.hiredTalent;
        } else if (actualJobModel === 'Chat') {
          // For Chat-based disputes, client and talent are already set in workItem
          clientId = workItem.client;
          talentId = workItem.talent;
        } else {
          // Order case
          clientId = workItem.client?._id || workItem.client;
          talentId = workItem.talent?._id || workItem.talent || workItem.gig?.talent?._id;
        }

        const proposerIdStr = proposer._id.toString();
        const isParticipant = [clientId?.toString(), talentId?.toString()].includes(proposerIdStr);

        if (!isParticipant) {
          return res.status(403).json({
            error: 'Only participants of the job or gig can initiate a dispute'
          });
        }

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
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
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

      if (!voter.canVote()) {
        return res.status(403).json({
          error: `Minimum ${MIN_VOTE_ACTIVITY_POINTS} activity points required to vote`
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
          'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
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

      await voter.addActivityPoints(5);
      await voter.incrementDaoStat('votesCast');

      const refreshed = await withFinalizedProposal(proposal._id);
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
      });

      res.json({
        message: 'Vote recorded successfully',
        proposal: await buildProposalResponse(refreshed, voter, eligibleVoters)
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

      if (!viewer.canVote()) {
        return res.status(403).json({
          error: `Only DAO members with ${MIN_VOTE_ACTIVITY_POINTS}+ activity points can comment`
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
        'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
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

      if (!member.canVote()) {
        return res.status(403).json({
          error: `Minimum ${MIN_VOTE_ACTIVITY_POINTS}+ activity points required for DAO messaging`
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
        'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
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

    if (!resolver.canVote()) {
      return res.status(403).json({
        error: `Minimum ${MIN_VOTE_ACTIVITY_POINTS}+ activity points required to resolve proposals`
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

    proposal.status = 'resolved';
    if (!proposal.resolution) {
      proposal.resolution = {};
    }
    proposal.resolution.resolvedBy = resolver._id;
    proposal.resolution.resolvedAt = new Date();

  await proposal.save();
    if (proposal.proposalType === 'dispute') {
      await resolver.incrementDaoStat('disputesResolved');
    }

    const hydrated = await withFinalizedProposal(proposal._id);
    const eligibleVoters = await User.countDocuments({
      'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
    });

    res.json({
      message: 'Proposal marked as resolved',
      proposal: await buildProposalResponse(hydrated, resolver, eligibleVoters)
    });
  } catch (error) {
    console.error('[governance:resolve] error', error);
    res.status(500).json({ error: 'Unable to resolve proposal' });
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
      
      // Allow any DAO member with voting rights (9+ points) to set settlement
      if (!user.canVote()) {
        return res.status(403).json({
          error: `Minimum ${MIN_VOTE_ACTIVITY_POINTS} activity points required to set settlement amounts`
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
        'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
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
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
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

      await proposal.save();

      const resolver = await User.findById(req.user.id);
      if (resolver) {
        await resolver.incrementDaoStat('disputesResolved');
      }

      const hydrated = await withFinalizedProposal(proposal._id);
      const eligibleVoters = await User.countDocuments({
        'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
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
      console.error('[governance:settlement/resolve] error', error);
      res.status(500).json({ error: 'Unable to resolve dispute' });
    }
  }
);

module.exports = router;
