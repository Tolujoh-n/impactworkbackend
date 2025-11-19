const express = require('express');
const { body, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const Job = require('../models/Job');
const User = require('../models/User');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Notification = require('../models/Notification');

const router = express.Router();

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

    const query = { isActive: true, status: 'open' };

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
      query.type = type;
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
      type: { $in: ['part-time', 'freelance', 'contract'] },
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
    console.log('Found freelance jobs:', jobs.length, 'Total:', total);

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
    console.log('Found full-time jobs:', jobs.length, 'Total:', total);

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

    res.json(job);
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
  body('title').notEmpty().withMessage('Title is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('category').isIn(['web-development', 'mobile-development', 'design', 'writing', 'marketing', 'data-science', 'other']).withMessage('Invalid category'),
  body('type').isIn(['full-time', 'part-time', 'freelance', 'contract']).withMessage('Invalid type'),
  body('budget').custom((value) => {
    if (!value.fixed && !value.min) {
      throw new Error('Budget information is required');
    }
    return true;
  })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check if user is a client
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'Only clients can create jobs' });
    }

    const jobData = {
      ...req.body,
      client: req.user.id
    };

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
  body('bidAmount').isNumeric().withMessage('Bid amount must be a number'),
  body('estimatedDuration').isNumeric().withMessage('Estimated duration must be a number')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check if user is a talent
    if (req.user.role !== 'talent') {
      return res.status(403).json({ error: 'Only talents can apply to jobs' });
    }

    const job = await Job.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if job is still open
    if (job.status !== 'open') {
      return res.status(400).json({ error: 'Job is no longer accepting applications' });
    }

    // Check if user already applied
    const existingApplication = job.applications.find(app => app.talent.toString() === req.user.id);
    if (existingApplication) {
      return res.status(400).json({ error: 'You have already applied to this job' });
    }

    // Check if user is the job owner
    if (job.client.toString() === req.user.id) {
      return res.status(400).json({ error: 'You cannot apply to your own job' });
    }

    const application = {
      talent: req.user.id,
      coverLetter: req.body.coverLetter,
      bidAmount: req.body.bidAmount,
      estimatedDuration: req.body.estimatedDuration,
      attachments: req.body.attachments || []
    };

    console.log('Adding application:', application);
    job.applications.push(application);
    await job.save();
    console.log('Job saved with application, total applications:', job.applications.length);

    // Create chat between client and talent
    const chat = new Chat({
      participants: [
        { user: job.client, role: 'client' },
        { user: req.user.id, role: 'talent' }
      ],
      type: 'job',
      job: job._id,
      status: 'active'
    });
    await chat.save();

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
        talentName: req.user.username,
        chatId: chat._id
      }
    });
    await notification.save();

    await job.populate('client', 'username email profile stats');
    await job.populate('applications.talent', 'username email profile stats');

    res.json({
      message: 'Application submitted successfully',
      job,
      chatId: chat._id
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

    res.json({ applications: job.applications });
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
    await job.save();

    // Create chat between client and talent
    const chat = new Chat({
      participants: [
        { user: job.client, role: 'client' },
        { user: application.talent, role: 'talent' }
      ],
      type: 'job',
      job: job._id,
      status: 'active',
      unreadCount: new Map([
        [job.client.toString(), 0],
        [application.talent.toString(), 1]
      ])
    });

    // Add initial message
    const message = new Message({
      chat: chat._id,
      sender: job.client,
      content: `Your application for "${job.title}" has been approved! Let's discuss the project details.`,
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

    await Promise.all([chat.save(), message.save(), notification.save()]);

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

    res.json({ message: 'Application rejected' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server error' });
  }
});

// @route   PUT /api/jobs/:id
// @desc    Update a job
// @access  Private (Job owner only)
router.put('/:id', auth, async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Check if user is the job owner
    if (job.client.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to update this job' });
    }

    const updatedJob = await Job.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
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

module.exports = router;
