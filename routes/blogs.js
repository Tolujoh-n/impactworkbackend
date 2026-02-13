const express = require('express');
const { body, validationResult, query } = require('express-validator');
const mongoose = require('mongoose');
const Blog = require('../models/Blog');
const BlogEarning = require('../models/BlogEarning');
const BlogFollow = require('../models/BlogFollow');
const BlogSave = require('../models/BlogSave');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { auth, tryAuth } = require('../middleware/auth');

const router = express.Router();
const Config = require('../models/Config');

// Constants for cooldowns
const VIEW_COOLDOWN_HOURS = 2;
const IMPRESSION_MIN_SECONDS = 30;
const VIEW_MIN_SECONDS = 3;

// Helper function to get blog earnings config
const getBlogEarningsConfig = async () => {
  const viewsRate = await Config.getValue('blog_earnings_views_rate', 100);
  const viewsThreshold = await Config.getValue('blog_earnings_views_threshold', 1000);
  const impressionsRate = await Config.getValue('blog_earnings_impressions_rate', 100);
  const impressionsThreshold = await Config.getValue('blog_earnings_impressions_threshold', 100);
  
  return {
    viewsRate,
    viewsThreshold,
    impressionsRate,
    impressionsThreshold
  };
};

// Helper function to get client IP
const getClientIP = (req) => {
  return req.ip || 
         req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.connection?.remoteAddress || 
         'unknown';
};

// Helper function to check if view/impression is valid (not within cooldown)
const isValidView = async (blogId, ipAddress, userId) => {
  const cooldownTime = new Date(Date.now() - VIEW_COOLDOWN_HOURS * 60 * 60 * 1000);
  
  const blog = await Blog.findById(blogId);
  if (!blog) return false;

  // Check if this IP/user already viewed within cooldown period
  const recentView = blog.viewTracking.find(track => {
    const isRecent = track.timestamp > cooldownTime;
    const matchesIP = track.ipAddress === ipAddress;
    const matchesUser = userId ? track.userId?.toString() === userId.toString() : false;
    return isRecent && (matchesIP || matchesUser);
  });

  return !recentView;
};

const isValidImpression = async (blogId, ipAddress, userId) => {
  const cooldownTime = new Date(Date.now() - VIEW_COOLDOWN_HOURS * 60 * 60 * 1000);
  
  const blog = await Blog.findById(blogId);
  if (!blog) return false;

  // Check if this IP/user already had impression within cooldown period
  const recentImpression = blog.impressionTracking.find(track => {
    const isRecent = track.timestamp > cooldownTime;
    const matchesIP = track.ipAddress === ipAddress;
    const matchesUser = userId ? track.userId?.toString() === userId.toString() : false;
    return isRecent && (matchesIP || matchesUser);
  });

  return !recentImpression;
};

