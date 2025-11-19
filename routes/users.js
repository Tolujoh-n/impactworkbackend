const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const User = require('../models/User');
const Job = require('../models/Job');
const Gig = require('../models/Gig');
const Rating = require('../models/Rating');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');

const router = express.Router();

const toObjectId = (value) => {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) {
    return value;
  }
  if (typeof value === 'string' || value instanceof String) {
    if (!mongoose.Types.ObjectId.isValid(value)) {
      return null;
    }
    return new mongoose.Types.ObjectId(value);
  }
  if (value._id) {
    return toObjectId(value._id);
  }
  return null;
};

const buildEmptyDistribution = () => ({
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0
});

const calculateRatingMetrics = async (userId) => {
  const targetId = toObjectId(userId);
  if (!targetId) {
    throw new Error('Invalid user identifier supplied for rating metrics calculation');
  }

  const matchFilter = {
    toUser: targetId,
    isVisible: true
  };

  const [ratingSummary] = await Rating.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: null,
        average: { $avg: '$rating' },
        count: { $sum: 1 },
        totalScore: { $sum: '$rating' }
      }
    }
  ]);

  const distributionResults = await Rating.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: '$rating',
        count: { $sum: 1 }
      }
    }
  ]);

  const distribution = buildEmptyDistribution();
  distributionResults.forEach((item) => {
    if (distribution[item._id] !== undefined) {
      distribution[item._id] = item.count;
    }
  });

  const average = ratingSummary?.average || 0;
  const count = ratingSummary?.count || 0;
  const totalScore = ratingSummary?.totalScore || 0;
  const roundedAverage = Number(average.toFixed(2));

  return {
    average: roundedAverage,
    count,
    totalScore,
    distribution
  };
};

const recalculateUserRating = async (userId) => {
  const metrics = await calculateRatingMetrics(userId);

  await User.findByIdAndUpdate(
    userId,
    {
      'stats.rating.average': metrics.average,
      'stats.rating.count': metrics.count,
      'stats.rating.totalScore': metrics.totalScore
    },
    { new: false }
  );

  return metrics;
};

const fetchRatingsForUser = async (userId, options = {}) => {
  const pageNumber = Math.max(1, parseInt(options.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(50, parseInt(options.limit, 10) || 10));

  const targetId = toObjectId(userId);
  if (!targetId) {
    throw new Error('Invalid user identifier supplied for rating query');
  }

  const query = {
    toUser: targetId,
    isVisible: true
  };

  const [ratings, total, metrics] = await Promise.all([
    Rating.find(query)
      .populate('fromUser', 'username profile.firstName profile.lastName profile.avatar')
      .populate('job', 'title')
      .populate('gig', 'title')
      .sort({ createdAt: -1 })
      .limit(pageSize)
      .skip((pageNumber - 1) * pageSize),
    Rating.countDocuments(query),
    calculateRatingMetrics(userId)
  ]);

  return {
    ratings,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    currentPage: pageNumber,
    metrics
  };
};

// @route   GET /api/users/profile/:username
// @desc    Get public user profile
// @access  Public
router.get('/profile/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username })
      .select('-password -wallet -preferences')
      .populate('referral.referredBy', 'username');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/users/profile/:username/ratings
// @desc    Get public ratings for a user profile
// @access  Public
router.get('/profile/:username/ratings', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username }).select('_id');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { page = 1, limit = 10 } = req.query;

    const {
      ratings,
      total,
      totalPages,
      currentPage,
      metrics
    } = await fetchRatingsForUser(user._id, { page, limit });

    res.json({
      ratings,
      total,
      totalPages,
      currentPage,
      ratingDistribution: metrics.distribution,
      rating: {
        average: metrics.average,
        count: metrics.count,
        totalScore: metrics.totalScore
      }
    });
  } catch (error) {
    console.error('Get public ratings error:', error);
    res.status(500).json({
      error: 'Server error',
      details: error.message
    });
  }
});

