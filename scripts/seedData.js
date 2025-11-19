const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Import models
const User = require('../models/User');
const Job = require('../models/Job');
const Gig = require('../models/Gig');
const Transaction = require('../models/Transaction');
const Governance = require('../models/Governance');

// Use categories that match the enum definitions in Job and Gig models
const categories = [
  'web-development',
  'mobile-development',
  'design',
  'writing',
  'marketing',
  'data-science',
  'other'
];

const technologies = [
  'React', 'Node.js', 'Python', 'JavaScript', 'TypeScript', 'Vuejs', 'Angular',
  'Express', 'MongoDB', 'PostgreSQL', 'AWS', 'Docker', 'Kubernetes', 'GraphQL',
  'REST API', 'Microservices', 'Machine Learning', 'Data Science', 'Blockchain'
];

const skills = [
  'Web Development', 'Mobile Development', 'UI/UX Design', 'Data Analysis',
  'Project Management', 'Digital Marketing', 'Content Writing', 'Graphic Design',
  'Video Editing', 'Photography', 'Translation', 'Customer Service',
  'Virtual Assistant', 'Accounting', 'Bookkeeping', 'Sales', 'Research'
];

const jobs = [
  { title: 'React Developer Needed', type: 'freelance', budget: { min: 800, max: 1500 } },
  { title: 'Python Data Analysis Project', type: 'contract', budget: { min: 1200, max: 2500 } },
  { title: 'Full Stack Developer', type: 'full-time', budget: { min: 8000, max: 12000 } },
  { title: 'UI/UX Designer', type: 'part-time', budget: { min: 3000, max: 5000 } },
  { title: 'WordPress Website', type: 'freelance', budget: { min: 500, max: 1200 } },
  { title: 'Mobile App Development', type: 'contract', budget: { min: 2500, max: 5000 } },
  { title: 'Content Writer', type: 'freelance', budget: { min: 300, max: 800 } },
  { title: 'SEO Specialist', type: 'part-time', budget: { min: 1500, max: 3000 } },
  { title: 'DevOps Engineer', type: 'full-time', budget: { min: 10000, max: 15000 } },
  { title: 'Graphic Designer', type: 'freelance', budget: { min: 400, max: 900 } }
];

const gigs = [
  { title: 'I will build a responsive website', type: 'professional', basePrice: 250 },
  { title: 'I will design logo and branding', type: 'professional', basePrice: 150 },
  { title: 'I will write professional content', type: 'professional', basePrice: 50 },
  { title: 'I will fix your plumbing issues', type: 'labour', basePrice: 80 },
  { title: 'I will create custom illustrations', type: 'professional', basePrice: 120 },
  { title: 'I will help with carpentry work', type: 'labour', basePrice: 100 },
  { title: 'I will develop a React app', type: 'professional', basePrice: 800 },
  { title: 'I will provide writing services', type: 'professional', basePrice: 75 },
  { title: 'I will handle electrical repairs', type: 'labour', basePrice: 120 },
  { title: 'I will create video content', type: 'professional', basePrice: 300 }
];