// @route   POST /api/blogs
// @desc    Create a new blog
// @access  Private
router.post('/', auth, [
  body('title').trim().isLength({ min: 5, max: 200 }).withMessage('Title must be between 5 and 200 characters'),
  body('excerpt').optional().trim().isLength({ max: 300 }),
  body('thumbnail').notEmpty().withMessage('Thumbnail is required'),
  body('category').isIn(['Recruiting', 'News', 'Sport', 'Business', 'Innovation', 'Health', 'Culture', 'Arts', 'Travel', 'Earth', 'Technology', 'Education', 'Entertainment']),
  body('sections').isArray().withMessage('Sections must be an array'),
  body('status').optional().isIn(['draft', 'published'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { title, excerpt, thumbnail, category, tags, sections, status = 'draft', actionButton } = req.body;

    // Generate slug
    let slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    
    // Ensure unique slug
    let slugExists = await Blog.findOne({ slug });
    let counter = 1;
    while (slugExists) {
      slug = `${slug}-${counter}`;
      slugExists = await Blog.findOne({ slug });
      counter++;
    }

    const blog = new Blog({
      title,
      slug,
      excerpt,
      thumbnail,
      author: req.user.id,
      category,
      tags: tags || [],
      sections: sections || [],
      status,
      publishedAt: status === 'published' ? new Date() : undefined,
      actionButton: actionButton || {}
    });

    await blog.save();
    await blog.populate('author', 'username profile.firstName profile.lastName profile.avatar');

    res.status(201).json(blog);
  } catch (error) {
    console.error('Error creating blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/blogs
// @desc    Get all blogs with filters
// @access  Public
router.get('/', tryAuth, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('category').optional().isIn(['Recruiting', 'News', 'Sport', 'Business', 'Innovation', 'Health', 'Culture', 'Arts', 'Travel', 'Earth', 'Technology', 'Education', 'Entertainment']),
  query('filter').optional().isIn(['home', 'trending', 'featured', 'sponsored']),
  query('search').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { category, filter, search } = req.query;

    let query = { status: 'published' };

    // Apply filters
    if (category) {
      query.category = category;
    }

    if (filter === 'featured') {
      query.featured = true;
    } else if (filter === 'sponsored') {
      query.sponsored = true;
    }

    // Search
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } }
      ];
    }

    let sort = {};
    if (filter === 'trending') {
      // Trending: combination of views, impressions, and recency
      sort = { 
        views: -1, 
        impressions: -1, 
        createdAt: -1 
      };
    } else if (filter === 'featured' || filter === 'sponsored') {
      sort = { priority: -1, createdAt: -1 };
    } else {
      sort = { createdAt: -1 };
    }

    const blogs = await Blog.find(query)
      .populate('author', 'username profile.firstName profile.lastName profile.avatar')
      .sort(sort)
      .limit(limit)
      .skip(skip)
      .lean();

    // Add like status for authenticated users
    if (req.user) {
      for (let blog of blogs) {
        blog.isLiked = blog.likesBy?.some(id => id.toString() === req.user.id.toString()) || false;
        blog.isSaved = false; // Will be populated separately if needed
      }
    }

    const total = await Blog.countDocuments(query);

    res.json({
      blogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching blogs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/blogs/:id
// @desc    Get single blog by ID or slug
// @access  Public (but authors can access their own drafts)
router.get('/:id', tryAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    let blog;
    let query;
    
    // Build query - allow authors to see their own drafts
    if (req.user) {
      // Authenticated users can see their own blogs regardless of status
      if (mongoose.Types.ObjectId.isValid(id)) {
        query = { _id: id };
      } else {
        query = { slug: id };
      }
      
      blog = await Blog.findOne(query)
        .populate('author', 'username profile.firstName profile.lastName profile.avatar profile.bio');
      
      // If blog exists and user is the author, allow access (even if draft)
      // If blog is published, allow access to anyone
      if (blog) {
        const authorId = blog.author?._id?.toString() || blog.author?.toString();
        const userId = req.user.id?.toString() || req.user._id?.toString();
        const isAuthor = authorId === userId;
        
        if (blog.status === 'published' || isAuthor) {
          // Allow access
        } else {
          // Not the author and not published - don't allow
          blog = null;
        }
      }
    } else {
      // Not authenticated - only show published blogs
      if (mongoose.Types.ObjectId.isValid(id)) {
        blog = await Blog.findOne({ _id: id, status: 'published' })
          .populate('author', 'username profile.firstName profile.lastName profile.avatar profile.bio');
      } else {
        blog = await Blog.findOne({ slug: id, status: 'published' })
          .populate('author', 'username profile.firstName profile.lastName profile.avatar profile.bio');
      }
    }

    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    // Check if user liked/saved (only for published blogs or when author views their own)
    if (req.user) {
      const authorId = blog.author?._id?.toString() || blog.author?.toString();
      const userId = req.user.id?.toString() || req.user._id?.toString();
      const isAuthor = authorId === userId;
      
      blog.isLiked = blog.likesBy?.some(id => {
        const likeId = id?.toString();
        return likeId === userId;
      }) || false;
      
      // Only check saved/following for published blogs or when author views their own
      if (blog.status === 'published' || isAuthor) {
        const saved = await BlogSave.findOne({ user: req.user.id, blog: blog._id });
        blog.isSaved = !!saved;
        
        // Check if user follows author (only if not viewing own blog)
        if (!isAuthor && blog.author?._id) {
          const follow = await BlogFollow.findOne({ follower: req.user.id, following: blog.author._id });
          blog.isFollowing = !!follow;
        }
      }
    }

    res.json(blog);
  } catch (error) {
    console.error('Error fetching blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/blogs/:id/view
// @desc    Track blog view
// @access  Public
router.post('/:id/view', tryAuth, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    const ipAddress = getClientIP(req);
    const userId = req.user?.id || null;

    // Check if view is valid (not within cooldown)
    const isValid = await isValidView(blog._id, ipAddress, userId);
    
    if (!isValid) {
      return res.json({ 
        success: false, 
        message: 'View already counted recently. Please wait before viewing again.',
        views: blog.views 
      });
    }

    // Add view tracking
    blog.viewTracking.push({
      ipAddress,
      userId,
      timestamp: new Date()
    });

    blog.views += 1;

    // Calculate earnings using config values
    const earningsConfig = await getBlogEarningsConfig();
    const viewEarnings = Math.floor(blog.views / earningsConfig.viewsThreshold) * earningsConfig.viewsRate;
    const previousViewEarnings = Math.floor((blog.views - 1) / earningsConfig.viewsThreshold) * earningsConfig.viewsRate;
    const newEarnings = viewEarnings - previousViewEarnings;

    if (newEarnings > 0) {
      blog.earnings.totalEarned += newEarnings;
      blog.earnings.available += newEarnings;

      // Create earning record
      await BlogEarning.create({
        user: blog.author,
        blog: blog._id,
        type: 'view',
        amount: newEarnings,
        status: 'available'
      });
    }

    await blog.save();

    res.json({ 
      success: true, 
      views: blog.views,
      earnings: blog.earnings
    });
  } catch (error) {
    console.error('Error tracking view:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/blogs/:id/impression
// @desc    Track blog impression (user stayed 30+ seconds and scrolled)
// @access  Public
router.post('/:id/impression', tryAuth, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    const ipAddress = getClientIP(req);
    const userId = req.user?.id || null;

    // Check if impression is valid (not within cooldown)
    const isValid = await isValidImpression(blog._id, ipAddress, userId);
    
    if (!isValid) {
      return res.json({ 
        success: false, 
        message: 'Impression already counted recently. Please wait before counting again.',
        impressions: blog.impressions 
      });
    }

    // Add impression tracking
    blog.impressionTracking.push({
      ipAddress,
      userId,
      timestamp: new Date()
    });

    blog.impressions += 1;

    // Calculate earnings using config values
    const earningsConfig = await getBlogEarningsConfig();
    const impressionEarnings = Math.floor(blog.impressions / earningsConfig.impressionsThreshold) * earningsConfig.impressionsRate;
    const previousImpressionEarnings = Math.floor((blog.impressions - 1) / earningsConfig.impressionsThreshold) * earningsConfig.impressionsRate;
    const newEarnings = impressionEarnings - previousImpressionEarnings;

    if (newEarnings > 0) {
      blog.earnings.totalEarned += newEarnings;
      blog.earnings.available += newEarnings;

      // Create earning record
      await BlogEarning.create({
        user: blog.author,
        blog: blog._id,
        type: 'impression',
        amount: newEarnings,
        status: 'available'
      });
    }

    await blog.save();

    res.json({ 
      success: true, 
      impressions: blog.impressions,
      earnings: blog.earnings
    });
  } catch (error) {
    console.error('Error tracking impression:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/blogs/:id/like
// @desc    Like/unlike a blog
// @access  Private
router.post('/:id/like', auth, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    const userId = req.user.id;
    const isLiked = blog.likesBy?.some(id => id.toString() === userId.toString());

    if (isLiked) {
      // Unlike
      blog.likesBy = blog.likesBy.filter(id => id.toString() !== userId.toString());
      blog.likes = Math.max(0, blog.likes - 1);
    } else {
      // Like
      if (!blog.likesBy) blog.likesBy = [];
      blog.likesBy.push(userId);
      blog.likes += 1;
      
      // Create notification for blog author (if not liking own blog)
      if (blog.author.toString() !== userId.toString()) {
        try {
          await blog.populate('author', 'username');
          const notification = new Notification({
            user: blog.author._id,
            type: 'blog_liked',
            title: 'Blog Liked',
            message: `${req.user.username} liked your blog: "${blog.title}"`,
            data: {
              blogId: blog._id,
              blogSlug: blog.slug,
              likerId: userId,
              likerUsername: req.user.username
            },
            link: `/blogs/${blog.slug}`,
            relatedUser: userId,
            relatedBlog: blog._id
          });
          await notification.save();
        } catch (notifError) {
          console.error('Error creating like notification:', notifError);
        }
      }
    }

    await blog.save();

    res.json({ 
      success: true, 
      isLiked: !isLiked,
      likes: blog.likes 
    });
  } catch (error) {
    console.error('Error liking blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/blogs/:id/save
// @desc    Save/unsave a blog
// @access  Private
router.post('/:id/save', auth, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    const existingSave = await BlogSave.findOne({ user: req.user.id, blog: blog._id });

    if (existingSave) {
      await BlogSave.deleteOne({ _id: existingSave._id });
      res.json({ success: true, isSaved: false });
    } else {
      await BlogSave.create({ user: req.user.id, blog: blog._id });
      res.json({ success: true, isSaved: true });
    }
  } catch (error) {
    console.error('Error saving blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/blogs/:id/comment
// @desc    Add comment to blog
// @access  Private
router.post('/:id/comment', auth, [
  body('content').trim().isLength({ min: 1, max: 1000 }).withMessage('Comment must be between 1 and 1000 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    const comment = {
      user: req.user.id,
      content: req.body.content,
      createdAt: new Date()
    };

    if (!blog.comments) blog.comments = [];
    blog.comments.push(comment);
    await blog.save();

    await blog.populate('comments.user', 'username profile.firstName profile.lastName profile.avatar');
    await blog.populate('author', 'username');
    const newComment = blog.comments[blog.comments.length - 1];

    // Create notification for blog author (if not commenting on own blog)
    if (blog.author._id.toString() !== req.user.id.toString()) {
      try {
        const notification = new Notification({
          user: blog.author._id,
          type: 'blog_comment',
          title: 'New Comment',
          message: `${req.user.username} commented on your blog: "${blog.title}"`,
          data: {
            blogId: blog._id,
            blogSlug: blog.slug,
            commentId: newComment._id,
            commenterId: req.user.id,
            commenterUsername: req.user.username
          },
          link: `/blogs/${blog.slug}`,
          relatedUser: req.user.id,
          relatedBlog: blog._id
        });
        await notification.save();
      } catch (notifError) {
        console.error('Error creating comment notification:', notifError);
      }
    }

    res.json({ success: true, comment: newComment });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/blogs/:id/comment/:commentId/like
// @desc    Like/unlike a comment
// @access  Private
router.post('/:id/comment/:commentId/like', auth, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    const comment = blog.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const userId = req.user.id;
    const isLiked = comment.likedBy?.some(id => id.toString() === userId.toString());

    if (isLiked) {
      comment.likedBy = comment.likedBy.filter(id => id.toString() !== userId.toString());
      comment.likes = Math.max(0, comment.likes - 1);
    } else {
      if (!comment.likedBy) comment.likedBy = [];
      comment.likedBy.push(userId);
      comment.likes += 1;
    }

    await blog.save();

    res.json({ 
      success: true, 
      isLiked: !isLiked,
      likes: comment.likes 
    });
  } catch (error) {
    console.error('Error liking comment:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/blogs/user/my-blogs
// @desc    Get current user's blogs
// @access  Private
router.get('/user/my-blogs', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { status } = req.query;

    let query = { author: req.user.id };
    if (status) {
      query.status = status;
    }

    const blogs = await Blog.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    const total = await Blog.countDocuments(query);

    res.json({
      blogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching user blogs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/blogs/user/earnings
// @desc    Get current user's blog earnings
// @access  Private
router.get('/user/earnings', auth, async (req, res) => {
  try {
    const blogs = await Blog.find({ author: req.user.id }).select('earnings title');
    
    const totalEarned = blogs.reduce((sum, blog) => sum + (blog.earnings.totalEarned || 0), 0);
    const available = blogs.reduce((sum, blog) => sum + (blog.earnings.available || 0), 0);
    const withdrawn = blogs.reduce((sum, blog) => sum + (blog.earnings.withdrawn || 0), 0);

    // Get earnings by blog
    const earningsByBlog = blogs.map(blog => ({
      blogId: blog._id,
      title: blog.title,
      totalEarned: blog.earnings.totalEarned || 0,
      available: blog.earnings.available || 0,
      withdrawn: blog.earnings.withdrawn || 0
    }));

    // Get earnings config for display
    const earningsConfig = await getBlogEarningsConfig();

    res.json({
      totalEarned,
      available,
      withdrawn,
      earningsByBlog,
      config: earningsConfig
    });
  } catch (error) {
    console.error('Error fetching earnings:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/blogs/user/withdraw
// @desc    Withdraw blog earnings
// @access  Private
router.post('/user/withdraw', auth, [
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { amount, txHash } = req.body;
    const withdrawAmount = parseFloat(amount);
    
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
      return res.status(400).json({ error: 'Invalid withdrawal amount' });
    }

    const blogs = await Blog.find({ author: req.user.id });

    const totalAvailable = blogs.reduce((sum, blog) => sum + (blog.earnings.available || 0), 0);

    if (withdrawAmount > totalAvailable) {
      return res.status(400).json({ error: 'Insufficient available earnings' });
    }

    // Distribute withdrawal across blogs proportionally
    let remaining = withdrawAmount;
    for (const blog of blogs) {
      if (remaining <= 0) break;
      
      const blogAvailable = blog.earnings.available || 0;
      if (blogAvailable > 0) {
        const withdrawFromBlog = Math.min(blogAvailable, remaining);
        blog.earnings.available -= withdrawFromBlog;
        blog.earnings.withdrawn += withdrawFromBlog;
        remaining -= withdrawFromBlog;
        await blog.save();
      }
    }

    // Update user's LOB token balance (add to referral.lobTokens.available)
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (!user.referral) user.referral = { lobTokens: { available: 0, pending: 0, withdrawn: 0 } };
    if (!user.referral.lobTokens) user.referral.lobTokens = { available: 0, pending: 0, withdrawn: 0 };
    user.referral.lobTokens.available = (user.referral.lobTokens.available || 0) + withdrawAmount;
    user.referral.lobTokens.withdrawn = (user.referral.lobTokens.withdrawn || 0) + withdrawAmount;
    await user.save();

    // Create transaction record
    const Transaction = require('../models/Transaction');
    try {
      await Transaction.create({
        fromUser: null,
        toUser: req.user.id,
        amount: withdrawAmount,
        type: 'blog_withdrawal',
        status: 'completed',
        description: `Blog earnings withdrawal: ${withdrawAmount} LOB tokens`,
        isOnChain: !!txHash,
        txHash: txHash || undefined,
        fromAddress: undefined,
        toAddress: user.walletAddress || undefined,
        currency: 'LOB',
        direction: 'credit'
      });
    } catch (txError) {
      console.error('Error creating transaction record:', txError);
      // Don't fail the withdrawal if transaction record fails, but log it
    }

    res.json({ 
      success: true, 
      message: 'Earnings withdrawn successfully',
      amount: withdrawAmount,
      newBalance: user.referral.lobTokens.available,
      txHash: txHash || undefined
    });
  } catch (error) {
    console.error('Error withdrawing earnings:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/blogs/user/stats
// @desc    Get current user's blog stats
// @access  Private
router.get('/user/stats', auth, async (req, res) => {
  try {
    const blogs = await Blog.find({ author: req.user.id });
    
    const totalBlogs = blogs.length;
    const publishedBlogs = blogs.filter(b => b.status === 'published').length;
    const totalViews = blogs.reduce((sum, blog) => sum + (blog.views || 0), 0);
    const totalImpressions = blogs.reduce((sum, blog) => sum + (blog.impressions || 0), 0);
    const totalLikes = blogs.reduce((sum, blog) => sum + (blog.likes || 0), 0);
    const totalEarned = blogs.reduce((sum, blog) => sum + (blog.earnings.totalEarned || 0), 0);
    const available = blogs.reduce((sum, blog) => sum + (blog.earnings.available || 0), 0);
    const withdrawn = blogs.reduce((sum, blog) => sum + (blog.earnings.withdrawn || 0), 0);

    // Get followers and following counts
    const followers = await BlogFollow.countDocuments({ following: req.user.id });
    const following = await BlogFollow.countDocuments({ follower: req.user.id });

    // Get earnings config for display
    const earningsConfig = await getBlogEarningsConfig();

    res.json({
      totalBlogs,
      publishedBlogs,
      totalViews,
      totalImpressions,
      totalLikes,
      totalEarned,
      available,
      withdrawn,
      followers,
      following,
      config: earningsConfig
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/blogs/:id
// @desc    Update blog
// @access  Private (author only)
router.put('/:id', auth, [
  body('title').optional().trim().isLength({ min: 5, max: 200 }),
  body('excerpt').optional().trim().isLength({ max: 300 }),
  body('category').optional().isIn(['Recruiting', 'News', 'Sport', 'Business', 'Innovation', 'Health', 'Culture', 'Arts', 'Travel', 'Earth', 'Technology', 'Education', 'Entertainment']),
  body('status').optional().isIn(['draft', 'published', 'archived'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    // Check if user is the author
    if (blog.author.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this blog' });
    }

    const { title, excerpt, thumbnail, category, tags, sections, status, actionButton } = req.body;

    if (title) {
      blog.title = title;
      // Regenerate slug if title changed
      if (title !== blog.title) {
        let slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');
        let slugExists = await Blog.findOne({ slug, _id: { $ne: blog._id } });
        let counter = 1;
        while (slugExists) {
          slug = `${slug}-${counter}`;
          slugExists = await Blog.findOne({ slug, _id: { $ne: blog._id } });
          counter++;
        }
        blog.slug = slug;
      }
    }
    if (excerpt !== undefined) blog.excerpt = excerpt;
    if (thumbnail) blog.thumbnail = thumbnail;
    if (category) blog.category = category;
    if (tags) blog.tags = tags;
    if (sections) blog.sections = sections;
    if (actionButton !== undefined) blog.actionButton = actionButton;
    if (status) {
      const wasPublished = blog.status === 'published';
      blog.status = status;
      if (status === 'published' && !blog.publishedAt) {
        blog.publishedAt = new Date();
        
        // Create notifications for followers if blog is being published for the first time
        if (!wasPublished) {
          try {
            const followers = await BlogFollow.find({ following: req.user.id }).select('follower');
            if (followers.length > 0) {
              const notifications = followers.map(follow => ({
                user: follow.follower,
                type: 'blog_published',
                title: 'New Blog Post',
                message: `${req.user.username} published a new blog: "${blog.title}"`,
                data: {
                  blogId: blog._id,
                  blogSlug: blog.slug,
                  authorId: req.user.id,
                  authorUsername: req.user.username
                },
                link: `/blogs/${blog.slug}`,
                relatedUser: req.user.id,
                relatedBlog: blog._id
              }));

              await Notification.insertMany(notifications);
            }
          } catch (notifError) {
            console.error('Error creating notifications:', notifError);
            // Don't fail the request if notifications fail
          }
        }
      }
    }

    await blog.save();
    await blog.populate('author', 'username profile.firstName profile.lastName profile.avatar');

    res.json(blog);
  } catch (error) {
    console.error('Error updating blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   DELETE /api/blogs/:id
// @desc    Delete blog
// @access  Private (author only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    // Check if user is the author
    if (blog.author.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this blog' });
    }

    await Blog.deleteOne({ _id: blog._id });
    await BlogSave.deleteMany({ blog: blog._id });
    await BlogEarning.deleteMany({ blog: blog._id });

    res.json({ success: true, message: 'Blog deleted successfully' });
  } catch (error) {
    console.error('Error deleting blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/blogs/user/follow/:userId
// @desc    Follow/unfollow a blogger
// @access  Private
router.post('/user/follow/:userId', auth, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    const existingFollow = await BlogFollow.findOne({ 
      follower: req.user.id, 
      following: req.params.userId 
    });

    if (existingFollow) {
      await BlogFollow.deleteOne({ _id: existingFollow._id });
      res.json({ success: true, isFollowing: false });
    } else {
      await BlogFollow.create({ 
        follower: req.user.id, 
        following: req.params.userId 
      });
      
      // Create notification for the user being followed
      try {
        const notification = new Notification({
          user: req.params.userId,
          type: 'blog_follow',
          title: 'New Follower',
          message: `${req.user.username} started following you`,
          data: {
            followerId: req.user.id,
            followerUsername: req.user.username
          },
          link: `/profile`,
          relatedUser: req.user.id
        });
        await notification.save();
      } catch (notifError) {
        console.error('Error creating follow notification:', notifError);
      }
      
      res.json({ success: true, isFollowing: true });
    }
  } catch (error) {
    console.error('Error following user:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/blogs/user/saved
// @desc    Get user's saved blogs
// @access  Private
router.get('/user/saved', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const savedBlogs = await BlogSave.find({ user: req.user.id })
      .populate({
        path: 'blog',
        populate: { path: 'author', select: 'username profile.firstName profile.lastName profile.avatar' }
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip);

    const blogs = savedBlogs
      .filter(sb => sb.blog && sb.blog.status === 'published')
      .map(sb => sb.blog);

    const total = await BlogSave.countDocuments({ user: req.user.id });

    res.json({
      blogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching saved blogs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/blogs/user/following
// @desc    Get blogs from users you follow
// @access  Private
router.get('/user/following', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const following = await BlogFollow.find({ follower: req.user.id }).select('following');
    const followingIds = following.map(f => f.following);

    const blogs = await Blog.find({ 
      author: { $in: followingIds },
      status: 'published'
    })
      .populate('author', 'username profile.firstName profile.lastName profile.avatar')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    const total = await Blog.countDocuments({ 
      author: { $in: followingIds },
      status: 'published'
    });

    res.json({
      blogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching following blogs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ ADMIN ROUTES ============

// @route   GET /api/blogs/admin/all
// @desc    Get all blogs (admin only)
// @access  Private (admin)
router.get('/admin/all', auth, async (req, res) => {
  try {
    // Check if user is admin (you can add admin check middleware)
    const user = await User.findById(req.user.id);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const { status, category, minViews, maxViews, search } = req.query;

    let query = {};
    if (status) query.status = status;
    if (category) query.category = category;
    
    // Views range filter
    if (minViews || maxViews) {
      query.views = {};
      if (minViews) query.views.$gte = parseInt(minViews);
      if (maxViews) query.views.$lte = parseInt(maxViews);
    }
    
    // Search filter
    if (search) {
      // First, find users matching the search query
      const matchingUsers = await User.find({
        $or: [
          { username: { $regex: search, $options: 'i' } },
          { 'profile.firstName': { $regex: search, $options: 'i' } },
          { 'profile.lastName': { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      }).select('_id').lean();
      
      const userIds = matchingUsers.map(user => user._id);
      
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } },
        ...(userIds.length > 0 ? [{ author: { $in: userIds } }] : [])
      ];
    }

    const blogs = await Blog.find(query)
      .populate('author', 'username profile.firstName profile.lastName profile.avatar')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();

    const total = await Blog.countDocuments(query);

    res.json({
      blogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching all blogs:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/blogs/admin/:id/feature
// @desc    Feature/unfeature a blog (admin only)
// @access  Private (admin)
router.put('/admin/:id/feature', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    blog.featured = !blog.featured;
    await blog.save();

    res.json({ success: true, featured: blog.featured });
  } catch (error) {
    console.error('Error featuring blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/blogs/admin/:id/sponsor
// @desc    Sponsor/unsponsor a blog (admin only)
// @access  Private (admin)
router.put('/admin/:id/sponsor', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    blog.sponsored = !blog.sponsored;
    await blog.save();

    res.json({ success: true, sponsored: blog.sponsored });
  } catch (error) {
    console.error('Error sponsoring blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/blogs/admin/:id/priority
// @desc    Set blog priority (admin only)
// @access  Private (admin)
router.put('/admin/:id/priority', auth, [
  body('priority').isInt({ min: 0, max: 100 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.user.id);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    blog.priority = req.body.priority;
    await blog.save();

    res.json({ success: true, priority: blog.priority });
  } catch (error) {
    console.error('Error setting priority:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   DELETE /api/blogs/admin/:id
// @desc    Delete blog (admin only)
// @access  Private (admin)
router.delete('/admin/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    await Blog.deleteOne({ _id: blog._id });
    await BlogSave.deleteMany({ blog: blog._id });
    await BlogEarning.deleteMany({ blog: blog._id });

    res.json({ success: true, message: 'Blog deleted successfully' });
  } catch (error) {
    console.error('Error deleting blog:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