// @route   GET /api/users/:id
// @desc    Get user by ID (authenticated)
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/users/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', auth, [
  body('profile.firstName').optional().trim(),
  body('profile.lastName').optional().trim(),
  body('profile.bio').optional().trim(),
  body('profile.location').optional().trim(),
  body('profile.phone').optional().trim(),
  body('profile.avatar').optional().trim(),
  body('profile.skills').optional().isArray(),
  body('profile.languages').optional().isArray(),
  body('email').optional().isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update profile fields
    if (req.body.profile) {
      if (req.body.profile.firstName !== undefined) {
        user.profile.firstName = req.body.profile.firstName;
      }
      if (req.body.profile.lastName !== undefined) {
        user.profile.lastName = req.body.profile.lastName;
      }
      if (req.body.profile.bio !== undefined) {
        user.profile.bio = req.body.profile.bio;
      }
      if (req.body.profile.location !== undefined) {
        user.profile.location = req.body.profile.location;
      }
      if (req.body.profile.phone !== undefined) {
        user.profile.phone = req.body.profile.phone;
      }
      if (req.body.profile.avatar !== undefined) {
        user.profile.avatar = req.body.profile.avatar;
      }
      if (req.body.profile.skills !== undefined) {
        user.profile.skills = req.body.profile.skills;
      }
      if (req.body.profile.languages !== undefined) {
        user.profile.languages = req.body.profile.languages;
      }
      if (req.body.profile.socialLinks !== undefined) {
        user.profile.socialLinks = {
          ...user.profile.socialLinks,
          ...req.body.profile.socialLinks
        };
      }
      if (req.body.profile.experience !== undefined) {
        user.profile.experience = req.body.profile.experience;
      }
      if (req.body.profile.portfolio !== undefined) {
        user.profile.portfolio = req.body.profile.portfolio;
      }
    }

    // Update email if provided and user has email (not wallet-only)
    if (req.body.email && user.email) {
      // Check if email is already taken by another user
      const existingUser = await User.findOne({ 
        email: req.body.email,
        _id: { $ne: user._id }
      });
      if (existingUser) {
        return res.status(400).json({ error: 'Email already in use' });
      }
      user.email = req.body.email;
    }

    await user.save();
    
    // Return user without password
    const userResponse = await User.findById(user._id).select('-password');
    res.json(userResponse);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/users/settings