async function seedData() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/workloob');
    console.log('Connected to MongoDB');

    // Clear existing data
    await Promise.all([
      User.deleteMany({}),
      Job.deleteMany({}),
      Gig.deleteMany({}),
      Transaction.deleteMany({}),
      Governance.deleteMany({})
    ]);
    console.log('Cleared existing data');

    // Create users
    const clients = [];
    const talents = [];

    // Create 15 clients
    for (let i = 1; i <= 15; i++) {
      const client = new User({
        username: `client${i}`,
        email: `client${i}@example.com`,
        password: 'password123',
        role: 'client',
        profile: {
          firstName: `Client${i}`,
          lastName: 'Johnson',
          bio: `Experienced business owner looking for talented professionals`,
          location: 'New York, NY',
          skills: [skills[Math.floor(Math.random() * skills.length)]],
          socialLinks: {
            website: `https://client${i}.com`
          }
        },
        wallet: {
          balance: 1000 + Math.random() * 5000
        },
        stats: {
          activityPoints: Math.floor(Math.random() * 100),
          rating: {
            average: 4.5 + Math.random() * 0.5,
            count: Math.floor(Math.random() * 20)
          }
        }
      });
      clients.push(await client.save());
    }

    // Create 25 talents
    for (let i = 1; i <= 25; i++) {
      const talent = new User({
        username: `talent${i}`,
        email: `talent${i}@example.com`,
        password: 'password123',
        role: 'talent',
        profile: {
          firstName: `Talent${i}`,
          lastName: 'Smith',
          bio: `Professional ${technologies[Math.floor(Math.random() * technologies.length)]} developer with ${Math.floor(Math.random() * 10) + 1} years experience`,
          location: 'San Francisco, CA',
          skills: technologies.slice(0, Math.floor(Math.random() * 5) + 2),
          experience: [{
            company: `Company ${i}`,
            position: 'Senior Developer',
            startDate: new Date(2020, 0, 1),
            endDate: null,
            description: 'Led development team',
            current: true
          }]
        },
        wallet: {
          balance: 5000 + Math.random() * 3000
        },
        stats: {
          activityPoints: Math.floor(Math.random() * 150),
          rating: {
            average: 4.0 + Math.random() * 1,
            count: Math.floor(Math.random() * 50)
          },
          jobsCompleted: Math.floor(Math.random() * 20)
        }
      });
      talents.push(await talent.save());
    }

    console.log('Created users');

    // Create jobs
    for (let i = 0; i < jobs.length; i++) {
      const jobData = jobs[i];
      const client = clients[Math.floor(Math.random() * clients.length)];
      
      const job = new Job({
        client: client._id,
        title: jobData.title,
        description: `Detailed project description for ${jobData.title}. Looking for a skilled professional to complete this task with high quality standards.`,
        category: categories[Math.floor(Math.random() * categories.length)],
        type: jobData.type,
        budget: jobData.budget,
        duration: {
          value: Math.floor(Math.random() * 30) + 1,
          unit: 'days'
        },
        skills: technologies.slice(0, Math.floor(Math.random() * 3) + 1),
        requirements: ['Professional work', 'Timely delivery', 'Good communication'],
        deliverables: ['Source code', 'Documentation', 'Testing report'],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });

      // Add some applications
      const numApplications = Math.floor(Math.random() * 5);
      for (let j = 0; j < numApplications; j++) {
        const talent = talents[Math.floor(Math.random() * talents.length)];
        job.applications.push({
          talent: talent._id,
          coverLetter: `I'm interested in this ${job.title} project`,
          bidAmount: jobData.budget.min + Math.random() * (jobData.budget.max - jobData.budget.min),
          estimatedDuration: Math.floor(Math.random() * 15) + 5
        });
      }

      await job.save();
    }

    console.log('Created jobs');

    // Create gigs
    for (let i = 0; i < gigs.length; i++) {
      const gigData = gigs[i];
      const talent = talents[Math.floor(Math.random() * talents.length)];
      
      const gig = new Gig({
        talent: talent._id,
        title: gigData.title,
        description: `Professional ${gigData.title.toLowerCase()} services`,
        category: categories[Math.floor(Math.random() * categories.length)],
        type: gigData.type,
        packages: [
          {
            name: 'Basic',
            description: 'Basic package',
            price: gigData.basePrice,
            deliveryTime: { value: 3, unit: 'days' },
            features: ['Quality work', 'Fast delivery']
          },
          {
            name: 'Standard',
            description: 'Standard package',
            price: gigData.basePrice * 1.5,
            deliveryTime: { value: 5, unit: 'days' },
            features: ['Quality work', 'Fast delivery', 'Revisions included']
          },
          {
            name: 'Premium',
            description: 'Premium package',
            price: gigData.basePrice * 2,
            deliveryTime: { value: 7, unit: 'days' },
            features: ['Quality work', 'Fast delivery', 'Revisions included', 'Priority support']
          }
        ],
        skills: [skills[Math.floor(Math.random() * skills.length)]],
        pricing: { 
          basic: gigData.basePrice,
          standard: gigData.basePrice * 1.5,
          premium: gigData.basePrice * 2,
          min: gigData.basePrice,
          max: gigData.basePrice * 2
        },
        deliveryTime: { value: 5, unit: 'days' },
        location: { 
          remote: Math.random() > 0.3, // 70% remote, 30% local
          city: Math.random() > 0.3 ? ['New York', 'San Francisco', 'London', 'Toronto', 'Berlin'][Math.floor(Math.random() * 5)] : undefined,
          country: ['USA', 'Canada', 'UK', 'Germany', 'Australia'][Math.floor(Math.random() * 5)]
        },
        requirements: 'Please provide detailed requirements'
      });

      await gig.save();
    }

    console.log('Created gigs');

    // Create sample governance proposals
    const governanceTopics = [
      {
        title: 'Platform Fee Reduction',
        description: 'Propose reducing platform fees from 5% to 3%',
        category: 'policy'
      },
      {
        title: 'New Payment Method Integration',
        description: 'Add cryptocurrency payment support',
        category: 'feature'
      },
      {
        title: 'Dispute Resolution Improvement',
        description: 'Enhance mediation process for conflicts',
        category: 'platform'
      }
    ];

    for (const topic of governanceTopics) {
      const proposal = new Governance({
        title: topic.title,
        description: topic.description,
        category: topic.category,
        initiator: talents[Math.floor(Math.random() * talents.length)]._id,
        proposalData: {
          description: topic.description,
          impact: 'Positive impact on user experience',
          implementation: '2-3 months development cycle',
          timeline: 'Q2 2025'
        },
        status: 'voting'
      });

      await proposal.save();
    }

    console.log('Created governance proposals');

    // Create some transactions
    for (let i = 0; i < 50; i++) {
      const user = Math.random() > 0.5 
        ? talents[Math.floor(Math.random() * talents.length)]
        : clients[Math.floor(Math.random() * clients.length)];

      // Use only Transaction types allowed by the Transaction model enum.
      const transactionTypes = ['deposit', 'withdrawal', 'transfer', 'bonus', 'escrow_deposit', 'escrow_release', 'refund'];
      const type = transactionTypes[Math.floor(Math.random() * transactionTypes.length)];

      // Ensure amount is non-negative. Set sensible defaults per type.
      let amount = Math.floor(Math.random() * 1000) + 1; // always >= 1
      let status = 'completed';
      let fromUser = null;
      let toUser = null;

      // Determine from/to users and status based on transaction type
      if (type === 'deposit') {
        toUser = user._id;
        fromUser = null; // external
        status = 'completed';
      } else if (type === 'withdrawal') {
        fromUser = user._id;
        toUser = null; // external
        status = 'pending';
        amount = Math.floor(Math.random() * 500) + 1;
      } else if (type === 'transfer') {
        fromUser = user._id;
        // pick a different user as recipient
        const allUsers = clients.concat(talents);
        let recipient = allUsers[Math.floor(Math.random() * allUsers.length)];
        if (recipient._id.toString() === user._id.toString()) {
          // pick next user if same
          recipient = allUsers[(Math.floor(Math.random() * allUsers.length) + 1) % allUsers.length];
        }
        toUser = recipient._id;
        status = 'completed';
      } else if (type === 'bonus' || type === 'refund' || type === 'escrow_release') {
        toUser = user._id;
        status = 'completed';
      } else if (type === 'escrow_deposit') {
        fromUser = user._id;
        status = 'completed';
      }

      const transaction = new Transaction({
        fromUser,
        toUser,
        type,
        amount,
        status,
        description: `${type.charAt(0).toUpperCase() + type.slice(1)} transaction`,
        reference: `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
      });

      await transaction.save();
    }

    console.log('Created transactions');

    console.log('✅ Database seeded successfully!');
    console.log(`Created ${clients.length} clients and ${talents.length} talents`);
    console.log(`Created ${jobs.length} jobs and ${gigs.length} gigs`);
    console.log('Created governance proposals and sample transactions');

  } catch (error) {
    console.error('Error seeding database:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
}

seedData();
