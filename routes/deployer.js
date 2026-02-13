const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const Config = require('../models/Config');

const ALLOWED_DEPLOYER_TYPES = new Set([
  'deployer_set_fee',
  'deployer_add_funds',
  'deployer_withdraw',
  'deployer_check_balance',
  'deployer_verify',
  'staking_pool_fund',
  'staking_pool_add',
  'staking_pool_withdraw',
  'dao_pool_fund_eth',
  'dao_pool_withdraw_eth',
  'dao_pool_fund_lob',
  'dao_pool_withdraw_lob',
  'dao_set_voter_reward'
]);

const getConfiguredDeployerWallet = () => {
  const fallback =
    process.env.DEPLOYER_WALLET_ADDRESS ||
    process.env.PLATFORM_WALLET ||
    process.env.OWNER_WALLET_ADDRESS ||
    '';
  return fallback ? fallback.toLowerCase() : null;
};

const ensureDeployer = (req, res, next) => {
  const configuredWallet = getConfiguredDeployerWallet();

  if (!configuredWallet) {
    return res.status(503).json({
      error:
        'Deployer wallet is not configured on the server. Set DEPLOYER_WALLET_ADDRESS in the backend environment.'
    });
  }

  const userWallet = (req.user?.walletAddress || '').toLowerCase();

  if (!userWallet) {
    return res.status(403).json({
      error: 'User wallet address not available'
    });
  }

  if (userWallet !== configuredWallet) {
    return res.status(403).json({
      error: 'Access denied: wallet does not match configured deployer wallet'
    });
  }

  next();
};

// Fetch deployer transactions
router.get('/transactions', auth, ensureDeployer, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip = (page - 1) * limit;

    const filter = {
      fromUser: req.user._id,
      type: { $in: [
        'deployer_set_fee',
        'deployer_add_funds',
        'deployer_withdraw',
        'deployer_check_balance',
        'deployer_verify',
        'staking_pool_fund',
        'staking_pool_add',
        'staking_pool_withdraw',
        'dao_pool_fund_eth',
        'dao_pool_withdraw_eth',
        'dao_pool_fund_lob',
        'dao_pool_withdraw_lob',
        'dao_set_voter_reward',
        'blog_earnings_config_update'
      ]}
    };

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Transaction.countDocuments(filter)
    ]);

    res.json({
      transactions,
      page,
      pages: Math.ceil(total / limit),
      total
    });
  } catch (error) {
    console.error('Error fetching deployer transactions:', error);
    res.status(500).json({ error: 'Failed to fetch deployer transactions' });
  }
});

// Log a deployer transaction
router.post('/transactions', auth, ensureDeployer, async (req, res) => {
  try {
    const {
      type,
      amount = 0,
      description,
      txHash,
      direction = 'debit',
      metadata = {},
      toAddress
    } = req.body;

    if (!ALLOWED_DEPLOYER_TYPES.has(type)) {
      return res.status(400).json({ error: 'Invalid deployer transaction type' });
    }

    if (!description) {
      return res.status(400).json({ error: 'Description is required' });
    }

    // Validate amount is a number
    const amountNum = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(amountNum)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const transaction = new Transaction({
      fromUser: req.user._id,
      amount: amountNum,
      type,
      status: 'completed',
      description,
      isOnChain: true,
      txHash: txHash || undefined, // Only set if provided
      direction,
      fromAddress: req.user.walletAddress,
      toAddress: toAddress || metadata?.toAddress || undefined,
      metadata: {
        ...metadata,
        contractAddress:
          metadata.contractAddress || process.env.WORKLOB_JOB_CONTRACT_ADDRESS || process.env.WORKLOB_STAKING_CONTRACT_ADDRESS
      }
    });

    await transaction.save();

    res.status(201).json({ transaction });
  } catch (error) {
    console.error('Error logging deployer transaction:', error);
    // Log the full error for debugging
    if (error.name === 'ValidationError') {
      return res.status(400).json({ 
        error: 'Validation error', 
        details: error.message,
        field: Object.keys(error.errors || {})[0]
      });
    }
    res.status(500).json({ 
      error: 'Failed to log deployer transaction',
      message: error.message 
    });
  }
});

