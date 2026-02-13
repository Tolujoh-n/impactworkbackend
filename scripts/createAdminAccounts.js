const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/workloob';

const adminAccounts = [
  {
    username: 'admin1',
    email: 'admin1@workloob.com',
    password: 'Admin123!@#',
    role: 'admin'
  },
  {
    username: 'admin2',
    email: 'admin2@workloob.com',
    password: 'Admin123!@#',
    role: 'admin'
  },
  {
    username: 'admin3',
    email: 'admin3@workloob.com',
    password: 'Admin123!@#',
    role: 'admin'
  }
];

async function createAdminAccounts() {
  try {
    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    for (const adminData of adminAccounts) {
      // Check if admin already exists
      const existingUser = await User.findOne({
        $or: [
          { username: adminData.username },
          { email: adminData.email }
        ]
      });

      if (existingUser) {
        // Update existing user to admin if not already
        if (existingUser.role !== 'admin') {
          existingUser.role = 'admin';
          if (adminData.password) {
            const salt = await bcrypt.genSalt(12);
            existingUser.password = await bcrypt.hash(adminData.password, salt);
          }
          await existingUser.save();
          console.log(`✓ Updated user "${adminData.username}" to admin role`);
        } else {
          console.log(`⚠ User "${adminData.username}" already exists as admin`);
        }
      } else {
        // Create new admin user
        const salt = await bcrypt.genSalt(12);
        const hashedPassword = await bcrypt.hash(adminData.password, salt);

        const adminUser = new User({
          username: adminData.username,
          email: adminData.email,
          password: hashedPassword,
          role: 'admin',
          isActive: true,
          profile: {
            firstName: adminData.username.charAt(0).toUpperCase() + adminData.username.slice(1),
            lastName: 'Admin'
          },
          stats: {
            activityPoints: 0,
            rating: { average: 0, count: 0, totalScore: 0 },
            jobsOffered: 0,
            jobsInProgress: 0,
            jobsCompleted: 0,
            jobsArchived: 0
          },
          wallet: {
            balance: 1000,
            escrowBalance: 0
          },
          referral: {
            referralCode: adminData.username + Math.random().toString(36).substr(2, 6).toUpperCase(),
            referrals: [],
            referralBonus: 0,
            lobTokens: {
              pending: 0,
              available: 0,
              withdrawn: 0
            }
          },
          preferences: {
            theme: 'light',
            notifications: {
              email: true,
              push: true,
              chat: true
            }
          }
        });

        await adminUser.save();
        console.log(`✓ Created admin account: ${adminData.username}`);
      }
    }

    console.log('\n=== Admin Accounts Created ===');
    console.log('Login credentials:');
    adminAccounts.forEach((admin, index) => {
      console.log(`\nAdmin ${index + 1}:`);
      console.log(`  Username: ${admin.username}`);
      console.log(`  Email: ${admin.email}`);
      console.log(`  Password: ${admin.password}`);
    });

    await mongoose.connection.close();
    console.log('\n✓ Database connection closed');
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin accounts:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

createAdminAccounts();