// @desc    Update user settings
// @access  Private
router.put('/settings', auth, [
  body('preferences.theme').optional().isIn(['light', 'dark']),
  body('preferences.notifications').optional().isObject(),
  body('preferences.notifications.email').optional().isBoolean(),
  body('preferences.notifications.push').optional().isBoolean(),
  body('preferences.notifications.chat').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update preferences
    if (req.body.preferences) {
      if (req.body.preferences.theme !== undefined) {
        user.preferences.theme = req.body.preferences.theme;
      }
      if (req.body.preferences.notifications) {
        user.preferences.notifications = {
          ...user.preferences.notifications,
          ...req.body.preferences.notifications
        };
      }
    }

    await user.save();
    res.json(user.preferences);
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/users/password
// @desc    Change user password
// @access  Private
router.put('/password', auth, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user || !user.password) {
      return res.status(400).json({ error: 'Password change not available for wallet-only accounts' });
    }

    const { currentPassword, newPassword } = req.body;

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/users/ratings
// @desc    Get user ratings and reviews
// @access  Private
router.get('/ratings', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const {
      ratings,
      total,
      totalPages,
      currentPage,
      metrics
    } = await fetchRatingsForUser(req.user._id, { page, limit });

    res.json({
      ratings,
      totalPages,
      currentPage,
      total,
      ratingDistribution: metrics.distribution,
      rating: {
        average: metrics.average,
        count: metrics.count,
        totalScore: metrics.totalScore
      }
    });
  } catch (error) {
    console.error('Get ratings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/users/:id/ratings
// @desc    Create or update a rating for a user
// @access  Private
router.post(
  '/:id/ratings',
  auth,
  [
    body('rating')
      .isInt({ min: 1, max: 5 })
      .withMessage('Rating must be between 1 and 5'),
    body('comment')
      .optional()
      .isString()
      .isLength({ max: 2000 })
      .withMessage('Comment must be a string up to 2000 characters'),
    body('categories').optional().isObject(),
    body('categories.communication')
      .optional()
      .isInt({ min: 1, max: 5 })
      .withMessage('Communication rating must be between 1 and 5'),
    body('categories.quality')
      .optional()
      .isInt({ min: 1, max: 5 })
      .withMessage('Quality rating must be between 1 and 5'),
    body('categories.timeliness')
      .optional()
      .isInt({ min: 1, max: 5 })
      .withMessage('Timeliness rating must be between 1 and 5'),
    body('categories.professionalism')
      .optional()
      .isInt({ min: 1, max: 5 })
      .withMessage('Professionalism rating must be between 1 and 5'),
    body('chatId').optional().isMongoId(),
    body('jobId').optional().isMongoId(),
    body('gigId').optional().isMongoId(),
    body('type')
      .optional()
      .isIn(['job', 'gig', 'profile'])
      .withMessage('Invalid rating type')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const targetUser = await User.findById(req.params.id).select('_id username');

      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (targetUser._id.toString() === req.user._id.toString()) {
        return res.status(400).json({ error: 'You cannot rate yourself' });
      }

      const {
        rating,
        comment,
        categories = {},
        chatId,
        jobId,
        gigId,
        type
      } = req.body;

      let ratingDoc = await Rating.findOne({
        fromUser: req.user._id,
        toUser: targetUser._id
      });

      const isNew = !ratingDoc;

      if (!ratingDoc) {
        ratingDoc = new Rating({
          fromUser: req.user._id,
          toUser: targetUser._id
        });
      }

      ratingDoc.rating = rating;
      ratingDoc.comment = comment;
      ratingDoc.type = type || ratingDoc.type || 'profile';
      ratingDoc.isVisible = true;

      const existingCategories =
        (typeof ratingDoc.categories?.toObject === 'function'
          ? ratingDoc.categories.toObject()
          : ratingDoc.categories) || {};

      const updatedCategories = {
        ...existingCategories
      };

      ['communication', 'quality', 'timeliness', 'professionalism'].forEach((key) => {
        if (categories[key] !== undefined) {
          updatedCategories[key] = categories[key];
        }
      });

      Object.keys(updatedCategories).forEach((key) => {
        if (updatedCategories[key] === undefined) {
          delete updatedCategories[key];
        }
      });

      if (Object.keys(updatedCategories).length > 0) {
        ratingDoc.set('categories', updatedCategories);
      } else {
        ratingDoc.set('categories', undefined);
      }

      ratingDoc.chat = chatId || ratingDoc.chat;
      ratingDoc.job = jobId || ratingDoc.job;
      ratingDoc.gig = gigId || ratingDoc.gig;

      await ratingDoc.save();

      await ratingDoc.populate([
        { path: 'fromUser', select: 'username profile.firstName profile.lastName profile.avatar' },
        { path: 'job', select: 'title' },
        { path: 'gig', select: 'title' }
      ]);

      const metrics = await recalculateUserRating(targetUser._id);

      res.status(isNew ? 201 : 200).json({
        message: isNew ? 'Rating created successfully' : 'Rating updated successfully',
        rating: ratingDoc,
        ratingSummary: {
          average: metrics.average,
          count: metrics.count,
          totalScore: metrics.totalScore,
          distribution: metrics.distribution
        }
      });
    } catch (error) {
      if (error?.code === 11000 || error?.code === '11000') {
        return res.status(409).json({ error: 'You have already rated this user' });
      }
      console.error('Create rating error:', error);
      const status =
        error.name === 'CastError'
          ? 400
          : 500;
      res.status(status).json({
        error: 'Server error',
        details: error.message
      });
    }
  }
);

// @route   GET /api/users/dashboard/stats
// @desc    Get user dashboard statistics
// @access  Private
router.get('/dashboard/stats', auth, async (req, res) => {
  try {
    // Populate user with referral data and profile for skills
    const user = await User.findById(req.user._id)
      .select('stats wallet referral profile role')
      .populate('referral.referredBy', 'username')
      .populate('referral.referrals', 'username stats');
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = user._id;
    const userObjectId = new mongoose.Types.ObjectId(userId);
    const isClient = user.role === 'client';
    const isTalent = user.role === 'talent';

    const normalizeStatusSummary = (entries, allowedStatuses) => {
      const summary = allowedStatuses.reduce((acc, status) => {
        acc[status] = 0;
        return acc;
      }, {});

      entries.forEach((entry) => {
        if (summary.hasOwnProperty(entry._id)) {
          summary[entry._id] = entry.count;
        }
      });

      return summary;
    };

    let jobStatusSummary = { open: 0, 'in-progress': 0, completed: 0 };
    if (isClient) {
      const jobAggregation = await Job.aggregate([
        { $match: { client: userObjectId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      jobStatusSummary = normalizeStatusSummary(jobAggregation, ['open', 'in-progress', 'completed', 'cancelled']);
    } else {
      const jobAggregation = await Job.aggregate([
        {
          $match: {
            applications: {
              $elemMatch: {
                talent: userObjectId,
                status: 'accepted'
              }
            }
          }
        },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      jobStatusSummary = normalizeStatusSummary(jobAggregation, ['open', 'in-progress', 'completed', 'cancelled']);
    }

    let gigStatusSummary = { active: 0, 'in-progress': 0, completed: 0, pending: 0 };
    if (isTalent) {
      const gigAggregation = await Gig.aggregate([
        { $match: { talent: userObjectId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      gigStatusSummary = normalizeStatusSummary(gigAggregation, ['active', 'in-progress', 'completed', 'paused', 'cancelled']);
    } else {
      const gigOrdersAggregation = await Gig.aggregate([
        { $unwind: '$orders' },
        { $match: { 'orders.client': userObjectId } },
        { $group: { _id: '$orders.status', count: { $sum: 1 } } }
      ]);
      gigStatusSummary = normalizeStatusSummary(gigOrdersAggregation, ['pending', 'accepted', 'in-progress', 'completed', 'cancelled']);
    }

    const activeJobs = jobStatusSummary['in-progress'] || jobStatusSummary.open || 0;
    const activeGigs = gigStatusSummary['in-progress'] || gigStatusSummary.active || 0;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const recentTransactions = await Transaction.countDocuments({
      createdAt: { $gte: thirtyDaysAgo },
      $or: [{ fromUser: userObjectId }, { toUser: userObjectId }]
    });

    const earningTypes = ['job_payment', 'gig_payment'];
    const spendingTypes = ['escrow_deposit', 'job_payment', 'gig_payment'];

    const recentEscrowTransactions = await Transaction.find({
      createdAt: { $gte: thirtyDaysAgo },
      status: 'completed',
      $or: [{ fromUser: userObjectId }, { toUser: userObjectId }]
    }).select('fromUser toUser amount type');

    let monthlyEarnings = 0;
    let monthlySpending = 0;

    recentEscrowTransactions.forEach((transaction) => {
      const toUser = transaction.toUser ? transaction.toUser.toString() : null;
      const fromUser = transaction.fromUser ? transaction.fromUser.toString() : null;

      if (toUser === userId.toString() && earningTypes.includes(transaction.type)) {
        monthlyEarnings += transaction.amount;
      }

      if (fromUser === userId.toString() && spendingTypes.includes(transaction.type)) {
        monthlySpending += transaction.amount;
      }
    });

    const ratingMetrics = await calculateRatingMetrics(userId);

    const statsSnapshot =
      typeof user.stats?.toObject === 'function'
        ? user.stats.toObject()
        : { ...(user.stats || {}) };

    statsSnapshot.rating = {
      average: ratingMetrics.average,
      count: ratingMetrics.count,
      totalScore: ratingMetrics.totalScore
    };

    const skillsCount = Array.isArray(user.profile?.skills)
      ? user.profile.skills.length
      : 0;
    const completedProjects = statsSnapshot.jobsCompleted || 0;

    let skillsAssessment = 'Developing';
    if (skillsCount >= 8 && completedProjects >= 10) {
      skillsAssessment = 'Expert';
    } else if (skillsCount >= 5 && completedProjects >= 5) {
      skillsAssessment = 'Proficient';
    } else if (skillsCount >= 3 && completedProjects >= 2) {
      skillsAssessment = 'Intermediate';
    }

    // Get referral LOB token stats
    const referralLobTokens = user.referral?.lobTokens || {
      pending: 0,
      available: 0,
      withdrawn: 0
    };

    res.json({
      user: {
        stats: statsSnapshot,
        wallet: user.wallet,
        referral: {
          ...user.referral,
          lobTokens: referralLobTokens
        }
      },
      activity: {
        activeJobs,
        activeGigs,
        recentTransactions,
        jobStatusSummary,
        gigStatusSummary
      },
      metrics: {
        activityPoints: statsSnapshot.activityPoints || 0,
        monthlyEarnings,
        monthlySpending,
        skillsAssessment,
        rating: {
          average: ratingMetrics.average,
          count: ratingMetrics.count
        },
        referralLobTokens: {
          pending: referralLobTokens.pending || 0,
          available: referralLobTokens.available || 0,
          withdrawn: referralLobTokens.withdrawn || 0
        }
      }
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/users/switch-role
// @desc    Switch user role between talent and client
// @access  Private
router.post('/switch-role', auth, async (req, res) => {
  try {
    const currentRole = req.user.role;
    const newRole = currentRole === 'talent' ? 'client' : 'talent';

    req.user.role = newRole;
    await req.user.save();

    res.json({
      message: `Role switched to ${newRole}`,
      role: newRole
    });
  } catch (error) {
    console.error('Switch role error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/users/search
// @desc    Search users by skills or username
// @access  Public
router.get('/search', async (req, res) => {
  try {
    const { q: query, page = 1, limit = 20, role } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const filter = {
      isActive: true,
      $or: [
        { username: { $regex: query, $options: 'i' } },
        { 'profile.firstName': { $regex: query, $options: 'i' } },
        { 'profile.lastName': { $regex: query, $options: 'i' } },
        { 'profile.skills': { $regex: query, $options: 'i' } }
      ]
    };

    if (role) {
      filter.role = role;
    }

    const users = await User.find(filter)
      .select('username profile.firstName profile.lastName profile.avatar profile.skills stats.rating')
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await User.countDocuments(filter);

    res.json({
      users,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/users/activity
// @desc    Get user activity feed
// @access  Private
router.get('/activity', auth, async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 20 } = req.query;

    // Get recent transactions
    const transactions = await Transaction.find({
      $or: [{ fromUser: userId }, { toUser: userId }]
    })
      .populate('fromUser', 'username profile.firstName profile.lastName profile.avatar')
      .populate('toUser', 'username profile.firstName profile.lastName profile.avatar')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Get recent jobs/gigs completed
    let recentJobs = [];
    let recentGigs = [];

    if (req.user.role === 'talent') {
      recentJobs = await Job.find({
        'applications.talent': userId,
        'applications.status': 'accepted',
        status: 'completed'
      })
        .populate('client', 'username profile.firstName profile.lastName profile.avatar')
        .sort({ updatedAt: -1 })
        .limit(5);

      recentGigs = await Gig.find({
        talent: userId,
        status: 'completed'
      })
        .populate('orders.client', 'username profile.firstName profile.lastName profile.avatar')
        .sort({ updatedAt: -1 })
        .limit(5);
    } else {
      recentJobs = await Job.find({
        client: userId,
        status: 'completed'
      })
        .populate('applications.talent', 'username profile.firstName profile.lastName profile.avatar')
        .sort({ updatedAt: -1 })
        .limit(5);

      recentGigs = await Gig.find({
        'orders.client': userId,
        'orders.status': 'completed'
      })
        .populate('talent', 'username profile.firstName profile.lastName profile.avatar')
        .sort({ updatedAt: -1 })
        .limit(5);
    }

    const total = await Transaction.countDocuments({
      $or: [{ fromUser: userId }, { toUser: userId }]
    });

    res.json({
      transactions,
      recentJobs,
      recentGigs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error('Get activity error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/users/stats
// @desc    Get detailed user statistics
// @access  Private
router.get('/stats', auth, async (req, res) => {
  try {
    const userId = req.user._id;

    // Calculate earnings from completed jobs/gigs
    let totalEarned = 0;
    let totalSpent = 0;

    if (req.user.role === 'talent') {
      // Get earnings from completed jobs
      const completedJobs = await Job.find({
        'applications.talent': userId,
        'applications.status': 'accepted',
        status: 'completed'
      }).populate('applications.talent', '_id');

      completedJobs.forEach(job => {
        const application = job.applications.find(app => 
          app.talent.toString() === userId.toString() && app.status === 'accepted'
        );
        if (application) {
          totalEarned += job.budget || 0;
        }
      });

      // Get earnings from completed gig orders
      const completedGigs = await Gig.find({
        talent: userId,
        'orders.status': 'completed'
      });

      completedGigs.forEach(gig => {
        gig.orders.forEach(order => {
          if (order.status === 'completed') {
            totalEarned += gig.price || 0;
          }
        });
      });
    } else {
      // Get spending on completed jobs
      const completedJobs = await Job.find({
        client: userId,
        status: 'completed'
      });

      completedJobs.forEach(job => {
        totalSpent += job.budget || 0;
      });

      // Get spending on completed gig orders
      const completedGigs = await Gig.find({
        'orders.client': userId,
        'orders.status': 'completed'
      });

      completedGigs.forEach(gig => {
        gig.orders.forEach(order => {
          if (order.client.toString() === userId.toString() && order.status === 'completed') {
            totalSpent += gig.price || 0;
          }
        });
      });
    }

    const ratingMetrics = await calculateRatingMetrics(userId);

    const statsSnapshot =
      typeof req.user.stats?.toObject === 'function'
        ? req.user.stats.toObject()
        : { ...(req.user.stats || {}) };

    statsSnapshot.rating = {
      average: ratingMetrics.average,
      count: ratingMetrics.count,
      totalScore: ratingMetrics.totalScore
    };

    res.json({
      stats: statsSnapshot,
      earnings: {
        totalEarned,
        totalSpent,
        netEarnings: totalEarned - totalSpent
      },
      rating: statsSnapshot.rating
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router                    
