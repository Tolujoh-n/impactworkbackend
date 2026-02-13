const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Staking = require('../models/Staking');
const Staker = require('../models/Staker');

// @route   GET /api/staking/pool-info
// @desc    Get staking pool information
// @access  Public
router.get('/pool-info', async (req, res) => {
  try {
    // This will be populated from smart contract
    res.json({
      totalStaked: 0,
      rewardRate: 0,
      apy: 0,
      periodFinish: 0,
      poolBalance: 0
    });
  } catch (error) {
    console.error('Error fetching pool info:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/staking/user-stakes
// @desc    Get user's staking information
// @access  Private
router.get('/user-stakes', auth, async (req, res) => {
  try {
    const walletAddress = req.user.walletAddress?.toLowerCase();
    
    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address not found' });
    }

    // Get or create staker record
    let staker = await Staker.findOne({ walletAddress: walletAddress.toLowerCase() });
    
    if (!staker) {
      staker = new Staker({
        walletAddress: walletAddress.toLowerCase(),
        totalStaked: 0,
        totalLocked: 0,
        claimableRewards: 0
      });
      await staker.save();
    }

    // Get all stakes for this user
    const stakes = await Staking.find({ 
      walletAddress: walletAddress.toLowerCase(),
      isActive: true 
    }).sort({ stakedAt: -1 });

    res.json({
      staker: {
        walletAddress: staker.walletAddress,
        totalStaked: staker.totalStaked,
        totalLocked: staker.totalLocked,
        claimableRewards: staker.claimableRewards
      },
      stakes: stakes
    });
  } catch (error) {
    console.error('Error fetching user stakes:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/staking/all-stakes
// @desc    Get all active stakes (for overview page)
// @access  Public
router.get('/all-stakes', async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const skip = (page - 1) * limit;

    let query = { isActive: true };
    
    if (status === 'locked') {
      query.isLocked = true;
      query.unlockTime = { $gt: new Date() };
    } else if (status === 'unlocked') {
      query.$or = [
        { isLocked: false },
        { unlockTime: { $lte: new Date() } }
      ];
    }

    const stakes = await Staking.find(query)
      .sort({ stakedAt: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .select('walletAddress amount stakedAt unlockTime isLocked stakeId');

    const total = await Staking.countDocuments(query);

    res.json({
      stakes,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching all stakes:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/staking/record-stake
// @desc    Record a new stake (called after successful smart contract transaction)
// @access  Private
router.post('/record-stake', auth, async (req, res) => {
  try {
    const { stakeId, amount, isLocked, lockDays, txHash } = req.body;
    const walletAddress = req.user.walletAddress?.toLowerCase();

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address not found' });
    }

    if (!amount || !txHash) {
      return res.status(400).json({ error: 'Missing required fields: amount and txHash are required' });
    }

    // Convert amount to number if it's a string
    const amountNum = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Generate stakeId if not provided (fallback)
    let finalStakeId = stakeId;
    if (!finalStakeId) {
      // Get the highest stakeId and increment
      const lastStake = await Staking.findOne().sort({ stakeId: -1 });
      finalStakeId = lastStake ? lastStake.stakeId + 1 : 1;
    }

    // Check if stakeId already exists
    const existingStake = await Staking.findOne({ stakeId: finalStakeId });
    if (existingStake) {
      // If it exists and has the same txHash, return success (idempotent)
      if (existingStake.txHash === txHash) {
        return res.json({ success: true, stake: existingStake });
      }
      // Otherwise, generate a new stakeId
      const lastStake = await Staking.findOne().sort({ stakeId: -1 });
      finalStakeId = lastStake ? lastStake.stakeId + 1 : 1;
    }

    const unlockTime = isLocked && lockDays 
      ? new Date(Date.now() + (typeof lockDays === 'number' ? lockDays : parseInt(lockDays)) * 24 * 60 * 60 * 1000)
      : null;

    // Create stake record
    const stake = new Staking({
      stakeId: finalStakeId,
      walletAddress: walletAddress.toLowerCase(),
      amount: amountNum,
      stakedAt: new Date(),
      unlockTime,
      isLocked: isLocked || false,
      isActive: true,
      txHash
    });

    await stake.save();

    // Update or create staker record
    let staker = await Staker.findOne({ walletAddress: walletAddress.toLowerCase() });
    if (!staker) {
      staker = new Staker({
        walletAddress: walletAddress.toLowerCase(),
        totalStaked: 0,
        totalLocked: 0,
        claimableRewards: 0
      });
    }

    staker.totalStaked += amount;
    if (isLocked) {
      staker.totalLocked += amount;
    }
    await staker.save();

    res.json({ success: true, stake });
  } catch (error) {
    console.error('Error recording stake:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/staking/record-unstake
// @desc    Record an unstake (called after successful smart contract transaction)
// @access  Private
router.post('/record-unstake', auth, async (req, res) => {
  try {
    const { stakeId, txHash } = req.body;
    const walletAddress = req.user.walletAddress?.toLowerCase();

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address not found' });
    }

    const stake = await Staking.findOne({ 
      stakeId,
      walletAddress: walletAddress.toLowerCase() 
    });

    if (!stake) {
      return res.status(404).json({ error: 'Stake not found' });
    }

    stake.isActive = false;
    stake.unstakedAt = new Date();
    stake.unstakeTxHash = txHash;
    await stake.save();

    // Update staker record
    const staker = await Staker.findOne({ walletAddress: walletAddress.toLowerCase() });
    if (staker) {
      staker.totalStaked -= stake.amount;
      if (stake.isLocked) {
        staker.totalLocked -= stake.amount;
      }
      await staker.save();
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error recording unstake:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/staking/record-claim
// @desc    Record a reward claim (called after successful smart contract transaction)
// @access  Private
router.post('/record-claim', auth, async (req, res) => {
  try {
    const { amount, txHash, stakeId } = req.body;
    const walletAddress = req.user.walletAddress?.toLowerCase();

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address not found' });
    }

    // Convert amount to number if it's a string
    const amountNum = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Update staker record
    const staker = await Staker.findOne({ walletAddress: walletAddress.toLowerCase() });
    if (staker) {
      staker.claimableRewards = Math.max(0, staker.claimableRewards - amountNum);
      await staker.save();
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error recording claim:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/staking/sync-staker
// @desc    Sync staker data from blockchain
// @access  Private
router.post('/sync-staker', auth, async (req, res) => {
  try {
    const walletAddress = req.user.walletAddress?.toLowerCase();

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address not found' });
    }

    // This will be populated with actual blockchain data
    // For now, return current database state
    const staker = await Staker.findOne({ walletAddress: walletAddress.toLowerCase() });
    
    if (!staker) {
      return res.json({
        walletAddress,
        totalStaked: 0,
        totalLocked: 0,
        claimableRewards: 0
      });
    }

    res.json(staker);
  } catch (error) {
    console.error('Error syncing staker:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/staking/stats
// @desc    Get staking statistics
// @access  Public
router.get('/stats', async (req, res) => {
  try {
    const totalStakers = await Staker.countDocuments({ totalStaked: { $gt: 0 } });
    const totalStaked = await Staker.aggregate([
      { $group: { _id: null, total: { $sum: '$totalStaked' } } }
    ]);
    const totalLocked = await Staker.aggregate([
      { $group: { _id: null, total: { $sum: '$totalLocked' } } }
    ]);

    res.json({
      totalStakers,
      totalStaked: totalStaked[0]?.total || 0,
      totalLocked: totalLocked[0]?.total || 0,
      activeStakes: await Staking.countDocuments({ isActive: true })
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
