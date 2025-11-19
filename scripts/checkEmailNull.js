/**
 * Script to check users with email: null
 */

const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

const checkEmailNull = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/workloob';
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Find all users with email: null
    const users = await User.collection.find({ email: null }).toArray();
    console.log(`Found ${users.length} users with email: null\n`);

    users.forEach(user => {
      console.log(`User: ${user.username}`);
      console.log(`  ID: ${user._id}`);
      console.log(`  Email: ${user.email}`);
      console.log(`  WalletAddress: ${user.walletAddress || 'none'}`);
      console.log(`  Has walletAddress field: ${user.walletAddress !== undefined}`);
      console.log('');
    });

    // Try to remove email from ALL users with email: null (regardless of wallet)
    if (users.length > 0) {
      console.log('Removing email field from all users with email: null...');
      const result = await User.collection.updateMany(
        { email: null },
        { $unset: { email: "" } }
      );
      console.log(`Fixed ${result.modifiedCount} users`);
    }

    // Verify
    const remaining = await User.collection.countDocuments({ email: null });
    console.log(`Remaining users with email:null: ${remaining}`);

    await mongoose.disconnect();
    console.log('Done!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

checkEmailNull();