// GET /api/deployer/config
// Get all configuration values
router.get('/config', auth, ensureDeployer, async (req, res) => {
  try {
    const configs = await Config.find({
      key: { $in: [
        'activity_points_job_completion',
        'activity_points_voting',
        'min_locked_staking_governance',
        'min_activity_points_governance',
        'voter_reward_amount',
        'settlement_percentage',
        'voting_duration_days',
        'blog_earnings_views_rate',
        'blog_earnings_views_threshold',
        'blog_earnings_impressions_rate',
        'blog_earnings_impressions_threshold'
      ]}
    });

    // Set defaults if not found
    const defaults = {
      activity_points_job_completion: 10,
      activity_points_voting: 5,
      min_locked_staking_governance: 100,
      min_activity_points_governance: 20,
      voter_reward_amount: 0,
      settlement_percentage: 90,
      voting_duration_days: 5,
      blog_earnings_views_rate: 100,
      blog_earnings_views_threshold: 1000,
      blog_earnings_impressions_rate: 100,
      blog_earnings_impressions_threshold: 100
    };

    const configMap = {};
    configs.forEach(config => {
      configMap[config.key] = config.value;
    });

    // Merge with defaults
    const result = {
      activity_points_job_completion: configMap.activity_points_job_completion ?? defaults.activity_points_job_completion,
      activity_points_voting: configMap.activity_points_voting ?? defaults.activity_points_voting,
      min_locked_staking_governance: configMap.min_locked_staking_governance ?? defaults.min_locked_staking_governance,
      min_activity_points_governance: configMap.min_activity_points_governance ?? defaults.min_activity_points_governance,
      voter_reward_amount: configMap.voter_reward_amount ?? defaults.voter_reward_amount,
      settlement_percentage: configMap.settlement_percentage ?? defaults.settlement_percentage,
      voting_duration_days: configMap.voting_duration_days ?? defaults.voting_duration_days,
      blog_earnings_views_rate: configMap.blog_earnings_views_rate ?? defaults.blog_earnings_views_rate,
      blog_earnings_views_threshold: configMap.blog_earnings_views_threshold ?? defaults.blog_earnings_views_threshold,
      blog_earnings_impressions_rate: configMap.blog_earnings_impressions_rate ?? defaults.blog_earnings_impressions_rate,
      blog_earnings_impressions_threshold: configMap.blog_earnings_impressions_threshold ?? defaults.blog_earnings_impressions_threshold
    };

    res.json(result);
  } catch (error) {
    console.error('Error fetching config:', error);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// PUT /api/deployer/config
// Update configuration values
router.put('/config', auth, ensureDeployer, async (req, res) => {
  try {
    const { 
      activity_points_job_completion, 
      activity_points_voting, 
      min_locked_staking_governance, 
      min_activity_points_governance, 
      voter_reward_amount, 
      settlement_percentage, 
      voting_duration_days,
      blog_earnings_views_rate,
      blog_earnings_views_threshold,
      blog_earnings_impressions_rate,
      blog_earnings_impressions_threshold
    } = req.body;

    const updates = [];

    if (activity_points_job_completion !== undefined) {
      if (typeof activity_points_job_completion !== 'number' || activity_points_job_completion < 0) {
        return res.status(400).json({ error: 'Activity points for job completion must be a non-negative number' });
      }
      await Config.setValue(
        'activity_points_job_completion',
        activity_points_job_completion,
        'Activity points awarded after job/gig completion',
        req.user._id
      );
      updates.push('activity_points_job_completion');
    }

    if (activity_points_voting !== undefined) {
      if (typeof activity_points_voting !== 'number' || activity_points_voting < 0) {
        return res.status(400).json({ error: 'Activity points for voting must be a non-negative number' });
      }
      await Config.setValue(
        'activity_points_voting',
        activity_points_voting,
        'Activity points awarded after voting on governance',
        req.user._id
      );
      updates.push('activity_points_voting');
    }

    if (min_locked_staking_governance !== undefined) {
      if (typeof min_locked_staking_governance !== 'number' || min_locked_staking_governance < 0) {
        return res.status(400).json({ error: 'Minimum locked staking must be a non-negative number' });
      }
      await Config.setValue(
        'min_locked_staking_governance',
        min_locked_staking_governance,
        'Minimum LOB tokens required to be locked in staking for governance participation',
        req.user._id
      );
      updates.push('min_locked_staking_governance');
    }

    if (min_activity_points_governance !== undefined) {
      if (typeof min_activity_points_governance !== 'number' || min_activity_points_governance < 0) {
        return res.status(400).json({ error: 'Minimum activity points for governance must be a non-negative number' });
      }
      await Config.setValue(
        'min_activity_points_governance',
        min_activity_points_governance,
        'Minimum activity points required to vote or resolve proposals in governance',
        req.user._id
      );
      updates.push('min_activity_points_governance');
    }

    if (voter_reward_amount !== undefined) {
      if (typeof voter_reward_amount !== 'number' || voter_reward_amount < 0) {
        return res.status(400).json({ error: 'Voter reward amount must be a non-negative number' });
      }
      await Config.setValue(
        'voter_reward_amount',
        voter_reward_amount,
        'Amount of LOB tokens voters earn per vote',
        req.user._id
      );
      updates.push('voter_reward_amount');
    }

    if (settlement_percentage !== undefined) {
      if (typeof settlement_percentage !== 'number' || settlement_percentage < 0 || settlement_percentage > 100) {
        return res.status(400).json({ error: 'Settlement percentage must be a number between 0 and 100' });
      }
      await Config.setValue(
        'settlement_percentage',
        settlement_percentage,
        'Percentage of remaining escrow amount that can be split in settlement (default: 90%)',
        req.user._id
      );
      updates.push('settlement_percentage');
    }

    if (voting_duration_days !== undefined) {
      if (typeof voting_duration_days !== 'number' || voting_duration_days < 1) {
        return res.status(400).json({ error: 'Voting duration days must be a positive number' });
      }
      await Config.setValue(
        'voting_duration_days',
        voting_duration_days,
        'Number of days for governance voting period (default: 5 days)',
        req.user._id
      );
      updates.push('voting_duration_days');
    }

    if (blog_earnings_views_rate !== undefined) {
      if (typeof blog_earnings_views_rate !== 'number' || blog_earnings_views_rate < 0) {
        return res.status(400).json({ error: 'Blog earnings views rate must be a non-negative number' });
      }
      await Config.setValue(
        'blog_earnings_views_rate',
        blog_earnings_views_rate,
        'LOB tokens earned per views threshold',
        req.user._id
      );
      updates.push('blog_earnings_views_rate');
    }

    if (blog_earnings_views_threshold !== undefined) {
      if (typeof blog_earnings_views_threshold !== 'number' || blog_earnings_views_threshold < 1) {
        return res.status(400).json({ error: 'Blog earnings views threshold must be a positive number' });
      }
      await Config.setValue(
        'blog_earnings_views_threshold',
        blog_earnings_views_threshold,
        'Number of views required to earn tokens',
        req.user._id
      );
      updates.push('blog_earnings_views_threshold');
    }

    if (blog_earnings_impressions_rate !== undefined) {
      if (typeof blog_earnings_impressions_rate !== 'number' || blog_earnings_impressions_rate < 0) {
        return res.status(400).json({ error: 'Blog earnings impressions rate must be a non-negative number' });
      }
      await Config.setValue(
        'blog_earnings_impressions_rate',
        blog_earnings_impressions_rate,
        'LOB tokens earned per impressions threshold',
        req.user._id
      );
      updates.push('blog_earnings_impressions_rate');
    }

    if (blog_earnings_impressions_threshold !== undefined) {
      if (typeof blog_earnings_impressions_threshold !== 'number' || blog_earnings_impressions_threshold < 1) {
        return res.status(400).json({ error: 'Blog earnings impressions threshold must be a positive number' });
      }
      await Config.setValue(
        'blog_earnings_impressions_threshold',
        blog_earnings_impressions_threshold,
        'Number of impressions required to earn tokens',
        req.user._id
      );
      updates.push('blog_earnings_impressions_threshold');
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid configuration values provided' });
    }

    // Log transaction
    await Transaction.create({
      fromUser: req.user._id,
      type: 'deployer_set_fee', // Reusing this type for config updates
      status: 'completed',
      description: `Updated configuration: ${updates.join(', ')}`,
      amount: 0
    });

    // Return updated config
    const configs = await Config.find({
      key: { $in: [
        'activity_points_job_completion',
        'activity_points_voting',
        'min_locked_staking_governance',
        'min_activity_points_governance',
        'voter_reward_amount',
        'settlement_percentage',
        'voting_duration_days',
        'blog_earnings_views_rate',
        'blog_earnings_views_threshold',
        'blog_earnings_impressions_rate',
        'blog_earnings_impressions_threshold'
      ]}
    });

    const defaults = {
      activity_points_job_completion: 10,
      activity_points_voting: 5,
      min_locked_staking_governance: 100,
      min_activity_points_governance: 20,
      voter_reward_amount: 0,
      settlement_percentage: 90,
      voting_duration_days: 5,
      blog_earnings_views_rate: 100,
      blog_earnings_views_threshold: 1000,
      blog_earnings_impressions_rate: 100,
      blog_earnings_impressions_threshold: 100
    };

    const configMap = {};
    configs.forEach(config => {
      configMap[config.key] = config.value;
    });

    const result = {
      activity_points_job_completion: configMap.activity_points_job_completion ?? defaults.activity_points_job_completion,
      activity_points_voting: configMap.activity_points_voting ?? defaults.activity_points_voting,
      min_locked_staking_governance: configMap.min_locked_staking_governance ?? defaults.min_locked_staking_governance,
      min_activity_points_governance: configMap.min_activity_points_governance ?? defaults.min_activity_points_governance,
      voter_reward_amount: configMap.voter_reward_amount ?? defaults.voter_reward_amount,
      settlement_percentage: configMap.settlement_percentage ?? defaults.settlement_percentage,
      voting_duration_days: configMap.voting_duration_days ?? defaults.voting_duration_days,
      blog_earnings_views_rate: configMap.blog_earnings_views_rate ?? defaults.blog_earnings_views_rate,
      blog_earnings_views_threshold: configMap.blog_earnings_views_threshold ?? defaults.blog_earnings_views_threshold,
      blog_earnings_impressions_rate: configMap.blog_earnings_impressions_rate ?? defaults.blog_earnings_impressions_rate,
      blog_earnings_impressions_threshold: configMap.blog_earnings_impressions_threshold ?? defaults.blog_earnings_impressions_threshold
    };

    res.json({
      message: 'Configuration updated successfully',
      config: result
    });
  } catch (error) {
    console.error('Error updating config:', error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

module.exports = router;

