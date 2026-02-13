const express = require('express');
const { body, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const Referral = require('../models/Referral');

const router = express.Router();

// @route   GET /api/referral
// @desc    Get user's referral information
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('referral.referralCode referral.lobTokens username email');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get referral stats
    const referrals = await Referral.find({ referrer: req.user.id })
      .populate('referredUser', 'username email createdAt stats.activityPoints')
      .sort({ createdAt: -1 });

    // Check and update referral approval status based on activity points (20+ required)
    const MIN_APPROVAL_ACTIVITY_POINTS = 20;
    for (const referral of referrals) {
      if (referral.status === 'pending' && referral.referredUser?.stats?.activityPoints >= MIN_APPROVAL_ACTIVITY_POINTS) {
        referral.status = 'approved';
        referral.approvedAt = new Date();
        // Move from pending to available
        if (user.referral?.lobTokens) {
          user.referral.lobTokens.pending = Math.max(0, (user.referral.lobTokens.pending || 0) - (referral.lobTokens || 100));
          user.referral.lobTokens.available = (user.referral.lobTokens.available || 0) + (referral.lobTokens || 100);
        }
        await referral.save();
      }
    }
    await user.save();

    // Re-fetch to get updated statuses
    const updatedReferrals = await Referral.find({ referrer: req.user.id })
      .populate('referredUser', 'username email createdAt stats.activityPoints')
      .sort({ createdAt: -1 });

    // Calculate LOB token stats
    const lobTokens = user.referral?.lobTokens || {
      pending: 0,
      available: 0,
      withdrawn: 0
    };

    const stats = {
      totalReferrals: updatedReferrals.length,
      pendingReferrals: updatedReferrals.filter(ref => ref.status === 'pending').length,
      approvedReferrals: updatedReferrals.filter(ref => ref.status === 'approved').length,
      totalBonus: updatedReferrals.reduce((sum, ref) => sum + (ref.bonusEarned || 0), 0),
      pendingBonus: updatedReferrals.filter(ref => ref.status === 'pending').reduce((sum, ref) => sum + (ref.bonusEarned || 0), 0),
      approvedBonus: updatedReferrals.filter(ref => ref.status === 'approved').reduce((sum, ref) => sum + (ref.bonusEarned || 0), 0),
      lobTokens: {
        pending: lobTokens.pending || 0,
        available: lobTokens.available || 0,
        withdrawn: lobTokens.withdrawn || 0
      }
    };

    const referralCode = user.referral?.referralCode || '';
    const referralLink = `${process.env.CLIENT_URL || 'http://localhost:3000'}/register?ref=${referralCode}`;

    res.json({
      referralCode,
      referralLink,
      stats,
      referrals: updatedReferrals.map(ref => ({
        _id: ref._id,
        referredUser: ref.referredUser,
        status: ref.status,
        lobTokens: ref.lobTokens || 100,
        activityPoints: ref.activityPoints || 5,
        currentActivityPoints: ref.referredUser?.stats?.activityPoints || 0, // Current activity points of referred user
        bonusEarned: ref.bonusEarned || 10,
        approvedAt: ref.approvedAt,
        createdAt: ref.createdAt
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/referral/withdraw
// @desc    Withdraw available LOB tokens
// @access  Private
router.post('/withdraw', [
  auth,
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const requestedAmount = Number(req.body.amount);
    const availableTokens = user.referral?.lobTokens?.available || 0;

    if (requestedAmount > availableTokens) {
      return res.status(400).json({ 
        error: 'Insufficient available LOB tokens',
        available: availableTokens,
        requested: requestedAmount
      });
    }

    // Update user's LOB tokens
    user.referral.lobTokens.available = availableTokens - requestedAmount;
    user.referral.lobTokens.withdrawn = (user.referral.lobTokens.withdrawn || 0) + requestedAmount;
    await user.save();

    // Update referral status to withdrawn for approved referrals
    // We'll mark the oldest approved referrals as withdrawn
    const approvedReferrals = await Referral.find({
      referrer: req.user.id,
      status: 'approved'
    }).sort({ approvedAt: 1 }); // Oldest first

    let remainingAmount = requestedAmount;
    for (const referral of approvedReferrals) {
      if (remainingAmount <= 0) break;
      
      const referralTokens = referral.lobTokens || 100;
      if (referralTokens <= remainingAmount) {
        referral.status = 'withdrawn';
        referral.withdrawnAt = new Date();
        await referral.save();
        remainingAmount -= referralTokens;
      } else {
        // Partial withdrawal - create a new referral record for the remaining tokens
        // For simplicity, we'll mark it as withdrawn and adjust
        referral.status = 'withdrawn';
        referral.withdrawnAt = new Date();
        await referral.save();
        remainingAmount = 0;
      }
    }

    // Create transaction record
    const Transaction = require('../models/Transaction');
    await Transaction.create({
      fromUser: null,
      toUser: req.user.id,
      amount: requestedAmount,
      type: 'referral',
      status: 'completed',
      description: `Withdrawn ${requestedAmount} LOB tokens from referral rewards`,
      currency: 'LOB',
      direction: 'credit',
      metadata: {
        action: 'withdraw',
        tokens: requestedAmount
      }
    });

    res.json({
      message: 'LOB tokens withdrawn successfully',
      amount: requestedAmount,
      available: user.referral.lobTokens.available,
      withdrawn: user.referral.lobTokens.withdrawn
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/referral/validate/:code
// @desc    Validate referral code
// @access  Public
router.get('/validate/:code', async (req, res) => {
  try {
    const { code } = req.params;

    // Find user by referral code (stored in referral.referralCode)
    const user = await User.findOne({ 'referral.referralCode': code });
    if (!user) {
      return res.status(404).json({ error: 'Invalid referral code' });
    }

    res.json({
      valid: true,
      referrer: {
        username: user.username,
        id: user._id
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/referral/process
// @desc    Process referral when user registers
// @access  Private (Internal use)
router.post('/process', [
  auth,
  body('referralCode').notEmpty().withMessage('Referral code is required'),
  body('referredUserId').isMongoId().withMessage('Valid user ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { referralCode, referredUserId } = req.body;

    // Find referrer by referral code (stored in referral.referralCode)
    const referrer = await User.findOne({ 'referral.referralCode': referralCode });
    if (!referrer) {
      return res.status(404).json({ error: 'Invalid referral code' });
    }

    // Check if user is not referring themselves
    if (referrer._id.toString() === referredUserId) {
      return res.status(400).json({ error: 'Cannot refer yourself' });
    }

    // Check if referral already exists
    const existingReferral = await Referral.findOne({
      referrer: referrer._id,
      referredUser: referredUserId
    });

    if (existingReferral) {
      return res.status(400).json({ error: 'Referral already exists' });
    }

    // Create referral record
    const referral = new Referral({
      referrer: referrer._id,
      referredUser: referredUserId,
      bonusEarned: 10, // USD bonus (legacy)
      lobTokens: 100, // LOB tokens to be awarded on approval
      activityPoints: 5, // Activity points to be awarded on approval
      status: 'pending'
    });

    await referral.save();

    // Update referrer's referral list and pending LOB tokens
    referrer.referral.referrals.push(referredUserId);
    referrer.referral.lobTokens = referrer.referral.lobTokens || {
      pending: 0,
      available: 0,
      withdrawn: 0
    };
    referrer.referral.lobTokens.pending += 100;
    await referrer.save();

    res.json({
      message: 'Referral processed successfully',
      referral
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/referral/leaderboard
// @desc    Get referral leaderboard
// @access  Public
router.get('/leaderboard', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const leaderboard = await Referral.aggregate([
      {
        $group: {
          _id: '$referrer',
          totalReferrals: { $sum: 1 },
          totalBonus: { $sum: '$bonusEarned' }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $unwind: '$user'
      },
      {
        $project: {
          username: '$user.username',
          totalReferrals: 1,
          totalBonus: 1
        }
      },
      {
        $sort: { totalReferrals: -1 }
      },
      {
        $limit: parseInt(limit)
      }
    ]);

    res.json(leaderboard);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;