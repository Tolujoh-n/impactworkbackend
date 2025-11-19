/**
 * Script to clean up users with null email values
 * This helps fix the duplicate key error for email unique index
 * Run this script if you're experiencing E11000 duplicate key errors on email: null
 * 
 * Usage: node scripts/cleanupNullEmails.js
 */

const mongoose = require('mongoose');
const User = require('../models/User');
require('dotenv').config();

const cleanupNullEmails = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/workloob';
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB');

    // Find all users with null or empty email that have wallet addresses
    // This includes users where email field exists but is null
    const usersWithNullEmail = await User.find({
      walletAddress: { $exists: true, $ne: null, $ne: '' }
    }).select('username email walletAddress');

    console.log(`Found ${usersWithNullEmail.length} users with wallet addresses`);

    // Update users to unset email field completely if it's null/empty
    let updated = 0;
    for (const user of usersWithNullEmail) {
      // Check if email is null, undefined, empty, or doesn't exist
      if (!user.email || user.email === null || user.email === '' || user.email === undefined) {
        // First, try $unset to remove the field
        await User.updateOne(
          { _id: user._id },
          { $unset: { email: "" } }
        );
        
        // Also try using raw MongoDB to ensure it's removed
        await User.collection.updateOne(
          { _id: user._id },
          { $unset: { email: "" } }
        );
        
        updated++;
        console.log(`Updated user ${user.username} (${user._id}) - removed email field`);
      }
    }

    console.log(`\nCleanup complete! Updated ${updated} users.`);

    // Verify cleanup - check for any users with wallet addresses that still have null/empty email
    const allWalletUsers = await User.find({
      walletAddress: { $exists: true, $ne: null, $ne: '' }
    }).select('email');
    
    const stillHasEmail = allWalletUsers.filter(u => u.email !== undefined && u.email !== null && u.email !== '').length;
    const hasNullEmail = allWalletUsers.length - stillHasEmail;
    
    console.log(`\nVerification:`);
    console.log(`  Total wallet users: ${allWalletUsers.length}`);
    console.log(`  Users with valid email: ${stillHasEmail}`);
    console.log(`  Users without email (should be OK): ${hasNullEmail}`);
    
    // Final check for any users that still have email: null in the database
    const problematicUsers = await User.find({
      email: null,
      walletAddress: { $exists: true, $ne: null }
    });
    console.log(`  Users with email:null in DB (problematic): ${problematicUsers.length}`);
    
    // Force remove email:null from ALL wallet users using raw MongoDB
    if (problematicUsers.length > 0) {
      console.log('\nForce removing email:null from all wallet users...');
      const result = await User.collection.updateMany(
        { 
          email: null,
          walletAddress: { $exists: true, $ne: null }
        },
        { $unset: { email: "" } }
      );
      console.log(`  Removed email field from ${result.modifiedCount} users`);
      
      // Verify again
      const remaining = await User.collection.countDocuments({
        email: null,
        walletAddress: { $exists: true, $ne: null }
      });
      console.log(`  Remaining users with email:null: ${remaining}`);
    }

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  }
};

// Run the cleanup
cleanupNullEmails();

