const express = require('express');
const { body, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const router = express.Router();

// @route   GET /api/wallet
// @desc    Get user's wallet information
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('wallet username email');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      wallet: {
        balance: user.wallet.balance,
        escrowBalance: user.wallet.escrowBalance,
        totalBalance: user.wallet.balance + user.wallet.escrowBalance,
        currency: 'USD'
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/wallet/balance
// @desc    Get user's wallet balance
// @access  Private
router.get('/balance', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('wallet username email');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      wallet: {
        balance: user.wallet.balance,
        escrowBalance: user.wallet.escrowBalance,
        totalBalance: user.wallet.balance + user.wallet.escrowBalance,
        currency: 'USD'
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/wallet/transactions
// @desc    Get user's transaction history
// @access  Private
router.get('/transactions', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, type, status } = req.query;

    let query = {
      $or: [
        { fromUser: req.user.id },
        { toUser: req.user.id }
      ]
    };

    if (type) {
      query.type = type;
    }

    if (status) {
      query.status = status;
    }

    const transactions = await Transaction.find(query)
      .populate('fromUser', 'username email')
      .populate('toUser', 'username email')
      .populate('job', 'title')
      .populate('gig', 'title')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Transaction.countDocuments(query);

    res.json({
      transactions,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/wallet/deposit
// @desc    Deposit money to wallet
// @access  Private
router.post('/deposit', [
  auth,
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least $1')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { amount, paymentMethod } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update wallet balance
    user.wallet.balance += amount;
    await user.save();

    // Create transaction record
    const transaction = new Transaction({
      fromUser: null, // External payment
      toUser: req.user.id,
      amount,
      type: 'deposit',
      status: 'completed',
      description: `Deposit via ${paymentMethod || 'payment method'}`,
      paymentMethod
    });

    await transaction.save();

    res.json({
      message: 'Deposit successful',
      newBalance: user.wallet.balance,
      transaction
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/wallet/withdraw
// @desc    Withdraw money from wallet
// @access  Private
router.post('/withdraw', [
  auth,
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least $1'),
  body('bankAccount').notEmpty().withMessage('Bank account information is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { amount, bankAccount } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user has sufficient balance
    if (user.wallet.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Update wallet balance
    user.wallet.balance -= amount;
    await user.save();

    // Create transaction record
    const transaction = new Transaction({
      fromUser: req.user.id,
      toUser: null, // External withdrawal
      amount,
      type: 'withdrawal',
      status: 'pending',
      description: `Withdrawal to ${bankAccount}`,
      bankAccount
    });

    await transaction.save();

    res.json({
      message: 'Withdrawal request submitted',
      newBalance: user.wallet.balance,
      transaction
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/wallet/transfer
// @desc    Transfer money to another user
// @access  Private
router.post('/transfer', [
  auth,
  body('toUser').isMongoId().withMessage('Valid recipient ID is required'),
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least $1'),
  body('description').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { toUser, amount, description } = req.body;

    // Check if recipient exists
    const recipient = await User.findById(toUser);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // Check if user is not trying to transfer to themselves
    if (toUser === req.user.id) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }

    const sender = await User.findById(req.user.id);
    if (!sender) {
      return res.status(404).json({ error: 'Sender not found' });
    }

    // Check if sender has sufficient balance
    if (sender.wallet.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Update balances
    sender.wallet.balance -= amount;
    recipient.wallet.balance += amount;

    await sender.save();
    await recipient.save();

    // Create transaction record
    const transaction = new Transaction({
      fromUser: req.user.id,
      toUser,
      amount,
      type: 'transfer',
      status: 'completed',
      description: description || `Transfer to ${recipient.username}`
    });

    await transaction.save();

    res.json({
      message: 'Transfer successful',
      newBalance: sender.wallet.balance,
      transaction
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/wallet/escrow
// @desc    Move money to/from escrow
// @access  Private
router.post('/escrow', [
  auth,
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least $1'),
  body('action').isIn(['deposit', 'release']).withMessage('Action must be deposit or release'),
  body('jobId').optional().isMongoId(),
  body('gigId').optional().isMongoId()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { amount, action, jobId, gigId, description } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (action === 'deposit') {
      // Check if user has sufficient balance
      if (user.wallet.balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // Move money from balance to escrow
      user.wallet.balance -= amount;
      user.wallet.escrowBalance += amount;
    } else if (action === 'release') {
      // Check if user has sufficient escrow balance
      if (user.wallet.escrowBalance < amount) {
        return res.status(400).json({ error: 'Insufficient escrow balance' });
      }

      // Move money from escrow to balance
      user.wallet.escrowBalance -= amount;
      user.wallet.balance += amount;
    }

    await user.save();

    // Create transaction record
    const transaction = new Transaction({
      fromUser: action === 'deposit' ? req.user.id : null,
      toUser: action === 'release' ? req.user.id : null,
      amount,
      type: action === 'deposit' ? 'escrow_deposit' : 'escrow_release',
      status: 'completed',
      description: description || `Escrow ${action}`,
      job: jobId,
      gig: gigId
    });

    await transaction.save();

    res.json({
      message: `Escrow ${action} successful`,
      newBalance: user.wallet.balance,
      newEscrowBalance: user.wallet.escrowBalance,
      transaction
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/wallet/escrow/details
// @desc    Get escrow details from Chats (tracks workflowStatus and price)
//         Includes chats where user is participant and workflowStatus is deposit/in-progress/completed
// @access  Private
router.get('/escrow/details', auth, async (req, res) => {
  try {
    const Chat = require('../models/Chat');

    const userId = req.user.id;

    // Get all chats where user is a participant and workflowStatus indicates escrow is active
    // Escrow is active when: deposit (deposited), in-progress (work ongoing), completed (work done, payment pending)
    const escrowChats = await Chat.find({
      'participants.user': userId,
      workflowStatus: { $in: ['deposit', 'in-progress', 'completed'] },
      'price.current': { $exists: true, $gt: 0 } // Only chats with a price
    })
      .populate('job', '_id title')
      .populate('gig', '_id title')
      .populate('participants.user', 'username role')
      .select('_id type workflowStatus price job gig createdAt updatedAt participants')
      .sort({ updatedAt: -1 });

    // Separate job and gig escrows
    const jobEscrows = [];
    const gigEscrows = [];

    escrowChats.forEach(chat => {
      const amount = chat.price?.current || 0;
      if (amount > 0) {
        // Determine if user is client or talent
        const participant = chat.participants.find(p => 
          p.user._id.toString() === userId.toString() || p.user.toString() === userId.toString()
        );
        const userRole = participant?.role || 'unknown';

        const escrowDetail = {
          chatId: chat._id,
          id: chat.job?._id || chat.gig?._id || chat._id,
          title: chat.job?.title || chat.gig?.title || `Chat ${chat._id.toString().slice(-8)}`,
          amount: amount,
          type: chat.type,
          status: chat.workflowStatus,
          projectType: chat.type,
          depositedAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          currency: chat.price?.currency || 'USD',
          userRole: userRole
        };

        if (chat.type === 'job') {
          escrowDetail.jobId = chat.job?._id;
          jobEscrows.push(escrowDetail);
        } else if (chat.type === 'gig') {
          escrowDetail.gigId = chat.gig?._id;
          gigEscrows.push(escrowDetail);
        }
      }
    });

    // Calculate totals
    const jobEscrow = jobEscrows.reduce((sum, escrow) => sum + escrow.amount, 0);
    const gigEscrow = gigEscrows.reduce((sum, escrow) => sum + escrow.amount, 0);
    const totalEscrow = jobEscrow + gigEscrow;

    // Combine all escrow details
    const escrowDetails = [...jobEscrows, ...gigEscrows];

    res.json({
      totalEscrow,
      escrowDetails,
      jobEscrow,
      gigEscrow,
      count: escrowDetails.length
    });
  } catch (error) {
    console.error('Escrow details error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// @route   POST /api/wallet/transactions/onchain
// @desc    Save on-chain transaction to database
// @access  Private
router.post('/transactions/onchain', [
  auth,
  body('txHash').notEmpty().withMessage('Transaction hash is required'),
  body('amount').isNumeric().withMessage('Amount must be a number'),
  body('type').isIn(['deposit', 'withdrawal', 'transfer', 'swap']).withMessage('Invalid transaction type'),
  body('tokenAddress').optional().isString(),
  body('tokenSymbol').optional().isString(),
  body('fromAddress').optional().isString(),
  body('toAddress').optional().isString(),
  body('blockNumber').optional().isNumeric(),
  body('gasUsed').optional().isNumeric(),
  body('gasPrice').optional().isNumeric(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      txHash,
      amount,
      type,
      tokenAddress,
      tokenSymbol,
      fromAddress,
      toAddress,
      blockNumber,
      gasUsed,
      gasPrice,
      description
    } = req.body;

    // Get user with wallet address and connected wallet address
    const user = await User.findById(req.user.id).select('walletAddress connectedWalletAddress email');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if transaction already exists
    const existingTx = await Transaction.findOne({ txHash });
    if (existingTx) {
      return res.status(400).json({ error: 'Transaction already exists' });
    }

    // Determine which wallet address to use: 
    // For email users, use connectedWalletAddress if available, otherwise walletAddress
    // For wallet users, use walletAddress
    const userWalletAddress = user.email && user.connectedWalletAddress 
      ? user.connectedWalletAddress 
      : user.walletAddress;

    // Determine if this transaction is for the current user
    const isFromUser = userWalletAddress && fromAddress && 
                      userWalletAddress.toLowerCase() === fromAddress.toLowerCase();
    const isToUser = userWalletAddress && toAddress && 
                    userWalletAddress.toLowerCase() === toAddress.toLowerCase();

    // Determine direction
    let direction = 'credit';
    if (isFromUser && !isToUser) {
      direction = 'debit';
    } else if (isToUser && !isFromUser) {
      direction = 'credit';
    }

    // Create transaction record
    const transactionData = {
      fromUser: isFromUser ? req.user.id : null,
      toUser: isToUser ? req.user.id : null,
      amount,
      type,
      status: 'completed',
      description: description || `On-chain ${type}`,
      txHash,
      tokenSymbol: tokenSymbol || 'ETH',
      fromAddress,
      toAddress,
      blockNumber,
      gasUsed,
      isOnChain: true,
      currency: tokenSymbol || 'ETH',
      direction
    };

    // Only include tokenAddress if it's provided (for ERC20 tokens)
    // For native ETH transfers, tokenAddress should be null/undefined
    if (tokenAddress !== null && tokenAddress !== undefined) {
      transactionData.tokenAddress = tokenAddress;
    }

    // Only include gasPrice if it's provided and valid
    if (gasPrice !== null && gasPrice !== undefined && gasPrice !== '0') {
      transactionData.gasPrice = gasPrice;
    }

    console.log('Creating transaction record:', {
      txHash,
      type,
      tokenSymbol: transactionData.tokenSymbol,
      tokenAddress: transactionData.tokenAddress || 'null (native ETH)',
      fromAddress,
      toAddress,
      isFromUser,
      isToUser,
      direction
    });

    const transaction = new Transaction(transactionData);
    await transaction.save();

    res.status(201).json({
      message: 'Transaction saved successfully',
      transaction
    });
  } catch (error) {
    console.error('Save on-chain transaction error:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      return res.status(400).json({ 
        error: 'Validation error', 
        details: error.errors 
      });
    }
    
    // Handle duplicate key error (txHash already exists)
    if (error.code === 11000) {
      return res.status(400).json({ 
        error: 'Transaction already exists',
        txHash: error.keyValue?.txHash 
      });
    }
    
    res.status(500).json({ 
      error: 'Server error',
      message: error.message 
    });
  }
});

// @route   POST /api/wallet/connect
// @desc    Connect wallet address for email-logged users
// @access  Private
router.post('/connect', [
  auth,
  body('walletAddress').notEmpty().withMessage('Wallet address is required'),
  body('walletAddress').isString().withMessage('Wallet address must be a string'),
  body('walletAddress').matches(/^0x[a-fA-F0-9]{40}$/).withMessage('Invalid wallet address format')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { walletAddress } = req.body;
    const normalizedWalletAddress = walletAddress.toLowerCase().trim();

    // Get user
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Only allow this for email-logged users (users with email)
    if (!user.email) {
      return res.status(400).json({ error: 'This endpoint is only for email-logged users' });
    }

    // Check if wallet address is already used by another user
    const existingUser = await User.findOne({ 
      walletAddress: normalizedWalletAddress,
      _id: { $ne: req.user.id }
    });
    
    if (existingUser) {
      return res.status(400).json({ error: 'This wallet address is already connected to another account' });
    }

    // Update connected wallet address
    user.connectedWalletAddress = normalizedWalletAddress;
    await user.save();

    res.json({
      message: 'Wallet connected successfully',
      connectedWalletAddress: user.connectedWalletAddress
    });
  } catch (error) {
    console.error('Connect wallet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/wallet/disconnect
// @desc    Disconnect wallet address for email-logged users
// @access  Private
router.post('/disconnect', auth, async (req, res) => {
  try {
    // Get user
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Only allow this for email-logged users (users with email)
    if (!user.email) {
      return res.status(400).json({ error: 'This endpoint is only for email-logged users' });
    }

    // Remove connected wallet address
    user.connectedWalletAddress = undefined;
    await user.save();

    res.json({
      message: 'Wallet disconnected successfully'
    });
  } catch (error) {
    console.error('Disconnect wallet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;