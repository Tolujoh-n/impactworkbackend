const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Transaction = require('../models/Transaction');

const ALLOWED_DEPLOYER_TYPES = new Set([
  'deployer_set_fee',
  'deployer_add_funds',
  'deployer_withdraw',
  'deployer_check_balance',
  'deployer_verify'
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
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const skip = (page - 1) * limit;

    const filter = {
      fromUser: req.user._id,
      type: { $regex: '^deployer_' }
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

    const transaction = new Transaction({
      fromUser: req.user._id,
      amount,
      type,
      status: 'completed',
      description,
      isOnChain: true,
      txHash,
      direction,
      fromAddress: req.user.walletAddress,
      toAddress: toAddress || metadata?.toAddress,
      metadata: {
        ...metadata,
        contractAddress:
          metadata.contractAddress || process.env.WORKLOB_JOB_CONTRACT_ADDRESS
      }
    });

    await transaction.save();

    res.status(201).json({ transaction });
  } catch (error) {
    console.error('Error logging deployer transaction:', error);
    res.status(500).json({ error: 'Failed to log deployer transaction' });
  }
});

module.exports = router;

