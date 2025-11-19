/**
 * Script to forcefully remove email:null from all wallet users
 */

const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

const fixEmailNull = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/workloob';
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Find all users with email: null and wallet addresses
    const problematicUsers = await User.collection.find({
      email: null,
      walletAddress: { $exists: true, $ne: null }
    }).toArray();

    console.log(`Found ${problematicUsers.length} users with email: null`);

    // Remove email field from all of them
    if (problematicUsers.length > 0) {
      const result = await User.collection.updateMany(
        { 
          email: null,
          walletAddress: { $exists: true, $ne: null }
        },
        { $unset: { email: "" } }
      );
      console.log(`Fixed ${result.modifiedCount} users`);
    }

    // Verify
    const remaining = await User.collection.countDocuments({
      email: null,
      walletAddress: { $exists: true, $ne: null }
    });
    console.log(`Remaining users with email:null: ${remaining}`);

    await mongoose.disconnect();
    console.log('Done!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

fixEmailNull();

