const express = require('express');
const router = express.Router();
const Job = require('../models/Job');
const Gig = require('../models/Gig');
const User = require('../models/User');

// @route   GET /api/search
// @desc    Unified search across jobs, gigs, and users
// @access  Public
router.get('/', async (req, res) => {
  try {
    const { q: query, limit = 10 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.json({
        jobs: [],
        gigs: [],
        users: []
      });
    }

    const searchQuery = query.trim();
    const searchLimit = Math.min(parseInt(limit), 20); // Max 20 results per category

    // Search Jobs
    const jobQuery = {
      isActive: true,
      status: { $ne: 'archived' },
      $or: [
        { title: { $regex: searchQuery, $options: 'i' } },
        { description: { $regex: searchQuery, $options: 'i' } },
        { category: { $regex: searchQuery, $options: 'i' } },
        { skills: { $in: [new RegExp(searchQuery, 'i')] } }
      ]
    };

    const jobs = await Job.find(jobQuery)
      .populate('client', 'username profile')
      .select('title description category type budget status createdAt client')
      .sort({ createdAt: -1 })
      .limit(searchLimit);

    // Search Gigs
    const gigQuery = {
      isActive: true,
      status: { $ne: 'archived' },
      $or: [
        { title: { $regex: searchQuery, $options: 'i' } },
        { description: { $regex: searchQuery, $options: 'i' } },
        { category: { $regex: searchQuery, $options: 'i' } },
        { skills: { $in: [new RegExp(searchQuery, 'i')] } }
      ]
    };

    const gigs = await Gig.find(gigQuery)
      .populate('talent', 'username profile')
      .select('title description category pricing status createdAt talent')
      .sort({ createdAt: -1 })
      .limit(searchLimit);

    // Search Users
    const userQuery = {
      isActive: true,
      $or: [
        { username: { $regex: searchQuery, $options: 'i' } },
        { 'profile.firstName': { $regex: searchQuery, $options: 'i' } },
        { 'profile.lastName': { $regex: searchQuery, $options: 'i' } },
        { 'profile.skills': { $regex: searchQuery, $options: 'i' } },
        { 'profile.bio': { $regex: searchQuery, $options: 'i' } }
      ]
    };

    const users = await User.find(userQuery)
      .select('username profile stats role')
      .sort({ 'stats.rating': -1, createdAt: -1 })
      .limit(searchLimit);

    // Format results
    const formattedJobs = jobs.map(job => ({
      id: job._id,
      type: 'job',
      title: job.title,
      description: job.description?.substring(0, 100) + (job.description?.length > 100 ? '...' : ''),
      category: job.category,
      jobType: job.type,
      budget: job.budget,
      status: job.status,
      client: job.client?.username || 'Unknown',
      createdAt: job.createdAt
    }));

    const formattedGigs = gigs.map(gig => ({
      id: gig._id,
      type: 'gig',
      title: gig.title,
      description: gig.description?.substring(0, 100) + (gig.description?.length > 100 ? '...' : ''),
      category: gig.category,
      pricing: gig.pricing,
      status: gig.status,
      talent: gig.talent?.username || 'Unknown',
      createdAt: gig.createdAt
    }));

    const formattedUsers = users.map(user => ({
      id: user._id,
      type: 'user',
      username: user.username,
      firstName: user.profile?.firstName || '',
      lastName: user.profile?.lastName || '',
      avatar: user.profile?.avatar,
      role: user.role,
      rating: user.stats?.rating || 0,
      skills: user.profile?.skills || []
    }));

    res.json({
      jobs: formattedJobs,
      gigs: formattedGigs,
      users: formattedUsers,
      total: formattedJobs.length + formattedGigs.length + formattedUsers.length
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
