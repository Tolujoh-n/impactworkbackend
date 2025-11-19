const express = require('express');
const { body, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const Job = require('../models/Job');
const Gig = require('../models/Gig');
const Transaction = require('../models/Transaction');

const router = express.Router();

const toLowerAddress = (address = '') => (address ? address.toLowerCase() : address);

const loadChatForEscrow = async (chatId) => {
  return Chat.findById(chatId)
    .populate('participants.user', 'username email role walletAddress stats activityPoints')
    .populate('job', 'title status client hiredTalent budget')
    .populate('gig', 'title status talent pricing orders');
};

const buildTransactionDescription = (chat) => {
  if (chat.job) {
    return `Escrow transaction for job "${chat.job.title}"`;
  }
  if (chat.gig) {
    return `Escrow transaction for gig "${chat.gig.title}"`;
  }
  return 'Escrow transaction for project';
};

// @route   GET /api/chats
// @desc    Get user's chats
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const { type, status, search } = req.query;

    let query = {
      'participants.user': req.user.id
    };

    if (type) {
      query.type = type;
    }

    if (status) {
      query.status = status;
    }

    if (search) {
      query.$text = { $search: search };
    }

    const chats = await Chat.find(query)
      .populate('participants.user', 'username email profile')
      .populate('job', 'title')
      .populate('gig', 'title')
      .populate('lastMessage.sender', 'username')
      .sort({ updatedAt: -1 });

    res.json({
      chats,
      totalPages: 1,
      currentPage: 1,
      total: chats.length
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/chats/:id
// @desc    Get chat by ID with messages
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id)
      .populate('participants.user', 'username email profile')
      .populate('job', 'title')
      .populate('gig', 'title');

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Check if user is a participant
    const isParticipant = chat.participants.some(p => 
      p.user.toString() === req.user.id || p.user._id.toString() === req.user.id
    );
    if (!isParticipant) {
      console.log('Chat access denied for user:', req.user.id);
      console.log('Chat participants:', chat.participants.map(p => p.user.toString()));
      return res.status(403).json({ error: 'Not authorized to access this chat' });
    }

    // Mark messages as read for this user
    await Message.updateMany(
      { 
        chatId: req.params.id,
        senderId: { $ne: req.user.id }
      },
      { 
        $set: { [`isRead.${req.user.id}`]: true }
      }
    );

    // Reset unread count for this user
    chat.unreadCount.set(req.user.id.toString(), 0);
    await chat.save();

    // Get messages
    const messages = await Message.find({ chatId: req.params.id })
      .populate('senderId', 'username email profile')
      .sort({ timestamp: 1 });

    res.json({ chat, messages });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/chats
// @desc    Create a new chat
// @access  Private
router.post('/', [
  auth,
  body('participants').isArray({ min: 1 }).withMessage('At least one participant is required'),
  body('type').isIn(['job', 'gig', 'general']).withMessage('Invalid chat type')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { participants, type, jobId, gigId } = req.body;

    // Add current user to participants
    const allParticipants = [
      ...participants,
      { user: req.user.id, role: req.user.role }
    ];

    const chatData = {
      participants: allParticipants,
      type,
      status: 'active'
    };

    if (jobId) {
      chatData.job = jobId;
    }

    if (gigId) {
      chatData.gig = gigId;
    }

    const chat = new Chat(chatData);
    await chat.save();

    await chat.populate('participants.user', 'username email profile');
    if (jobId) await chat.populate('job', 'title');
    if (gigId) await chat.populate('gig', 'title');

    res.status(201).json(chat);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/chats/:id/status
// @desc    Update chat status
// @access  Private
router.put('/:id/status', [
  auth,
  body('status').isIn(['active', 'archived', 'completed']).withMessage('Invalid status')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const chat = await Chat.findById(req.params.id);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Check if user is a participant
    const isParticipant = chat.participants.some(p => p.user.toString() === req.user.id);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not authorized to update this chat' });
    }

    chat.status = req.body.status;
    await chat.save();

    res.json(chat);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/chats/:id/workflow-status
// @desc    Update workflow status (offered, deposit, in-progress, completed, confirmed)
// @access  Private
router.put('/:id/workflow-status', [
  auth,
  body('workflowStatus').isIn(['offered', 'deposit', 'in-progress', 'completed', 'confirmed']).withMessage('Invalid workflow status')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const chat = await Chat.findById(req.params.id)
      .populate('participants.user', 'role');
    
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Check if user is a participant
    const participant = chat.participants.find(p => p.user._id.toString() === req.user.id);
    if (!participant) {
      return res.status(403).json({ error: 'Not authorized to update this chat' });
    }

    const { workflowStatus } = req.body;

    if (['deposit', 'completed', 'confirmed'].includes(workflowStatus)) {
      return res.status(400).json({ error: 'Escrow actions must be performed through dedicated endpoints' });
    }
    const userRole = participant.role;

    // Check permissions based on role and status
    const allowedTransitions = {
      'client': {
        'offered': ['deposit'],
        'deposit': [], // Client cannot confirm immediately after deposit
        'in-progress': [], // Client cannot confirm while in progress
        'completed': ['confirmed'] // Only confirm after talent completes
      },
      'talent': {
        'deposit': ['in-progress'],
        'in-progress': ['completed'],
        'completed': [] // Talent cannot confirm their own work
      }
    };

    if (!allowedTransitions[userRole] || !allowedTransitions[userRole][chat.workflowStatus]?.includes(workflowStatus)) {
      return res.status(403).json({ 
        error: `${userRole} cannot transition from ${chat.workflowStatus} to ${workflowStatus}` 
      });
    }

    chat.workflowStatus = workflowStatus;
    await chat.save();

    // Emit socket event for real-time updates
    const io = req.app.get('io');
    if (io) {
      io.to(req.params.id).emit('workflow-status-updated', {
        chatId: req.params.id,
        workflowStatus,
        updatedBy: req.user.id
      });
    }

    res.json(chat);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

const shortenAddress = (address = '') => {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const getParticipantsByRole = (chat) => {
  const client = chat.participants.find((p) => p.role === 'client');
  const talent = chat.participants.find((p) => p.role === 'talent');
  return { client, talent };
};

// Helper function to approve pending referrals when a user completes their first job/gig
const approvePendingReferrals = async (userId) => {
  try {
    const Referral = require('../models/Referral');
    const User = require('../models/User');
    
    // Find all pending referrals for this user (the referred user)
    const pendingReferrals = await Referral.find({
      referredUser: userId,
      status: 'pending'
    }).populate('referrer');

    if (pendingReferrals.length === 0) {
      return; // No pending referrals to approve
    }

    // Check if this is the user's first completed job/gig
    const user = await User.findById(userId);
    if (!user) {
      return;
    }

    // Only approve referrals if this is the first completion
    // We check if jobsCompleted is 1 (just incremented) or if it was 0 before
    const isFirstCompletion = user.stats?.jobsCompleted === 1;

    if (!isFirstCompletion) {
      return; // Not the first completion, don't approve referrals
    }

    // Approve all pending referrals for this user
    for (const referral of pendingReferrals) {
      // Update referral status to approved
      referral.status = 'approved';
      referral.approvedAt = new Date();
      await referral.save();

      // Update referrer's LOB tokens
      const referrer = await User.findById(referral.referrer._id);
      if (referrer) {
        // Move tokens from pending to available
        referrer.referral.lobTokens.pending = Math.max(0, (referrer.referral.lobTokens.pending || 0) - (referral.lobTokens || 100));
        referrer.referral.lobTokens.available = (referrer.referral.lobTokens.available || 0) + (referral.lobTokens || 100);
        
        // Add activity points
        referrer.stats = referrer.stats || {};
        referrer.stats.activityPoints = (referrer.stats.activityPoints || 0) + (referral.activityPoints || 5);
        
        await referrer.save();
      }
    }

    console.log(`Approved ${pendingReferrals.length} pending referrals for user ${userId}`);
  } catch (error) {
    console.error('Error approving pending referrals:', error);
    // Don't throw - this is a non-critical operation
  }
};

router.post(
  '/:id/escrow/deposit',
  [
    auth,
    body('txHash').notEmpty().withMessage('Transaction hash is required'),
    body('fromAddress').notEmpty().withMessage('Depositing wallet address is required'),
    body('amountUSD').isFloat({ gt: 0 }).withMessage('USD amount must be greater than zero'),
    body('amountETH').isFloat({ gt: 0 }).withMessage('ETH amount must be greater than zero'),
    body('customerWallet').notEmpty().withMessage('Customer wallet address is required'),
    body('talentWallet').optional().isString()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const chat = await loadChatForEscrow(req.params.id);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      // Log current job status
      console.log('=== Escrow Deposit Request ===');
      console.log('Chat ID:', chat._id.toString());
      console.log('Current workflow status:', chat.workflowStatus);
      console.log('Deposit txHash (if exists):', chat.escrow?.deposit?.txHash);
      console.log('Job ID:', chat.job?._id?.toString() || chat.gig?._id?.toString());
      console.log('Incoming txHash:', req.body.txHash);
      console.log('Incoming fromAddress:', req.body.fromAddress);
      console.log('================================');

      const { client, talent } = getParticipantsByRole(chat);
      if (!client || !talent) {
        return res.status(400).json({ error: 'Escrow requires both client and talent participants' });
      }

      if (client.user._id.toString() !== req.user.id) {
        return res.status(403).json({ error: 'Only the client can record a deposit' });
      }

      if (chat.escrow?.deposit?.txHash) {
        return res.status(400).json({ error: 'Deposit already recorded for this chat' });
      }

      if (chat.workflowStatus !== 'offered') {
        return res.status(400).json({ error: `Cannot deposit when workflow status is "${chat.workflowStatus}"` });
      }

      const amountUSD = Number(req.body.amountUSD);
      const amountETH = Number(req.body.amountETH);
      const fromAddress = toLowerAddress(req.body.fromAddress);
      const talentWallet = req.body.talentWallet ? toLowerAddress(req.body.talentWallet) : null;

      chat.escrow = chat.escrow || {};
      // Store identifiers used for smart contract calls
      // These will be used to verify consistency in completion and confirmation
      const jobOrGigId = chat.job?._id?.toString() || chat.gig?._id?.toString() || chat._id.toString();
      const clientId = client.user._id.toString();
      const talentId = talent.user._id.toString();
      const chatId = chat._id.toString();
      
      chat.escrow.identifiers = {
        jobId: req.body.jobId || jobOrGigId,
        customerId: req.body.customerId || clientId,
        talentId: req.body.talentId || talentId,
        chatId: req.body.chatId || chatId
      };
      
      console.log('Stored escrow identifiers:', chat.escrow.identifiers);
      
      chat.escrow.deposit = {
        txHash: req.body.txHash,
        amountUSD,
        amountETH,
        fromAddress,
        toAddress: talentWallet,
        performedBy: req.user.id,
        occurredAt: new Date()
      };

      chat.workflowStatus = 'deposit';
      chat.status = 'active';
      chat.markModified('escrow');
      await chat.save();

      await Transaction.create({
        fromUser: client.user._id,
        toUser: talent.user._id,
        amount: amountUSD,
        type: 'escrow_deposit',
        status: 'completed',
        description: `${buildTransactionDescription(chat)} — deposit`,
        job: chat.job?._id,
        gig: chat.gig?._id,
        currency: 'USD',
        isOnChain: true,
        txHash: req.body.txHash,
        fromAddress,
        toAddress: talentWallet,
        metadata: {
          amountETH,
          chatId: chat._id.toString(),
          action: 'deposit'
        },
        chat: chat._id,
        direction: 'debit'
      });

      const io = req.app.get('io');
      if (io) {
        io.to(chat._id.toString()).emit('escrow-updated', {
          chatId: chat._id.toString(),
          escrow: chat.escrow,
          workflowStatus: chat.workflowStatus
        });
      }

      const updatedChat = await loadChatForEscrow(chat._id);
      res.json({
        message: `Escrow deposit recorded. Confirmation wallet: ${shortenAddress(fromAddress)}`,
        chat: updatedChat
      });
    } catch (error) {
      console.error('Escrow deposit error:', error);
      console.error('Error stack:', error.stack);
      console.error('Chat ID:', req.params.id);
      console.error('Chat workflow status:', chat?.workflowStatus);
      console.error('Chat escrow:', JSON.stringify(chat?.escrow, null, 2));
      res.status(500).json({
        error: 'Server error',
        details: error?.message || 'Unknown error',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
);

router.post(
  '/:id/escrow/complete',
  [
    auth,
    body('txHash').notEmpty().withMessage('Transaction hash is required'),
    body('fromAddress').notEmpty().withMessage('Talent wallet address is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const chat = await loadChatForEscrow(req.params.id);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      const { client, talent } = getParticipantsByRole(chat);
      if (!client || !talent) {
        return res.status(400).json({ error: 'Escrow requires both client and talent participants' });
      }

      // Log current job status
      console.log('=== Escrow Completion Request ===');
      console.log('Chat ID:', chat._id.toString());
      console.log('Current workflow status:', chat.workflowStatus);
      console.log('Deposit txHash:', chat.escrow?.deposit?.txHash);
      console.log('Completion txHash (if exists):', chat.escrow?.completion?.txHash);
      console.log('Job ID:', chat.job?._id?.toString() || chat.gig?._id?.toString());
      console.log('Stored identifiers:', chat.escrow?.identifiers);
      console.log('Request identifiers:', {
        jobId: req.body.jobId,
        customerId: req.body.customerId,
        talentId: req.body.talentId,
        chatId: req.body.chatId
      });
      console.log('==================================');
      
      // Use stored identifiers if available to ensure consistency
      // This ensures we use the exact same IDs that were used during deposit
      if (chat.escrow?.identifiers) {
        const stored = chat.escrow.identifiers;
        console.log('Using stored identifiers from deposit for completion:', stored);
        
        // Always use stored identifiers to ensure consistency
        req.body.jobId = stored.jobId;
        req.body.customerId = stored.customerId;
        req.body.talentId = stored.talentId;
        req.body.chatId = stored.chatId;
      } else {
        // No stored identifiers - this is a legacy chat or first-time deposit
        // Build identifiers from chat data
        const jobOrGigId = chat.job?._id?.toString() || chat.gig?._id?.toString() || chat._id.toString();
        req.body.jobId = req.body.jobId || jobOrGigId;
        req.body.customerId = req.body.customerId || client.user._id.toString();
        req.body.talentId = req.body.talentId || talent.user._id.toString();
        req.body.chatId = req.body.chatId || chat._id.toString();
        
        console.log('No stored identifiers found. Using identifiers from request or chat data:', {
          jobId: req.body.jobId,
          customerId: req.body.customerId,
          talentId: req.body.talentId,
          chatId: req.body.chatId
        });
      }

      if (talent.user._id.toString() !== req.user.id) {
        return res.status(403).json({ error: 'Only the talent can mark work as completed' });
      }

      if (!chat.escrow?.deposit?.txHash) {
        return res.status(400).json({ error: 'Deposit must be recorded before completion' });
      }

      if (chat.workflowStatus !== 'deposit' && chat.workflowStatus !== 'in-progress') {
        return res.status(400).json({ error: `Cannot complete when workflow status is "${chat.workflowStatus}"` });
      }

      chat.escrow = chat.escrow || {};
      chat.escrow.completion = {
        txHash: req.body.txHash,
        fromAddress: toLowerAddress(req.body.fromAddress),
        performedBy: req.user.id,
        occurredAt: new Date()
      };

      chat.workflowStatus = 'completed';
      chat.markModified('escrow');
      await chat.save();

      await Transaction.create({
        fromUser: talent.user._id,
        toUser: client.user._id,
        amount: 0,
        type: 'escrow_completion',
        status: 'completed',
        description: `${buildTransactionDescription(chat)} — completion milestone`,
        job: chat.job?._id,
        gig: chat.gig?._id,
        currency: 'USD',
        isOnChain: true,
        txHash: req.body.txHash,
        fromAddress: toLowerAddress(req.body.fromAddress),
        metadata: {
          chatId: chat._id.toString(),
          action: 'completed'
        },
        chat: chat._id,
        direction: 'credit'
      });

      const io = req.app.get('io');
      if (io) {
        io.to(chat._id.toString()).emit('escrow-updated', {
          chatId: chat._id.toString(),
          escrow: chat.escrow,
          workflowStatus: chat.workflowStatus
        });
      }

      const updatedChat = await loadChatForEscrow(chat._id);
      res.json({
        message: 'Work completion recorded. Awaiting client confirmation.',
        chat: updatedChat
      });
    } catch (error) {
      console.error('Escrow completion error:', error);
      console.error('Error stack:', error.stack);
      console.error('Chat ID:', req.params.id);
      console.error('Chat workflow status:', chat?.workflowStatus);
      console.error('Chat escrow:', JSON.stringify(chat?.escrow, null, 2));
      res.status(500).json({
        error: 'Server error',
        details: error?.message || 'Unknown error',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
);

router.post(
  '/:id/escrow/confirm',
  [
    auth,
    body('txHash').notEmpty().withMessage('Transaction hash is required'),
    body('fromAddress').notEmpty().withMessage('Confirmation wallet is required'),
    // Amounts are optional - backend will use deposit amounts if not provided
    body('amountUSD').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('USD amount must be >= 0'),
    body('amountETH').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('ETH amount must be >= 0'),
    // Talent wallet is optional - backend will resolve it from completion or deposit
    // Don't validate if it's null/undefined/empty - just skip it completely
    body('talentWallet').optional({ nullable: true, checkFalsy: true }).custom((value) => {
      // If value is falsy (null, undefined, empty), it's valid (optional)
      if (!value || value === 'null' || value === '') return true;
      // If value is provided, it must be a non-empty string
      if (typeof value === 'string' && value.trim().length > 0) return true;
      // Otherwise, it's invalid
      return false;
    }).withMessage('Talent wallet must be a valid wallet address if provided')
  ],
  async (req, res) => {
    try {
      // Log request body for debugging
      console.log('=== Escrow Confirmation Request ===');
      console.log('Request body:', JSON.stringify(req.body, null, 2));
      
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error('Validation errors:', errors.array());
        console.error('Request body:', JSON.stringify(req.body, null, 2));
        console.error('Request body keys:', Object.keys(req.body || {}));
        console.error('Request body values:', Object.values(req.body || {}));
        
        // Log each error with full details
        const errorDetails = errors.array().map((err, index) => {
          const errorInfo = {
            index,
            param: err.param || 'unknown',
            msg: err.msg || 'Invalid value',
            value: err.value,
            location: err.location || 'body'
          };
          console.error(`Validation error ${index + 1}:`, errorInfo);
          return errorInfo;
        });
        
        return res.status(400).json({ 
          errors: errors.array(),
          message: 'Validation failed',
          details: errorDetails.map(e => `${e.param}: ${e.msg}`).join(', '),
          requestBody: req.body
        });
      }
      
      const chat = await loadChatForEscrow(req.params.id);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      const { client, talent } = getParticipantsByRole(chat);
      if (!client || !talent) {
        return res.status(400).json({ error: 'Escrow requires both client and talent participants' });
      }

      // Log current job status
      console.log('Chat ID:', chat._id.toString());
      console.log('Current workflow status:', chat.workflowStatus);
      console.log('Deposit txHash:', chat.escrow?.deposit?.txHash);
      console.log('Completion txHash:', chat.escrow?.completion?.txHash);
      console.log('Confirmation txHash (if exists):', chat.escrow?.confirmation?.txHash);
      console.log('Job ID:', chat.job?._id?.toString() || chat.gig?._id?.toString());
      console.log('Stored identifiers:', chat.escrow?.identifiers);
      console.log('Request identifiers:', {
        jobId: req.body.jobId,
        customerId: req.body.customerId,
        talentId: req.body.talentId,
        chatId: req.body.chatId
      });
      console.log('====================================');
      
      // Verify identifiers match if they were stored during deposit
      // Use stored identifiers to ensure consistency across deposit, completion, and confirmation
      if (chat.escrow?.identifiers) {
        const stored = chat.escrow.identifiers;
        const requested = {
          jobId: req.body.jobId || (chat.job?._id?.toString() || chat.gig?._id?.toString() || chat._id.toString()),
          customerId: req.body.customerId || client.user._id.toString(),
          talentId: req.body.talentId || talent.user._id.toString(),
          chatId: req.body.chatId || chat._id.toString()
        };
        
        // Check if identifiers match (case-sensitive string comparison)
        const mismatches = [];
        if (stored.jobId && requested.jobId && stored.jobId !== requested.jobId) {
          mismatches.push(`jobId: stored="${stored.jobId}", requested="${requested.jobId}"`);
        }
        if (stored.customerId && requested.customerId && stored.customerId !== requested.customerId) {
          mismatches.push(`customerId: stored="${stored.customerId}", requested="${requested.customerId}"`);
        }
        if (stored.talentId && requested.talentId && stored.talentId !== requested.talentId) {
          mismatches.push(`talentId: stored="${stored.talentId}", requested="${requested.talentId}"`);
        }
        
        if (mismatches.length > 0) {
          console.error('Identifier mismatch detected:', mismatches);
          console.error('This will cause the smart contract to reject the confirmation transaction.');
          console.error('Using stored identifiers from deposit to ensure consistency.');
          
          // Override request body with stored identifiers to ensure consistency
          // This ensures we use the exact same IDs that were used during deposit
          req.body.jobId = stored.jobId;
          req.body.customerId = stored.customerId;
          req.body.talentId = stored.talentId;
          req.body.chatId = stored.chatId;
          
          console.log('Using stored identifiers for confirmation:', {
            jobId: req.body.jobId,
            customerId: req.body.customerId,
            talentId: req.body.talentId,
            chatId: req.body.chatId
          });
        } else {
          console.log('Identifiers match. Proceeding with confirmation.');
          // Ensure we use the stored identifiers even if they match
          // This ensures consistency
          req.body.jobId = stored.jobId;
          req.body.customerId = stored.customerId;
          req.body.talentId = stored.talentId;
          req.body.chatId = stored.chatId;
        }
      } else {
        // No stored identifiers - this is a legacy chat or first-time deposit
        // Build identifiers from chat data
        const jobOrGigId = chat.job?._id?.toString() || chat.gig?._id?.toString() || chat._id.toString();
        req.body.jobId = req.body.jobId || jobOrGigId;
        req.body.customerId = req.body.customerId || client.user._id.toString();
        req.body.talentId = req.body.talentId || talent.user._id.toString();
        req.body.chatId = req.body.chatId || chat._id.toString();
        
        console.log('No stored identifiers found. Using identifiers from request or chat data:', {
          jobId: req.body.jobId,
          customerId: req.body.customerId,
          talentId: req.body.talentId,
          chatId: req.body.chatId
        });
      }

      if (client.user._id.toString() !== req.user.id) {
        return res.status(403).json({ error: 'Only the client can confirm delivery' });
      }

      if (!chat.escrow?.deposit?.txHash) {
        return res.status(400).json({ error: 'Deposit must be recorded before confirmation' });
      }

      if (!chat.escrow?.completion?.txHash) {
        return res.status(400).json({ 
          error: 'Completion must be recorded before confirmation',
          details: 'The talent must complete the work before the client can confirm.'
        });
      }

      // Allow confirmation if:
      // 1. Workflow status is 'completed' (normal flow)
      // 2. Confirmation already exists (idempotent) 
      // 3. We have a valid txHash (sync case - contract already confirmed or state mismatch)
      // Always allow if we have a valid txHash, even if workflowStatus is not 'completed'
      // This handles the case where the contract state is ahead of the backend
      // Also allow if we have completion txHash (talent completed, but status not updated)
      if (chat.workflowStatus !== 'completed' && !chat.escrow?.confirmation?.txHash) {
        if (req.body.txHash && chat.escrow?.completion?.txHash) {
          // We have a valid txHash and completion was recorded - allow sync
          console.warn(`Workflow status is "${chat.workflowStatus}" but allowing confirmation with txHash ${req.body.txHash} to sync backend state`);
          console.warn('Completion txHash exists:', chat.escrow.completion.txHash);
          // We'll proceed to sync the backend state with the provided txHash
        } else if (req.body.txHash) {
          // We have a txHash but no completion - this is unusual but allow it
          console.warn(`Workflow status is "${chat.workflowStatus}" and no completion txHash, but allowing confirmation with txHash ${req.body.txHash}`);
          // We'll proceed to sync the backend state
        } else {
          return res.status(400).json({ 
            error: `Cannot confirm when workflow status is "${chat.workflowStatus}". Expected: "completed"`,
            details: `Current workflow status: ${chat.workflowStatus}. The workflow must be in "completed" state before confirmation, or provide a valid transaction hash to sync the state.`
          });
        }
      }

      // If confirmation already exists, check if it's the same transaction
      if (chat.escrow?.confirmation?.txHash) {
        if (chat.escrow.confirmation.txHash === req.body.txHash) {
          // Same transaction, return success
          const updatedChat = await loadChatForEscrow(chat._id);
          return res.json({
            message: 'Confirmation already recorded',
            chat: updatedChat
          });
        } else {
          return res.status(400).json({ 
            error: 'Confirmation already exists for this chat',
            details: `A different confirmation transaction (${shortenAddress(chat.escrow.confirmation.txHash)}) already exists.`
          });
        }
      }

      const depositWallet = toLowerAddress(chat.escrow.deposit.fromAddress);
      const confirmationWallet = toLowerAddress(req.body.fromAddress);
      if (depositWallet !== confirmationWallet) {
        return res.status(400).json({
          error: 'Wallet mismatch',
          details: `Please confirm using the same wallet used for deposit (${shortenAddress(depositWallet)})`
        });
      }

      // Get amounts from request or fallback to deposit amounts
      // Amounts are optional - we can use deposit amounts if not provided
      let amountUSD = null;
      let amountETH = null;
      
      // Get USD amount from request or deposit
      if (req.body.amountUSD !== undefined && req.body.amountUSD !== null && req.body.amountUSD !== '') {
        const parsedUSD = Number(req.body.amountUSD);
        if (!isNaN(parsedUSD) && parsedUSD > 0) {
          amountUSD = parsedUSD;
        }
      }
      if (!amountUSD && chat.escrow?.deposit?.amountUSD) {
        amountUSD = Number(chat.escrow.deposit.amountUSD);
      }
      
      // Get ETH amount from request or deposit
      if (req.body.amountETH !== undefined && req.body.amountETH !== null && req.body.amountETH !== '') {
        const parsedETH = Number(req.body.amountETH);
        if (!isNaN(parsedETH) && parsedETH > 0) {
          amountETH = parsedETH;
        }
      }
      if (!amountETH && chat.escrow?.deposit?.amountETH) {
        amountETH = Number(chat.escrow.deposit.amountETH);
      }
      
      // Default to 0 if no amounts found (shouldn't happen, but handle gracefully)
      amountUSD = amountUSD || 0;
      amountETH = amountETH || 0;
      
      console.log('Final amounts - USD:', amountUSD, 'ETH:', amountETH);
      
      // Resolve talent wallet - prioritize from request, then deposit, then completion, then talent user
      // This is critical for the smart contract to know where to send the payment
      let talentWallet = null;
      
      // Try request body first
      if (req.body.talentWallet && 
          req.body.talentWallet !== 'null' && 
          req.body.talentWallet !== null && 
          req.body.talentWallet !== '' &&
          typeof req.body.talentWallet === 'string') {
        talentWallet = toLowerAddress(req.body.talentWallet);
        console.log('Using talentWallet from request:', talentWallet);
      } 
      // Try deposit toAddress (set during completion)
      else if (chat.escrow?.deposit?.toAddress) {
        talentWallet = toLowerAddress(chat.escrow.deposit.toAddress);
        console.log('Using talentWallet from deposit:', talentWallet);
      } 
      // Try completion fromAddress (talent's wallet from completion transaction)
      else if (chat.escrow?.completion?.fromAddress) {
        talentWallet = toLowerAddress(chat.escrow.completion.fromAddress);
        console.log('Using talentWallet from completion:', talentWallet);
      } 
      // Try talent user's wallet address
      else if (talent?.user?.walletAddress) {
        talentWallet = toLowerAddress(talent.user.walletAddress);
        console.log('Using talentWallet from user profile:', talentWallet);
      }
      
      if (!talentWallet) {
        console.warn('WARNING: Could not resolve talent wallet. This might cause issues.');
      }
      
      console.log('Final resolved talent wallet:', talentWallet);

      chat.escrow = chat.escrow || {};
      // Update deposit toAddress if it's missing and we have talentWallet
      if (chat.escrow.deposit && !chat.escrow.deposit.toAddress && talentWallet) {
        chat.escrow.deposit.toAddress = talentWallet;
      }
      // Update completion toAddress if it's missing and we have talentWallet
      if (chat.escrow.completion && !chat.escrow.completion.toAddress && talentWallet) {
        chat.escrow.completion.toAddress = talentWallet;
      }
      
      // Record confirmation
      chat.escrow.confirmation = {
        txHash: req.body.txHash,
        fromAddress: confirmationWallet,
        toAddress: talentWallet || undefined,
        performedBy: req.user.id,
        occurredAt: new Date()
      };
      
      // Ensure deposit has talent wallet if we resolved it
      if (talentWallet && chat.escrow.deposit && !chat.escrow.deposit.toAddress) {
        chat.escrow.deposit.toAddress = talentWallet;
        console.log('Updated deposit.toAddress with talent wallet:', talentWallet);
      }
      
      // Ensure completion has talent wallet if we resolved it
      if (talentWallet && chat.escrow.completion && !chat.escrow.completion.toAddress) {
        chat.escrow.completion.toAddress = talentWallet;
        console.log('Updated completion.toAddress with talent wallet:', talentWallet);
      }
      
      console.log('Recording confirmation:', {
        txHash: req.body.txHash,
        fromAddress: confirmationWallet,
        toAddress: talentWallet,
        amountUSD,
        amountETH
      });

      chat.workflowStatus = 'confirmed';
      chat.status = 'completed';
      chat.markModified('escrow');
      await chat.save();

      const [clientUser, talentUser] = await Promise.all([
        User.findById(client.user._id),
        User.findById(talent.user._id)
      ]);

      if (clientUser) {
        clientUser.stats = clientUser.stats || {};
        clientUser.stats.activityPoints = (clientUser.stats.activityPoints || 0) + 10;
        // Increment jobsCompleted for both jobs and gigs (treating gigs as jobs for completion tracking)
        if (chat.type === 'job' || chat.type === 'gig') {
          clientUser.stats.jobsCompleted = (clientUser.stats.jobsCompleted || 0) + 1;
        }
        await clientUser.save();
      }

      if (talentUser) {
        talentUser.stats = talentUser.stats || {};
        talentUser.stats.activityPoints = (talentUser.stats.activityPoints || 0) + 10;
        // Increment jobsCompleted for both jobs and gigs (treating gigs as jobs for completion tracking)
        if (chat.type === 'job' || chat.type === 'gig') {
          talentUser.stats.jobsCompleted = (talentUser.stats.jobsCompleted || 0) + 1;
        }
        await talentUser.save();

        // Approve pending referrals for the talent user when they complete their first job/gig
        await approvePendingReferrals(talentUser._id);
      }

      if (chat.job) {
        await Job.findByIdAndUpdate(chat.job._id, { status: 'completed' });
      }

      if (chat.gig) {
        await Gig.findByIdAndUpdate(chat.gig._id, { status: 'completed' });
      }

      // Create transaction record
      try {
        await Transaction.create({
          fromUser: client.user._id,
          toUser: talent.user._id,
          amount: amountUSD,
          type: 'escrow_confirm',
          status: 'completed',
          description: `${buildTransactionDescription(chat)} — confirmation and release`,
          job: chat.job?._id,
          gig: chat.gig?._id,
          currency: 'USD',
          isOnChain: true,
          txHash: req.body.txHash,
          fromAddress: confirmationWallet,
          toAddress: talentWallet || undefined,
          metadata: {
            amountETH,
            chatId: chat._id.toString(),
            action: 'confirm'
          },
          chat: chat._id,
          direction: 'debit'
        });
        console.log('Transaction record created successfully');
      } catch (txError) {
        console.error('Error creating transaction record:', txError);
        // Don't fail the entire request if transaction record creation fails
        // The confirmation is already recorded in the chat
      }

      const io = req.app.get('io');
      if (io) {
        io.to(chat._id.toString()).emit('escrow-updated', {
          chatId: chat._id.toString(),
          escrow: chat.escrow,
          workflowStatus: chat.workflowStatus
        });
      }

      const updatedChat = await loadChatForEscrow(chat._id);
      res.json({
        message: 'Escrow confirmed and released successfully',
        chat: updatedChat
      });
    } catch (error) {
      console.error('Escrow confirmation error:', error);
      console.error('Error stack:', error.stack);
      console.error('Chat ID:', req.params.id);
      console.error('Chat workflow status:', chat?.workflowStatus);
      console.error('Chat escrow:', JSON.stringify(chat?.escrow, null, 2));
      res.status(500).json({
        error: 'Server error',
        details: error?.message || 'Unknown error',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
);

// @route   PUT /api/chats/:id/price
// @desc    Update chat price (only before deposit)
// @access  Private
router.put('/:id/price', [
  auth,
  body('price').isNumeric().withMessage('Price must be a number'),
  body('reason').optional().isString().withMessage('Reason must be a string')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const chat = await Chat.findById(req.params.id)
      .populate('participants.user', 'role');
    
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Check if user is a participant
    const participant = chat.participants.find(p => p.user._id.toString() === req.user.id);
    if (!participant) {
      return res.status(403).json({ error: 'Not authorized to update this chat' });
    }

    // Only allow price updates before deposit
    if (chat.workflowStatus !== 'offered') {
      return res.status(400).json({ error: 'Price can only be updated before deposit' });
    }

    const { price, reason } = req.body;
    const userRole = participant.role;

    // Only client can update job price, talent can update gig price
    if ((userRole === 'client' && chat.type !== 'job') || (userRole === 'talent' && chat.type !== 'gig')) {
      return res.status(403).json({ error: `${userRole} cannot update ${chat.type} price` });
    }

    // Initialize price if not set
    if (!chat.price) {
      chat.price = { original: 0, current: 0, currency: 'USD' };
    }

    const oldPrice = chat.price.current;
    chat.price.current = price;

    // Add to price history
    chat.priceHistory.push({
      amount: price,
      changedBy: req.user.id,
      reason: reason || `${userRole} updated price from $${oldPrice} to $${price}`
    });

    await chat.save();

    // Emit socket event for real-time updates
    const io = req.app.get('io');
    if (io) {
      io.to(req.params.id).emit('price-updated', {
        chatId: req.params.id,
        newPrice: price,
        oldPrice,
        updatedBy: req.user.id,
        reason
      });
    }

    res.json(chat);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/chats/:id/messages
// @desc    Send a message
// @access  Private
router.post('/:id/messages', [
  auth,
  body('content').notEmpty().withMessage('Message content is required'),
  body('type').isIn(['text', 'image', 'file']).withMessage('Invalid message type')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const chat = await Chat.findById(req.params.id);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Check if user is a participant
    const isParticipant = chat.participants.some(p => p.user.toString() === req.user.id);
    if (!isParticipant) {
      return res.status(403).json({ error: 'Not authorized to send messages in this chat' });
    }

    const message = new Message({
      chatId: req.params.id,
      senderId: req.user.id,
      content: req.body.content,
      type: req.body.type,
      attachments: req.body.attachments || []
    });

    await message.save();

    // Update chat's last message timestamp and unread counts
    chat.updatedAt = new Date();
    chat.lastMessage = {
      content: req.body.content,
      sender: req.user.id,
      timestamp: new Date()
    };

    // Increment unread count for all participants except sender
    chat.participants.forEach(participant => {
      if (participant.user.toString() !== req.user.id) {
        const currentCount = chat.unreadCount.get(participant.user.toString()) || 0;
        chat.unreadCount.set(participant.user.toString(), currentCount + 1);
      }
    });

    await chat.save();

    await message.populate('senderId', 'username email profile');

    // Emit socket event for real-time updates
    const io = req.app.get('io');
    if (io) {
      io.to(req.params.id).emit('new-message', {
        id: message._id,
        chatId: req.params.id,
        senderId: message.senderId,
        content: req.body.content,
        type: req.body.type,
        timestamp: message.timestamp
      });
      
      // Emit notification event
      io.emit('new-notification');
      
      console.log(`API: Message broadcasted to chat ${req.params.id}`);
    } else {
      console.log('Socket.IO not available for message broadcasting');
    }

    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/chats/unread-count
// @desc    Get user's unread message count
// @access  Private
router.get('/unread-count', auth, async (req, res) => {
  try {
    console.log('Fetching unread count for user:', req.user.id);
    
    const chats = await Chat.find({
      'participants.user': req.user.id,
      status: 'active'
    });

    let totalUnread = 0;
    for (const chat of chats) {
      // Handle both Map and object formats for unreadCount
      let unreadCount = 0;
      if (chat.unreadCount instanceof Map) {
        unreadCount = chat.unreadCount.get(req.user.id.toString()) || 0;
      } else if (typeof chat.unreadCount === 'object' && chat.unreadCount !== null) {
        unreadCount = chat.unreadCount[req.user.id.toString()] || 0;
      }
      totalUnread += unreadCount;
    }

    console.log('Total unread count:', totalUnread);
    res.json({ unreadCount: totalUnread });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;