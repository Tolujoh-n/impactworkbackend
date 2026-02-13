const express = require('express');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const { auth } = require('../middleware/auth');
const Job = require('../models/Job');
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

// @route   GET /api/jobs
// @desc    Get all jobs with filtering and pagination
// @access  Public
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      minBudget,
      maxBudget,
      location,
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
      if (type === 'freelance') {
        // For freelance, include all non-full-time jobs
        query.type = { $in: ['part-time', 'freelance', 'contract'] };
      } else {
        query.type = type;
      }
    }

    // Filter by budget range
    if (minBudget || maxBudget) {
      query.$or = [];
      if (minBudget) {
        query.$or.push({ 'budget.fixed': { $gte: parseInt(minBudget) } });
        query.$or.push({ 'budget.min': { $gte: parseInt(minBudget) } });
      }
      if (maxBudget) {
        query.$or.push({ 'budget.fixed': { $lte: parseInt(maxBudget) } });
        query.$or.push({ 'budget.max': { $lte: parseInt(maxBudget) } });
      }
    }

    // Filter by location
    if (location) {
      if (location === 'remote') {
        query['location.remote'] = true;
      } else {
        query['location.city'] = new RegExp(location, 'i');
      }
    }

    // Filter by skills
    if (skills) {
      const skillsArray = skills.split(',').map(skill => skill.trim());
      query.skills = { $in: skillsArray };
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const jobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Job.countDocuments(query);

    res.json({
      jobs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/search
// @desc    Search jobs
// @access  Public
router.get('/search', async (req, res) => {
  try {
    const { q, category, type, skills } = req.query;

    const query = { isActive: true, status: 'open' };

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

    const jobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json(jobs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/my-jobs
// @desc    Get user's posted jobs
// @access  Private (Client only)
router.get('/my-jobs', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      status
    } = req.query;

    const query = { client: req.user.id };

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    if (type) {
      // Handle "others" type - show part-time and contract (exclude freelance and full-time)
      if (type === 'others') {
        query.type = { $in: ['part-time', 'contract'] };
      } else {
        query.type = type;
      }
    }

    if (status) {
      query.status = status;
    }

    const jobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .populate('applications.talent', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    // Add application status counts to each job
    const jobsWithCounts = jobs.map(job => {
      const jobObj = job.toObject ? job.toObject() : job;
      const completedCount = job.applications.filter(app => app.status === 'completed').length;
      const activeCount = job.applications.filter(app => 
        app.status === 'accepted' || app.status === 'in-progress'
      ).length;
      const pendingCount = job.applications.filter(app => app.status === 'pending').length;
      const rejectedCount = job.applications.filter(app => app.status === 'rejected').length;
      return {
        ...jobObj,
        applicationStatusCounts: {
          completed: completedCount,
          active: activeCount,
          pending: pendingCount,
          rejected: rejectedCount
        }
      };
    });

    const total = await Job.countDocuments(query);

    res.json({
      jobs: jobsWithCounts,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/my-freelance-jobs
// @desc    Get user's freelance job applications
// @access  Private (Talent only)
router.get('/my-freelance-jobs', auth, async (req, res) => {
  try {
    console.log('Fetching freelance jobs for user:', req.user.id);
    const {
      page = 1,
      limit = 10,
      search,
      category,
      status
    } = req.query;

    const query = {
      type: 'freelance', // Only freelance jobs, not part-time or contract
      'applications.talent': req.user.id
    };
    console.log('Freelance jobs query:', query);

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    const allJobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .populate('applications.talent', 'username email profile stats')
      .sort({ createdAt: -1 })
      .exec();

    // Transform to show each application as a separate entry with chatId
    const Chat = require('../models/Chat');
    const jobsWithApplications = [];
    
    for (const job of allJobs) {
      // Filter applications for this user
      const userApplications = job.applications.filter(app => {
        const talentId = app.talent?._id || app.talent;
        return talentId && talentId.toString() === req.user.id.toString();
      });
      
      for (const application of userApplications) {
        let chatId = null;
        // Find chat for all non-pending statuses (accepted, in-progress)
        if (application.status !== 'pending' && application.status !== 'rejected') {
          // First try to use stored chatId if available
          if (application.chatId) {
            chatId = application.chatId.toString();
          } else if (application.approvedAt) {
            // Fallback: Find chat created around the time this application was approved
            const jobClientId = job.client?._id || job.client;
            const appTalentId = application.talent?._id || application.talent;
            const chatQuery = {
              job: job._id,
              type: 'job',
              'participants.user': { $all: [jobClientId, appTalentId] },
              createdAt: {
                $gte: new Date(application.approvedAt.getTime() - 60000), // 1 minute before
                $lte: new Date(application.approvedAt.getTime() + 60000)  // 1 minute after
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
        const jobObj = job.toObject ? job.toObject() : job;
        const appObj = application.toObject ? application.toObject() : application;
        
        jobsWithApplications.push({
          ...jobObj,
          application: appObj,
          chatId: chatId
        });
      }
    }

    // Now apply pagination to the transformed array
    const total = jobsWithApplications.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedJobs = jobsWithApplications.slice(startIndex, endIndex);

    console.log('Found freelance jobs:', allJobs.length, 'Applications:', jobsWithApplications.length, 'Paginated:', paginatedJobs.length, 'Total:', total);

    res.json({
      jobs: paginatedJobs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total: total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/my-fulltime-jobs
// @desc    Get user's full-time job applications
// @access  Private (Talent only)
router.get('/my-fulltime-jobs', auth, async (req, res) => {
  try {
    console.log('Fetching full-time jobs for user:', req.user.id);
    const {
      page = 1,
      limit = 10,
      search,
      category,
      status
    } = req.query;

    const query = {
      type: 'full-time',
      'applications.talent': req.user.id
    };
    console.log('Full-time jobs query:', query);

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    const allJobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .populate('applications.talent', 'username email profile stats')
      .sort({ createdAt: -1 })
      .exec();

    // Transform to show each application as a separate entry with chatId
    const Chat = require('../models/Chat');
    const jobsWithApplications = [];
    
    for (const job of allJobs) {
      // Filter applications for this user
      const userApplications = job.applications.filter(app => {
        const talentId = app.talent?._id || app.talent;
        return talentId && talentId.toString() === req.user.id.toString();
      });
      
      for (const application of userApplications) {
        let chatId = null;
        // Find chat for all non-pending statuses (accepted, in-progress)
        if (application.status !== 'pending' && application.status !== 'rejected') {
          // First try to use stored chatId if available
          if (application.chatId) {
            chatId = application.chatId.toString();
          } else if (application.approvedAt) {
            // Fallback: Find chat created around the time this application was approved
            const jobClientId = job.client?._id || job.client;
            const appTalentId = application.talent?._id || application.talent;
            const chatQuery = {
              job: job._id,
              type: 'job',
              'participants.user': { $all: [jobClientId, appTalentId] },
              createdAt: {
                $gte: new Date(application.approvedAt.getTime() - 60000), // 1 minute before
                $lte: new Date(application.approvedAt.getTime() + 60000)  // 1 minute after
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
        const jobObj = job.toObject ? job.toObject() : job;
        const appObj = application.toObject ? application.toObject() : application;
        
        jobsWithApplications.push({
          ...jobObj,
          application: appObj,
          chatId: chatId
        });
      }
    }

    // Now apply pagination to the transformed array
    const total = jobsWithApplications.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedJobs = jobsWithApplications.slice(startIndex, endIndex);

    console.log('Found full-time jobs:', allJobs.length, 'Applications:', jobsWithApplications.length, 'Paginated:', paginatedJobs.length, 'Total:', total);

    res.json({
      jobs: paginatedJobs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total: total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/my-other-jobs
// @desc    Get user's other job applications (part-time, contract)
// @access  Private (Talent only)
router.get('/my-other-jobs', auth, async (req, res) => {
  try {
    console.log('Fetching other jobs (part-time, contract) for user:', req.user.id);
    const {
      page = 1,
      limit = 10,
      search,
      category,
      status
    } = req.query;

    const query = {
      type: { $in: ['part-time', 'contract'] }, // Only part-time and contract jobs
      'applications.talent': req.user.id
    };
    console.log('Other jobs query:', query);

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    const allJobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .populate('applications.talent', 'username email profile stats')
      .sort({ createdAt: -1 })
      .exec();

    // Transform to show each application as a separate entry with chatId
    const Chat = require('../models/Chat');
    const jobsWithApplications = [];
    
    for (const job of allJobs) {
      // Filter applications for this user
      const userApplications = job.applications.filter(app => {
        const talentId = app.talent?._id || app.talent;
        return talentId && talentId.toString() === req.user.id.toString();
      });
      
      for (const application of userApplications) {
        // Apply status filter if provided
        if (status && application.status !== status) {
          continue;
        }
        
        let chatId = null;
        // Find chat for all non-pending statuses (accepted, in-progress, completed)
        if (application.status !== 'pending' && application.status !== 'rejected') {
          // First try to use stored chatId if available
          if (application.chatId) {
            chatId = application.chatId.toString();
          } else if (application.approvedAt) {
            // Fallback: Find chat created around the time this application was approved
            const jobClientId = job.client?._id || job.client;
            const appTalentId = application.talent?._id || application.talent;
            const chatQuery = {
              job: job._id,
              type: 'job',
              'participants.user': { $all: [jobClientId, appTalentId] },
              createdAt: {
                $gte: new Date(application.approvedAt.getTime() - 60000), // 1 minute before
                $lte: new Date(application.approvedAt.getTime() + 60000)  // 1 minute after
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
        const jobObj = job.toObject ? job.toObject() : job;
        const appObj = application.toObject ? application.toObject() : application;
        
        jobsWithApplications.push({
          ...jobObj,
          application: appObj,
          chatId: chatId
        });
      }
    }

    // Now apply pagination to the transformed array
    const total = jobsWithApplications.length;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedJobs = jobsWithApplications.slice(startIndex, endIndex);

    console.log('Found other jobs:', allJobs.length, 'Applications:', jobsWithApplications.length, 'Paginated:', paginatedJobs.length, 'Total:', total);

    res.json({
      jobs: paginatedJobs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total: total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/:id
// @desc    Get job by ID
// @access  Public
router.get('/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .populate('client', 'username email profile stats')
      .populate('applications.talent', 'username email profile stats');

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Add application status counts
    const jobObj = job.toObject ? job.toObject() : job;
    const completedCount = job.applications.filter(app => 
      app.status === 'completed'
    ).length;
    const activeCount = job.applications.filter(app => 
      app.status === 'accepted' || app.status === 'in-progress'
    ).length;
    const pendingCount = job.applications.filter(app => app.status === 'pending').length;
    const rejectedCount = job.applications.filter(app => app.status === 'rejected').length;
    jobObj.applicationStatusCounts = {
      completed: completedCount,
      active: activeCount,
      pending: pendingCount,
      rejected: rejectedCount
    };

    res.json(jobObj);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/jobs
// @desc    Create a new job
// @access  Private (Client only)
router.post('/', [
  auth,
  upload.single('image'), // Handle single image file (optional)
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
  body('category').isIn(['graphics-design', 'digital-marketing', 'writing-translation', 'video-animation', 'music-audio', 'programming-tech', 'business', 'lifestyle', 'data', 'photography', 'online-marketing', 'translation', 'other']).withMessage('Invalid category. Please select a valid category.'),
  body('type').isIn(['full-time', 'part-time', 'freelance', 'contract']).withMessage('Invalid type'),
  body('budget').custom((value) => {
    // Check if at least one budget type is provided
    const hasFixed = value.fixed !== undefined && value.fixed !== null;
    const hasMin = value.min !== undefined && value.min !== null;
    const hasMax = value.max !== undefined && value.max !== null;
    const hasRange = hasMin && hasMax;
    
    if (!hasFixed && !hasMin && !hasRange) {
      throw new Error('Budget information is required');
    }
    // If range is provided, both min and max should be present
    if (hasMin && !hasMax) {
      throw new Error('Maximum budget is required when minimum budget is provided');
    }
    if (hasMax && !hasMin) {
      throw new Error('Minimum budget is required when maximum budget is provided');
    }
    return true;
  })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors:', errors.array());
      console.error('Request body:', req.body);
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: errors.array() 
      });
    }

    // Check if user is a client
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'Only clients can post jobs' });
    }

    // Upload image to Cloudinary if provided (optional for jobs)
    let imageUrl = null;
    if (req.file) {
      try {
        const uploadResult = await uploadImage(req.file, { folder: 'workloob/jobs' });
        imageUrl = uploadResult.url;
      } catch (uploadError) {
        console.error('Image upload error:', uploadError);
        return res.status(500).json({ error: 'Failed to upload job image' });
      }
    }

    // Parse JSON fields if they come as strings
    let budget = req.body.budget;
    if (typeof budget === 'string') {
      try {
        budget = JSON.parse(budget);
      } catch (e) {
        budget = {};
      }
    }

    // Parse location if provided
    let location = { remote: false };
    if (req.body.location) {
      try {
        location = typeof req.body.location === 'string' ? JSON.parse(req.body.location) : req.body.location;
      } catch (e) {
        location = { remote: false };
      }
    }

    const jobData = {
      title: req.body.title,
      description: req.body.description,
      category: req.body.category,
      subCategory: req.body.subCategory || null,
      type: req.body.type,
      budget: budget,
      location: location,
      skills: req.body.skills ? (typeof req.body.skills === 'string' ? JSON.parse(req.body.skills) : req.body.skills) : [],
      requirements: req.body.requirements ? (typeof req.body.requirements === 'string' ? JSON.parse(req.body.requirements) : req.body.requirements) : [],
      deliverables: req.body.deliverables ? (typeof req.body.deliverables === 'string' ? JSON.parse(req.body.deliverables) : req.body.deliverables) : [],
      duration: req.body.duration ? (typeof req.body.duration === 'string' ? JSON.parse(req.body.duration) : req.body.duration) : null,
      client: req.user.id
    };

    // Add imageUrl only if provided
    if (imageUrl) {
      jobData.imageUrl = imageUrl;
    }

    const job = new Job(jobData);
    await job.save();

    await job.populate('client', 'username email profile stats');

    res.status(201).json(job);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/jobs/:id/apply
// @desc    Apply to a job
// @access  Private (Talent only)
router.post('/:id/apply', [
  auth,
  body('coverLetter').notEmpty().withMessage('Cover letter is required'),
  body('bidAmount')
    .custom((value) => {
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0) {
        throw new Error('Bid amount must be a positive number');
      }
      return true;
    })
    .withMessage('Bid amount must be a positive number'),
  body('estimatedDuration')
    .custom((value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
        throw new Error('Estimated duration must be a positive integer');
      }
      return true;
    })
    .withMessage('Estimated duration must be a positive integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors when applying to job:', errors.array());
      console.error('Request body:', req.body);
      return res.status(400).json({ 
        error: 'Validation failed',
        errors: errors.array(),
        details: errors.array().map(e => `${e.param}: ${e.msg}`).join(', ')
      });
    }

    // Check if user is a talent
    if (req.user.role !== 'talent') {
      return res.status(403).json({ error: 'Only talents can apply to jobs' });
    }

    const job = await Job.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Allow applications as long as job is not archived or cancelled
    // Completed jobs can still accept new applications (similar to how gigs work)
    if (job.status === 'archived' || job.status === 'cancelled') {
      return res.status(400).json({ error: 'Job is no longer accepting applications' });
    }

    // Allow multiple applications from the same talent - they can reapply

    // Check if user is the job owner
    if (job.client.toString() === req.user.id) {
      return res.status(400).json({ error: 'You cannot apply to your own job' });
    }

    const application = {
      talent: req.user.id,
      coverLetter: req.body.coverLetter,
      bidAmount: parseFloat(req.body.bidAmount),
      estimatedDuration: parseInt(req.body.estimatedDuration, 10),
      attachments: req.body.attachments || []
    };

    // Validate parsed values
    if (isNaN(application.bidAmount) || application.bidAmount <= 0) {
      return res.status(400).json({ error: 'Bid amount must be a positive number' });
    }
    if (isNaN(application.estimatedDuration) || application.estimatedDuration <= 0) {
      return res.status(400).json({ error: 'Estimated duration must be a positive integer' });
    }

    console.log('Adding application:', application);
    job.applications.push(application);
    await job.save();
    console.log('Job saved with application, total applications:', job.applications.length);

    // Create notification for client
    const notification = new Notification({
      user: job.client,
      type: 'job_application',
      title: 'New Job Application',
      message: `You have received a new application for "${job.title}" from ${req.user.username}.`,
      data: {
        jobId: job._id,
        jobTitle: job.title,
        talentId: req.user.id,
        talentName: req.user.username
      }
    });
    await notification.save();

    await job.populate('client', 'username email profile stats');
    await job.populate('applications.talent', 'username email profile stats');

    res.json({ 
      message: 'Application submitted successfully', 
      job
    });
  } catch (error) {
    console.error('Error applying to job:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// @route   PUT /api/jobs/:id
// @desc    Update a job
// @access  Private (Job owner only)
router.put('/:id', auth, upload.single('image'), async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if user is the job owner
    if (job.client.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this job' });
    }

    // Handle image upload if provided (optional for jobs)
    let imageUrl = job.imageUrl; // Keep existing image if no new one uploaded
    if (req.file) {
      try {
        const uploadResult = await uploadImage(req.file, { folder: 'workloob/jobs' });
        imageUrl = uploadResult.url;
      } catch (uploadError) {
        console.error('Image upload error:', uploadError);
        return res.status(500).json({ error: 'Failed to upload job image' });
      }
    }

    // Parse JSON fields if they come as strings
    let budget = req.body.budget;
    if (typeof budget === 'string') {
      try {
        budget = JSON.parse(budget);
      } catch (e) {
        budget = job.budget; // Keep existing budget if parse fails
      }
    }

    // Parse arrays from FormData
    let requirements = req.body.requirements;
    if (typeof requirements === 'string') {
      try {
        requirements = JSON.parse(requirements);
      } catch (e) {
        requirements = job.requirements;
      }
    }

    let deliverables = req.body.deliverables;
    if (typeof deliverables === 'string') {
      try {
        deliverables = JSON.parse(deliverables);
      } catch (e) {
        deliverables = job.deliverables;
      }
    }

    let skills = req.body.skills;
    if (typeof skills === 'string') {
      try {
        skills = JSON.parse(skills);
      } catch (e) {
        skills = job.skills;
      }
    }

    const jobData = {
      ...req.body,
      budget: budget || job.budget,
      requirements: requirements || job.requirements,
      deliverables: deliverables || job.deliverables,
      skills: skills || job.skills
    };

    // Add imageUrl only if provided (or keep existing)
    if (imageUrl) {
      jobData.imageUrl = imageUrl;
    }

    const updatedJob = await Job.findByIdAndUpdate(
      req.params.id,
      { $set: jobData },
      { new: true }
    ).populate('client', 'username email profile stats');

    res.json(updatedJob);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   DELETE /api/jobs/:id
// @desc    Delete a job
// @access  Private (Job owner only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if user is the job owner
    if (job.client.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this job' });
    }

    await Job.findByIdAndDelete(req.params.id);
    res.json({ message: 'Job deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/search
// @desc    Search jobs
// @access  Public
router.get('/search', async (req, res) => {
  try {
    const { q, category, type, location, skills } = req.query;

    const query = { isActive: true, status: 'open' };

    if (q) {
      query.$text = { $search: q };
    }

    if (category) {
      query.category = category;
    }

    if (type) {
      query.type = type;
    }

    if (location) {
      if (location === 'remote') {
        query['location.remote'] = true;
      } else {
        query['location.city'] = new RegExp(location, 'i');
      }
    }

    if (skills) {
      const skillsArray = skills.split(',').map(skill => skill.trim());
      query.skills = { $in: skillsArray };
    }

    const jobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json(jobs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/my-jobs
// @desc    Get user's posted jobs
// @access  Private (Client only)
router.get('/my-jobs', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search,
      category,
      type,
      status
    } = req.query;

    const query = { client: req.user.id };

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    if (type) {
      // Handle "others" type - show part-time and contract (exclude freelance and full-time)
      if (type === 'others') {
        query.type = { $in: ['part-time', 'contract'] };
      } else {
        query.type = type;
      }
    }

    if (status) {
      query.status = status;
    }

    const jobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .populate('applications.talent', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    // Add application status counts to each job
    const jobsWithCounts = jobs.map(job => {
      const jobObj = job.toObject ? job.toObject() : job;
      const completedCount = job.applications.filter(app => app.status === 'completed').length;
      const activeCount = job.applications.filter(app => 
        app.status === 'accepted' || app.status === 'in-progress'
      ).length;
      const pendingCount = job.applications.filter(app => app.status === 'pending').length;
      const rejectedCount = job.applications.filter(app => app.status === 'rejected').length;
      return {
        ...jobObj,
        applicationStatusCounts: {
          completed: completedCount,
          active: activeCount,
          pending: pendingCount,
          rejected: rejectedCount
        }
      };
    });

    const total = await Job.countDocuments(query);

    res.json({
      jobs: jobsWithCounts,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/my-freelance-jobs
// @desc    Get user's freelance job applications
// @access  Private (Talent only)
router.get('/my-freelance-jobs', auth, async (req, res) => {
  try {
    console.log('Fetching freelance jobs for user:', req.user.id);
    const {
      page = 1,
      limit = 10,
      search,
      category,
      status
    } = req.query;

    const query = {
      type: 'freelance', // Only freelance jobs, not part-time or contract
      'applications.talent': req.user.id
    };
    console.log('Freelance jobs query:', query);

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    const jobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .populate('applications.talent', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Job.countDocuments(query);

    res.json({
      jobs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/my-fulltime-jobs
// @desc    Get user's full-time job applications
// @access  Private (Talent only)
router.get('/my-fulltime-jobs', auth, async (req, res) => {
  try {
    console.log('Fetching full-time jobs for user:', req.user.id);
    const {
      page = 1,
      limit = 10,
      search,
      category,
      status
    } = req.query;

    const query = {
      type: 'full-time',
      'applications.talent': req.user.id
    };
    console.log('Full-time jobs query:', query);

    if (search) {
      query.$text = { $search: search };
    }

    if (category) {
      query.category = category;
    }

    const jobs = await Job.find(query)
      .populate('client', 'username email profile stats')
      .populate('applications.talent', 'username email profile stats')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .exec();

    const total = await Job.countDocuments(query);

    res.json({
      jobs,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   GET /api/jobs/:id/applications
// @desc    Get job applications
// @access  Private (Job owner only)
router.get('/:id/applications', auth, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).populate('applications.talent', 'username email profile stats');
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if user is the job owner
    if (job.client.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to view applications' });
    }

    // Find chat IDs for all non-pending statuses (accepted, in-progress, completed)
    const Chat = require('../models/Chat');
    const applicationsWithChats = await Promise.all(job.applications.map(async (application) => {
      const appObj = application.toObject();
      // Find chat for all non-pending statuses (accepted, in-progress, completed)
      if (application.status !== 'pending' && application.status !== 'rejected') {
        // First try to use stored chatId if available
        if (application.chatId) {
          appObj.chatId = application.chatId.toString();
        } else if (application.approvedAt) {
          // Fallback: Find chat created around the time this application was approved
          const chatQuery = {
            job: job._id,
            type: 'job',
            'participants.user': { $all: [job.client, application.talent] },
            createdAt: {
              $gte: new Date(application.approvedAt.getTime() - 60000), // 1 minute before
              $lte: new Date(application.approvedAt.getTime() + 60000)  // 1 minute after
            }
          };
          const chat = await Chat.findOne(chatQuery)
            .sort({ createdAt: -1 })
            .select('_id')
            .limit(1);
          if (chat) {
            appObj.chatId = chat._id;
          }
        }
      }
      return appObj;
    }));

    // Add application status counts to job
    const jobObj = job.toObject ? job.toObject() : job;
    const completedCount = job.applications.filter(app => app.status === 'completed').length;
    const activeCount = job.applications.filter(app => 
      app.status === 'accepted' || app.status === 'in-progress'
    ).length;
    const pendingCount = job.applications.filter(app => app.status === 'pending').length;
    const rejectedCount = job.applications.filter(app => app.status === 'rejected').length;
    
    jobObj.applicationStatusCounts = {
      completed: completedCount,
      active: activeCount,
      pending: pendingCount,
      rejected: rejectedCount
    };

    res.json({ 
      job: jobObj,
      applications: applicationsWithChats 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/jobs/:id/applications/:appId/approve
// @desc    Approve job application
// @access  Private (Job owner only)
router.post('/:id/applications/:appId/approve', auth, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if user is the job owner
    if (job.client.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to approve applications' });
    }

    const application = job.applications.id(req.params.appId);
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Update application status
    application.status = 'accepted';
    application.approvedAt = new Date();
    
    // Create chat between client and talent (each application gets its own chat)
    const chat = new Chat({
      participants: [
        { user: job.client, role: 'client', participantType: 'owner' },
        { user: application.talent, role: 'talent', participantType: 'owner' }
      ],
      type: 'job',
      job: job._id,
      status: 'active',
      workflowStatus: 'offered',
      price: {
        original: application.bidAmount,
        current: application.bidAmount,
        currency: 'USD'
      }
    });
    
    // Set unread count after saving
    chat.unreadCount.set(job.client.toString(), 0);
    chat.unreadCount.set(application.talent.toString(), 1);
    
    await chat.save();
    
    // Store chat ID in the application (if the application schema supports it)
    // Note: Since applications are embedded, we'll store it in a custom field
    if (!application.chatId) {
      application.chatId = chat._id;
    }
    
    await job.save();

    // Add initial message with application details
    const applicationDetails = `
**Application Approved!** ✅

**Job:** ${job.title}
**Your Application:**
- Cover Letter: ${application.coverLetter || 'No cover letter provided'}
- Bid Amount: $${application.bidAmount || 'Negotiable'}
- Estimated Duration: ${application.estimatedDuration || 'Not specified'} days

Let's discuss the project details and next steps!
    `.trim();
    
    const message = new Message({
      chatId: chat._id,
      senderId: job.client,
      content: applicationDetails,
      type: 'text'
    });

    // Create notification for talent
    const notification = new Notification({
      user: application.talent,
      type: 'job_approved',
      title: 'Application Approved!',
      message: `Your application for "${job.title}" has been approved by the client.`,
      data: {
        jobId: job._id,
        jobTitle: job.title,
        chatId: chat._id
      }
    });

    await chat.save();
    await Promise.all([message.save(), notification.save()]);

    // Emit socket event for real-time updates
    const io = req.app.get('io');
    if (io) {
      io.emit('application:approved', {
        jobId: job._id.toString(),
        applicationId: application._id.toString(),
        chatId: chat._id.toString()
      });
      io.emit('job:updated', {
        jobId: job._id.toString(),
        _id: job._id.toString()
      });
    }

    res.json({ message: 'Application approved successfully', chat: chat._id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   POST /api/jobs/:id/applications/:appId/reject
// @desc    Reject job application
// @access  Private (Job owner only)
router.post('/:id/applications/:appId/reject', auth, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if user is the job owner
    if (job.client.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to reject applications' });
    }

    const application = job.applications.id(req.params.appId);
    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    // Update application status
    application.status = 'rejected';
    application.rejectedAt = new Date();
    await job.save();

    // Emit socket event for real-time updates
    const io = req.app.get('io');
    if (io) {
      io.emit('application:rejected', {
        jobId: job._id.toString(),
        applicationId: application._id.toString()
      });
      io.emit('job:updated', {
        jobId: job._id.toString(),
        _id: job._id.toString()
      });
    }

    res.json({ message: 'Application rejected' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/jobs/:id/archive
// @desc    Archive a job
// @access  Private (Job owner only)
router.put('/:id/archive', auth, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if user is the job owner
    if (job.client.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to archive this job' });
    }

    job.status = 'archived';
    await job.save();

    res.json({ message: 'Job archived successfully', job });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/jobs/:id/unarchive
// @desc    Unarchive a job
// @access  Private (Job owner only)
router.put('/:id/unarchive', auth, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if user is the job owner
    if (job.client.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to unarchive this job' });
    }

    job.status = 'open';
    await job.save();

    res.json({ message: 'Job unarchived successfully', job });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;