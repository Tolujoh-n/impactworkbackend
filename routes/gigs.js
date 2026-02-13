const express = require('express');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const { auth } = require('../middleware/auth');
const Gig = require('../models/Gig');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const { uploadImage } = require('../utils/cloudinary');

const router = express.Router();

// Configure multer for memory storage (to pass buffer to Cloudinary)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

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

    const query = { isActive: true, status: { $ne: 'archived' } };

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

    // Add order status counts to each gig
    const gigsWithCounts = gigs.map(gig => {
      const gigObj = gig.toObject ? gig.toObject() : gig;
      const completedCount = gig.orders.filter(o => o.status === 'completed').length;
      const activeCount = gig.orders.filter(o => 
        o.status === 'accepted' || o.status === 'in-progress'
      ).length;
      const pendingCount = gig.orders.filter(o => o.status === 'pending').length;
      const archivedCount = gig.orders.filter(o => o.status === 'cancelled').length;
      return {
        ...gigObj,
        orderStatusCounts: {
          completed: completedCount,
          active: activeCount,
          pending: pendingCount,
          archived: archivedCount
        }
      };
    });

    const total = await Gig.countDocuments(query);
    console.log('Found gigs:', gigs.length, 'Total:', total);
    
    // Debug: Check all gigs in database
    const allGigs = await Gig.find({}).select('_id talent title');
    console.log('All gigs in database:', allGigs);

    res.json({
      gigs: gigsWithCounts,
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
    console.log('Fetching ordered gigs for user:', req.user.id);
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      status
    } = req.query;

    const query = { 'orders.client': req.user.id };
    console.log('Ordered gigs query:', query);

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

    // First, get all gigs that have orders from this user (no pagination yet)
    const allGigs = await Gig.find(query)
      .populate('talent', 'username email profile stats')
      .populate('orders.client', 'username email profile stats')
      .sort({ createdAt: -1 })
      .exec();

    // Transform to show each order as a separate entry
    const Chat = require('../models/Chat');
    const gigsWithOrders = [];
    
    for (const gig of allGigs) {
      // Filter orders for this user - handle both populated and unpopulated client fields
      const userOrders = gig.orders.filter(order => {
        const clientId = order.client?._id || order.client;
        return clientId && clientId.toString() === req.user.id.toString();
      });
      
      for (const order of userOrders) {
        let chatId = null;
        // Find chat for all non-pending statuses (accepted, in-progress, completed)
        if (order.status !== 'pending' && order.status !== 'rejected' && order.status !== 'cancelled') {
          // First try to use stored chatId if available
          if (order.chatId) {
            chatId = order.chatId.toString();
          } else if (order.approvedAt) {
            // Fallback: Find chat created around the time this order was approved
            // Since each order creates a new chat, find the most recent one for this gig/client
            const orderClientId = order.client?._id || order.client;
            const gigTalentId = gig.talent?._id || gig.talent;
            const chatQuery = {
              gig: gig._id,
              type: 'gig',
              'participants.user': { $all: [gigTalentId, orderClientId] },
              createdAt: {
                $gte: new Date(order.approvedAt.getTime() - 60000), // 1 minute before
                $lte: new Date(order.approvedAt.getTime() + 60000)  // 1 minute after
              }
            };
            const chat = await Chat.findOne(chatQuery)
              .sort({ createdAt: -1 })
              .select('_id')
              .limit(1);
            if (chat) {
              chatId = chat._id;
            }
          }
        }
        
        // Convert to plain object if needed
        const gigObj = gig.toObject ? gig.toObject() : gig;
        const orderObj = order.toObject ? order.toObject() : order;
        
        gigsWithOrders.push({
          ...gigObj,
          order: orderObj,
          chatId: chatId
        });
      }
    }

    // Now apply pagination to the transformed array
    const total = gigsWithOrders.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedGigs = gigsWithOrders.slice(startIndex, endIndex);

    console.log('Found ordered gigs:', allGigs.length, 'Orders:', gigsWithOrders.length, 'Paginated:', paginatedGigs.length, 'Total:', total);

    res.json({
      gigs: paginatedGigs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total: total
    });
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

    // Add order status counts
    const gigObj = gig.toObject ? gig.toObject() : gig;
    const completedCount = gig.orders.filter(o => o.status === 'completed').length;
    gigObj.orderStatusCounts = {
      completed: completedCount
    };

    res.json(gigObj);
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
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'portfolioImage_0', maxCount: 1 },
    { name: 'portfolioImage_1', maxCount: 1 },
    { name: 'portfolioImage_2', maxCount: 1 },
    { name: 'portfolioImage_3', maxCount: 1 },
    { name: 'portfolioImage_4', maxCount: 1 }
  ]), // Handle main image and portfolio images
  body('title').notEmpty().withMessage('Title is required'),
  body('description')
    .notEmpty().withMessage('Description is required')
    .custom((value) => {
      if (!value || typeof value !== 'string') {
        throw new Error('Description is required');
      }
      // Strip HTML tags and check if there's actual text content
      const textContent = value.replace(/<[^>]*>/g, '').trim();
      if (textContent.length === 0) {
        throw new Error('Description must contain actual content, not just formatting');
      }
      return true;
    }),
  body('category').isIn(['graphics-design', 'digital-marketing', 'writing-translation', 'video-animation', 'music-audio', 'programming-tech', 'business', 'lifestyle', 'data', 'photography', 'online-marketing', 'translation', 'other']).withMessage('Invalid category'),
  body('type').isIn(['professional', 'labour']).withMessage('Invalid type'),
  body('pricing').custom((value) => {
    // Parse JSON string if needed (FormData sends JSON as strings)
    let pricing = value;
    if (typeof value === 'string') {
      try {
        pricing = JSON.parse(value);
      } catch (e) {
        // If parsing fails, it might be empty or malformed
        throw new Error('Invalid pricing format. Please provide valid pricing data.');
      }
    }
    
    if (!pricing || typeof pricing !== 'object') {
      throw new Error('Pricing information is required. Provide both basic and premium offers.');
    }
    
    // Check for new basic/premium structure
    const hasBasicOffer = pricing.basic && pricing.basic.price !== undefined && pricing.basic.price !== null && pricing.basic.price !== '';
    const hasPremiumOffer = pricing.premium && pricing.premium.price !== undefined && pricing.premium.price !== null && pricing.premium.price !== '';
    
    // Check for legacy pricing structure (for backward compatibility)
    const hasBasic = pricing.basic !== undefined && typeof pricing.basic === 'number';
    const hasMin = pricing.min !== undefined && pricing.min !== null;
    const hasMax = pricing.max !== undefined && pricing.max !== null;
    const hasRange = hasMin && hasMax;
    
    // Accept either new structure (basic/premium offers) or legacy structure
    if (!hasBasicOffer && !hasPremiumOffer && !hasBasic && !hasMin && !hasRange) {
      throw new Error('Pricing information is required. Provide both basic and premium offers with prices.');
    }
    
    // Validate new structure (both basic and premium must be provided)
    if (!hasBasicOffer) {
      throw new Error('Basic offer with price is required');
    }
    if (!hasPremiumOffer) {
      throw new Error('Premium offer with price is required');
    }
    
    // Legacy validation
    if (hasMin && !hasMax) {
      throw new Error('Maximum price is required when minimum price is provided');
    }
    if (hasMax && !hasMin) {
      throw new Error('Minimum price is required when maximum price is provided');
    }
    
    return true;
  })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors:', errors.array());
      console.error('Request body:', req.body);
      console.error('Files:', req.files ? 'Present' : 'Missing');
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: errors.array() 
      });
    }

    // Check if user is a talent
    if (req.user.role !== 'talent') {
      return res.status(403).json({ error: 'Only talents can create gigs' });
    }

    // Image is mandatory for gigs
    const mainImage = req.files?.image?.[0];
    if (!mainImage) {
      console.error('No file in request. Files:', req.files);
      return res.status(400).json({ error: 'Gig image is required' });
    }

    console.log('File received:', {
      originalname: mainImage.originalname,
      mimetype: mainImage.mimetype,
      size: mainImage.size,
      hasBuffer: !!mainImage.buffer
    });

    // Upload main image to Cloudinary
    let imageUrl;
    try {
      const uploadResult = await uploadImage(mainImage, { folder: 'workloob/gigs' });
      imageUrl = uploadResult.url;
      console.log('Image uploaded successfully:', imageUrl);
    } catch (uploadError) {
      console.error('Image upload error:', uploadError);
      console.error('Upload error details:', uploadError.message, uploadError.stack);
      return res.status(500).json({ error: 'Failed to upload gig image: ' + uploadError.message });
    }

    // Parse JSON fields if they come as strings (FormData sends JSON as strings)
    let pricing = req.body.pricing;
    if (typeof pricing === 'string') {
      try {
        pricing = JSON.parse(pricing);
      } catch (e) {
        console.error('Error parsing pricing:', e);
        return res.status(400).json({ error: 'Invalid pricing format' });
      }
    }

    // Parse arrays from FormData (they come as JSON strings)
    let includes = req.body.includes;
    if (typeof includes === 'string') {
      try {
        includes = JSON.parse(includes);
      } catch (e) {
        includes = [];
      }
    }

    let skills = req.body.skills;
    if (typeof skills === 'string') {
      try {
        skills = JSON.parse(skills);
      } catch (e) {
        skills = [];
      }
    }

    // Handle portfolio with image uploads
    let portfolio = req.body.portfolio;
    if (typeof portfolio === 'string') {
      try {
        portfolio = JSON.parse(portfolio);
      } catch (e) {
        portfolio = [];
      }
    }

    // Upload portfolio images if any
    if (Array.isArray(portfolio) && portfolio.length > 0) {
      for (let i = 0; i < portfolio.length; i++) {
        const portfolioItem = portfolio[i];
        if (portfolioItem.imageIndex !== null && portfolioItem.imageIndex !== undefined) {
          const portfolioImageFile = req.files?.[`portfolioImage_${portfolioItem.imageIndex}`]?.[0];
          if (portfolioImageFile) {
            try {
              const uploadResult = await uploadImage(portfolioImageFile, { folder: 'workloob/gigs/portfolio' });
              portfolioItem.imageUrl = uploadResult.url;
              delete portfolioItem.imageIndex; // Remove temporary index
            } catch (uploadError) {
              console.error(`Error uploading portfolio image ${i}:`, uploadError);
              // Continue with other items even if one fails
              portfolioItem.imageUrl = null;
            }
          }
        }
      }
      // Filter out items without images or descriptions
      portfolio = portfolio.filter(item => item.imageUrl || (item.description && item.description.trim() !== ''));
    }

    // Parse location if provided
    let location = { remote: true };
    if (req.body.location) {
      try {
        location = typeof req.body.location === 'string' ? JSON.parse(req.body.location) : req.body.location;
      } catch (e) {
        location = { remote: true };
      }
    }

    const gigData = {
      title: req.body.title,
      description: req.body.description,
      category: req.body.category,
      subCategory: req.body.subCategory || null,
      type: req.body.type,
      pricing: pricing,
      includes: includes || [],
      skills: skills || [],
      portfolio: portfolio || [],
      imageUrl: imageUrl,
      location: location,
      talent: req.user.id
    };

    console.log('Creating gig with talent:', req.user.id);

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
    console.log('Gig order request body:', req.body);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
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

    // Allow orders as long as gig is not archived or cancelled
    // Completed gigs can still accept new orders (similar to how jobs work)
    if (gig.status === 'archived' || gig.status === 'cancelled') {
      return res.status(400).json({ error: 'Gig is no longer accepting orders' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() === req.user.id) {
      return res.status(400).json({ error: 'You cannot order your own gig' });
    }

    // Allow multiple orders from the same client - they can reorder

    const order = {
      client: req.user.id,
      package: req.body.package || 'basic', // 'basic' or 'premium'
      requirements: req.body.requirements,
      budget: req.body.budget,
      timeline: req.body.timeline,
      attachments: req.body.attachments || []
    };

    gig.orders.push(order);
    await gig.save();

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
        clientName: req.user.username
      }
    });
    await notification.save();

    await gig.populate('talent', 'username email profile stats');
    await gig.populate('orders.client', 'username email profile stats');

    res.json({ 
      message: 'Order placed successfully', 
      gig
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

    // Find chat IDs for accepted orders
    const Chat = require('../models/Chat');
    const ordersWithChats = await Promise.all(gig.orders.map(async (order) => {
      const orderObj = order.toObject();
      // Find chat for all non-pending statuses (accepted, in-progress, completed)
      if (order.status !== 'pending' && order.status !== 'rejected' && order.status !== 'cancelled') {
        // First try to use stored chatId if available
        if (order.chatId) {
          orderObj.chatId = order.chatId.toString();
        } else if (order.approvedAt) {
          // Fallback: Find chat created around the time this order was approved
          const chatQuery = {
            gig: gig._id,
            type: 'gig',
            'participants.user': { $all: [gig.talent, order.client] },
            createdAt: {
              $gte: new Date(order.approvedAt.getTime() - 60000), // 1 minute before
              $lte: new Date(order.approvedAt.getTime() + 60000)  // 1 minute after
            }
          };
          const chat = await Chat.findOne(chatQuery)
            .sort({ createdAt: -1 })
            .select('_id')
            .limit(1);
          if (chat) {
            orderObj.chatId = chat._id;
          }
        }
      }
      return orderObj;
    }));

    // Add order status counts to gig
    const gigObj = gig.toObject ? gig.toObject() : gig;
    const completedCount = gig.orders.filter(o => o.status === 'completed').length;
    const archivedCount = gig.orders.filter(o => o.status === 'cancelled').length;
    const pendingCount = gig.orders.filter(o => o.status === 'pending').length;
    const acceptedCount = gig.orders.filter(o => o.status === 'accepted').length;
    const inProgressCount = gig.orders.filter(o => o.status === 'in-progress').length;
    
    gigObj.orderStatusCounts = {
      completed: completedCount,
      archived: archivedCount,
      pending: pendingCount,
      accepted: acceptedCount,
      'in-progress': inProgressCount
    };

    res.json({ 
      gig: gigObj,
      orders: ordersWithChats 
    });
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
    
    // Create chat between talent and client (each order gets its own chat)
    const chat = new Chat({
      participants: [
        { user: gig.talent, role: 'talent', participantType: 'owner' },
        { user: order.client, role: 'client', participantType: 'owner' }
      ],
      type: 'gig',
      gig: gig._id,
      status: 'active',
      workflowStatus: 'offered',
      price: {
        original: order.budget,
        current: order.budget,
        currency: 'USD'
      }
    });
    
    // Set unread count after saving
    chat.unreadCount.set(gig.talent.toString(), 0);
    chat.unreadCount.set(order.client.toString(), 1);
    
    await chat.save();
    
    // Store chat ID in the order (if the order schema supports it)
    // Note: Since orders are embedded, we'll store it in a custom field
    if (!order.chatId) {
      order.chatId = chat._id;
    }
    
    await gig.save();

    // Add initial message with order details
    const orderDetails = `
**Order Approved!** ✅

**Gig:** ${gig.title}
**Client Requirements:**
- Requirements: ${order.requirements || 'No specific requirements provided'}
- Budget: $${order.budget || 'As discussed'}
- Timeline: ${order.timeline || 'Flexible'} days

Let's discuss the project details and get started!
    `.trim();
    
    const message = new Message({
      chatId: chat._id,
      senderId: gig.talent,
      content: orderDetails,
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

    await Promise.all([message.save(), notification.save()]);

    // Emit socket event for real-time updates
    const io = req.app.get('io');
    if (io) {
      io.emit('order:approved', {
        gigId: gig._id.toString(),
        orderId: order._id.toString(),
        chatId: chat._id.toString()
      });
      io.emit('gig:updated', {
        gigId: gig._id.toString(),
        _id: gig._id.toString()
      });
    }

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

    // Emit socket event for real-time updates
    const io = req.app.get('io');
    if (io) {
      io.emit('order:rejected', {
        gigId: gig._id.toString(),
        orderId: order._id.toString()
      });
      io.emit('gig:updated', {
        gigId: gig._id.toString(),
        _id: gig._id.toString()
      });
    }

    res.json({ message: 'Order rejected' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/gigs/:id
// @desc    Update a gig
// @access  Private (Gig owner only)
router.put('/:id', auth, upload.single('image'), async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id);
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this gig' });
    }

    // Handle image upload if provided
    let imageUrl = gig.imageUrl; // Keep existing image if no new one uploaded
    if (req.file) {
      try {
        const uploadResult = await uploadImage(req.file, { folder: 'workloob/gigs' });
        imageUrl = uploadResult.url;
      } catch (uploadError) {
        console.error('Image upload error:', uploadError);
        return res.status(500).json({ error: 'Failed to upload gig image' });
      }
    }

    // Parse JSON fields if they come as strings
    let pricing = req.body.pricing;
    if (typeof pricing === 'string') {
      try {
        pricing = JSON.parse(pricing);
      } catch (e) {
        pricing = gig.pricing; // Keep existing pricing if parse fails
      }
    }

    // Parse arrays from FormData
    let includes = req.body.includes;
    if (typeof includes === 'string') {
      try {
        includes = JSON.parse(includes);
      } catch (e) {
        includes = gig.includes;
      }
    }

    let skills = req.body.skills;
    if (typeof skills === 'string') {
      try {
        skills = JSON.parse(skills);
      } catch (e) {
        skills = gig.skills;
      }
    }

    let portfolio = req.body.portfolio;
    if (typeof portfolio === 'string') {
      try {
        portfolio = JSON.parse(portfolio);
      } catch (e) {
        portfolio = gig.portfolio;
      }
    }

    const gigData = {
      ...req.body,
      pricing: pricing || gig.pricing,
      includes: includes || gig.includes,
      skills: skills || gig.skills,
      portfolio: portfolio || gig.portfolio,
      imageUrl: imageUrl
    };

    const updatedGig = await Gig.findByIdAndUpdate(
      req.params.id,
      { $set: gigData },
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

// @route   PUT /api/gigs/:id/archive
// @desc    Archive a gig
// @access  Private (Gig owner only)
router.put('/:id/archive', auth, async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id);
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to archive this gig' });
    }

    gig.status = 'archived';
    await gig.save();

    res.json({ message: 'Gig archived successfully', gig });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/gigs/:id/unarchive
// @desc    Unarchive a gig
// @access  Private (Gig owner only)
router.put('/:id/unarchive', auth, async (req, res) => {
  try {
    const gig = await Gig.findById(req.params.id);
    if (!gig) {
      return res.status(404).json({ error: 'Gig not found' });
    }

    // Check if user is the gig owner
    if (gig.talent.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to unarchive this gig' });
    }

    gig.status = 'active';
    await gig.save();

    res.json({ message: 'Gig unarchived successfully', gig });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
