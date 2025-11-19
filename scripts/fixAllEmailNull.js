/**
 * Script to remove email field from all wallet users (whether null, undefined, or empty)
 */

const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

const fixAllEmailNull = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/workloob';
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Find all users with wallet addresses
    const walletUsers = await User.collection.find({
      walletAddress: { $exists: true, $ne: null, $ne: '' }
    }).toArray();

    console.log(`Found ${walletUsers.length} users with wallet addresses\n`);

    // Remove email field from ALL wallet users, one at a time to avoid unique constraint issues
    console.log('Removing email field from all wallet users (one at a time)...');
    let fixed = 0;
    for (const user of walletUsers) {
      try {
        // Update one at a time to avoid unique constraint conflicts
        await User.collection.updateOne(
          { _id: user._id },
          { $unset: { email: "" } }
        );
        fixed++;
        console.log(`  Fixed user: ${user.username}`);
      } catch (error) {
        console.error(`  Error fixing user ${user.username}:`, error.message);
      }
    }
    console.log(`\nFixed ${fixed} wallet users`);
    
    // Also remove email: null from other users, one at a time
    const allNullEmailUsers = await User.collection.find({ email: null }).toArray();
    let fixed2 = 0;
    for (const user of allNullEmailUsers) {
      try {
        await User.collection.updateOne(
          { _id: user._id },
          { $unset: { email: "" } }
        );
        fixed2++;
      } catch (error) {
        // Skip if it fails
      }
    }
    console.log(`Removed email:null from ${fixed2} additional users`);

    console.log(`\nFixed ${fixed} users`);

    // Verify - check for any remaining email: null
    const remainingNull = await User.collection.countDocuments({ email: null });
    const remainingWithWallet = await User.collection.countDocuments({
      walletAddress: { $exists: true, $ne: null },
      email: { $exists: true }
    });

    console.log(`Remaining users with email:null: ${remainingNull}`);
    console.log(`Wallet users that still have email field: ${remainingWithWallet}`);

    await mongoose.disconnect();
    console.log('Done!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

fixAllEmailNull();

