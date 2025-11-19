const express = require('express');
const { body, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const Gig = require('../models/Gig');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Notification = require('../models/Notification');

const router = express.Router();

// @route   GET /api/gigs
// @desc    Get all gigs with filtering and pagination
// @access  Public
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      minPrice,
      maxPrice,
      skills,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const query = { isActive: true, status: 'active' };

    // Search functionality
    if (search) {
      query.$text = { $search: search };
    }

    // Filter by category
    if (category) {
      query.category = category;
    }

    // Filter by type
    if (type) {
      query.type = type;
    }

    // Filter by price range
    if (minPrice || maxPrice) {
      query.$or = [];
      if (minPrice) {
        query.$or.push({ 'pricing.basic': { $gte: parseInt(minPrice) } });
        query.$or.push({ 'pricing.min': { $gte: parseInt(minPrice) } });
      }
      if (maxPrice) {
        query.$or.push({ 'pricing.basic': { $lte: parseInt(maxPrice) } });
        query.$or.push({ 'pricing.max': { $lte: parseInt(maxPrice) } });
      }
    }

    // Filter by skills
    if (skills) {
      const skillsArray = skills.split(',').map(skill => skill.trim());
      query.skills = { $in: skillsArray };
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const gigs = await Gig.find(query)
      .populate('talent', 'username email profile stats')
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Gig.countDocuments(query);

    res.json({
      gigs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/gigs/my-gigs
// @desc    Get user's created gigs
// @access  Private (Talent only)
router.get('/my-gigs', auth, async (req, res) => {
  try {
    console.log('Fetching gigs for user:', req.user.id);
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      status
    } = req.query;

    const query = { talent: req.user.id };
    console.log('Query:', query);
    console.log('User ID type:', typeof req.user.id);
    console.log('User ID value:', req.user.id);

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    if (type) {
      query.type = type;
    }

    if (status) {
      query.status = status;
    }

    const gigs = await Gig.find(query)
      .populate('talent', 'username email profile stats')
      .populate('orders.client', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Gig.countDocuments(query);
    console.log('Found gigs:', gigs.length, 'Total:', total);
    
    // Debug: Check all gigs in database
    const allGigs = await Gig.find({}).select('_id talent title');
    console.log('All gigs in database:', allGigs);

    res.json({
      gigs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/gigs/my-ordered-gigs
// @desc    Get user's ordered gigs
// @access  Private (Client only)
router.get('/my-ordered-gigs', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      status
    } = req.query;

    const query = { 'orders.client': req.user.id };

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    if (type) {
      query.type = type;
    }

    if (status) {
      query.status = status;
    }

    const gigs = await Gig.find(query)
      .populate('talent', 'username email profile stats')
      .populate('orders.client', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Gig.countDocuments(query);

    res.json({
      gigs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/gigs/:id
// @desc    Get gig by ID
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id)
      .populate('talent', 'username email profile stats')
      .populate('orders.client', 'username email profile stats');

    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    res.json(gig);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/gigs
// @desc    Create a new gig
// @access  Private (Talent only)
router.post('/', [
  auth,
  body('title').notEmpty().withMessage('Title is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('category').isIn(['web-development', 'mobile-development', 'design', 'writing', 'marketing', 'data-science', 'other']).withMessage('Invalid category'),
  body('type').isIn(['professional', 'labour']).withMessage('Invalid type'),
  body('pricing').custom((value) => {
    if (!value.basic && !value.min) {
      throw new Error('Pricing information is required');
    }
    return true;
  })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check if user is a talent
    if (req.user.role !== 'talent') {
      return res.status(403).json({ error: 'Only talents can create gigs' });
    }

    const gigData = {
      ...req.body,
      talent: req.user.id
    };

    console.log('Creating gig with talent:', req.user.id);
    console.log('Gig data:', gigData);

    const gig = new Gig(gigData);
    await gig.save();
    console.log('Gig created with ID:', gig._id);

    await gig.populate('talent', 'username email profile stats');

    res.status(201).json(gig);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/gigs/:id/order
// @desc    Order a gig
// @access  Private (Client only)
router.post('/:id/order', [
  auth,
  body('requirements').notEmpty().withMessage('Project requirements are required'),
  body('budget').isNumeric().withMessage('Budget must be a number'),
  body('timeline').isNumeric().withMessage('Timeline must be a number')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check if user is a client
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'Only clients can order gigs' });
    }

    const gig = await Gig.findById(req.params.id);
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if gig is still active
    if (gig.status !== 'active') {
      return res.status(400).json({ error: 'Gig is no longer accepting orders' });
    }

    // Check if user already ordered
    const existingOrder = gig.orders.find(order => order.client.toString() === req.user.id);
    if (existingOrder) {
      return res.status(400).json({ error: 'You have already ordered this gig' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() === req.user.id) {
      return res.status(400).json({ error: 'You cannot order your own gig' });
    }

    const order = {
      client: req.user.id,
      requirements: req.body.requirements,
      budget: req.body.budget,
      timeline: req.body.timeline,
      attachments: req.body.attachments || []
    };

    gig.orders.push(order);
    await gig.save();

    // Create chat between talent and client
    const Chat = require('../models/Chat');
    const chat = new Chat({
      participants: [
        { user: gig.talent, role: 'talent' },
        { user: req.user.id, role: 'client' }
      ],
      type: 'gig',
      gig: gig._id,
      status: 'active'
    });
    await chat.save();

    // Create notification for talent
    const notification = new Notification({
      user: gig.talent,
      type: 'gig_order',
      title: 'New Gig Order',
      message: `You have received a new order for "${gig.title}" from ${req.user.username}.`,
      data: {
        gigId: gig._id,
        gigTitle: gig.title,
        clientId: req.user.id,
        clientName: req.user.username,
        chatId: chat._id
      }
    });
    await notification.save();

    await gig.populate('talent', 'username email profile stats');
    await gig.populate('orders.client', 'username email profile stats');

    res.json({ 
      message: 'Order placed successfully', 
      gig,
      chatId: chat._id
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/gigs/:id
// @desc    Update a gig
// @access  Private (Gig owner only)
router.put('/:id', auth, async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id);
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this gig' });
    }

    const updatedGig = await Gig.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).populate('talent', 'username email profile stats');

    res.json(updatedGig);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   DELETE /api/gigs/:id
// @desc    Delete a gig
// @access  Private (Gig owner only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id);
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this gig' });
    }

    await Gig.findByIdAndDelete(req.params.id);
    res.json({ message: 'Gig deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/gigs/search
// @desc    Search gigs
// @access  Public
router.get('/search', async (req, res) => {
  try {
    const { q, category, type, skills } = req.query;

    const query = { isActive: true, status: 'active' };

    if (q) {
      query.$text = { $search: q };
    }

    if (category) {
      query.category = category;
    }

    if (type) {
      query.type = type;
    }

    if (skills) {
      const skillsArray = skills.split(',').map(skill => skill.trim());
      query.skills = { $in: skillsArray };
    }

    const gigs = await Gig.find(query)
      .populate('talent', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json(gigs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/gigs/my-gigs
// @desc    Get user's created gigs
// @access  Private (Talent only)
router.get('/my-gigs', auth, async (req, res) => {
  try {
    console.log('Fetching gigs for user:', req.user.id);
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      status
    } = req.query;

    const query = { talent: req.user.id };
    console.log('Query:', query);
    console.log('User ID type:', typeof req.user.id);
    console.log('User ID value:', req.user.id);

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    if (type) {
      query.type = type;
    }

    if (status) {
      query.status = status;
    }

    const gigs = await Gig.find(query)
      .populate('talent', 'username email profile stats')
      .populate('orders.client', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Gig.countDocuments(query);
    console.log('Found gigs:', gigs.length, 'Total:', total);
    
    // Debug: Check all gigs in database
    const allGigs = await Gig.find({}).select('_id talent title');
    console.log('All gigs in database:', allGigs);

    res.json({
      gigs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/gigs/my-ordered-gigs
// @desc    Get user's ordered gigs
// @access  Private (Client only)
router.get('/my-ordered-gigs', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      status
    } = req.query;

    const query = {
      'orders.client': req.user.id
    };

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    if (type) {
      query.type = type;
    }

    const gigs = await Gig.find(query)
      .populate('talent', 'username email profile stats')
      .populate('orders.client', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Gig.countDocuments(query);

    res.json({
      gigs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/gigs/:id/orders
// @desc    Get gig orders
// @access  Private (Gig owner only)
router.get('/:id/orders', auth, async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id).populate('orders.client', 'username email profile stats');
    
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to view orders' });
    }

    res.json({ orders: gig.orders });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/gigs/:id/orders/:orderId/approve
// @desc    Approve gig order
// @access  Private (Gig owner only)
router.post('/:id/orders/:orderId/approve', auth, async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id);
    
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to approve orders' });
    }

    const order = gig.orders.id(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update order status
    order.status = 'accepted';
    order.approvedAt = new Date();
    await gig.save();

    // Create chat between talent and client
    const chat = new Chat({
      participants: [
        { user: gig.talent, role: 'talent' },
        { user: order.client, role: 'client' }
      ],
      type: 'gig',
      gig: gig._id,
      status: 'active',
      unreadCount: new Map([
        [gig.talent.toString(), 0],
        [order.client.toString(), 1]
      ])
    });

    // Add initial message
    const message = new Message({
      chat: chat._id,
      sender: gig.talent,
      content: `Your order for "${gig.title}" has been approved! Let's discuss the project details.`,
      type: 'text'
    });

    // Create notification for client
    const notification = new Notification({
      user: order.client,
      type: 'gig_approved',
      title: 'Order Approved!',
      message: `Your order for "${gig.title}" has been approved by the talent.`,
      data: {
        gigId: gig._id,
        gigTitle: gig.title,
        chatId: chat._id
      }
    });

    await Promise.all([chat.save(), message.save(), notification.save()]);

    res.json({ message: 'Order approved successfully', chat: chat._id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/gigs/:id/orders/:orderId/reject
// @desc    Reject gig order
// @access  Private (Gig owner only)
router.post('/:id/orders/:orderId/reject', auth, async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id);
    
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to reject orders' });
    }

    const order = gig.orders.id(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Update order status
    order.status = 'rejected';
    order.rejectedAt = new Date();
    await gig.save();

    res.json({ message: 'Order rejected' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;