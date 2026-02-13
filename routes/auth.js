const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');

const router = express.Router();

// Helper function to generate token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: '7d'
  });
};

// @route   POST /api/auth/register-email
// @desc    Register a new user with email and password
// @access  Public
router.post('/register-email', [
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('email').isEmail().withMessage('Please enter a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, email, password, referredBy } = req.body;

    // Normalize inputs
    const trimmedUsername = username.trim();
    const normalizedEmail = email.trim().toLowerCase();

    // Check if user already exists
    const existingUsername = await User.findOne({ 
      $expr: { $eq: [{ $toLower: "$username" }, trimmedUsername.toLowerCase()] }
    });

    const existingEmail = await User.findOne({ email: normalizedEmail });

    if (existingUsername) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    if (existingEmail) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Find referrer if provided
    let referrer = null;
    if (referredBy) {
      referrer = await User.findOne({ 'referral.referralCode': referredBy });
    }

    // Generate referral code for new user
    const referralCode = trimmedUsername + Math.random().toString(36).substr(2, 6).toUpperCase();

    // Create new user with email and password
    const userData = {
      username: trimmedUsername,
      email: normalizedEmail,
      password: password,
      referral: {
        referralCode: referralCode,
        referredBy: referrer?._id || null,
        referrals: [],
        referralBonus: 0,
        lobTokens: {
          pending: 0,
          available: 0,
          withdrawn: 0
        }
      }
    };

    const newUser = new User(userData);

    try {
      await newUser.save();
    } catch (saveError) {
      console.error('User save error:', saveError);
      
      if (saveError.code === 11000) {
        const field = Object.keys(saveError.keyPattern || {})[0];
        if (field === 'username') {
          return res.status(400).json({ error: 'Username already exists' });
        } else if (field === 'email') {
          return res.status(400).json({ error: 'Email already exists' });
        }
      }
      
      if (saveError.name === 'ValidationError') {
        const validationErrors = Object.keys(saveError.errors || {}).map(key => {
          return saveError.errors[key].message;
        });
        return res.status(400).json({ error: validationErrors.join(', ') });
      }
      
      throw saveError;
    }

    // Handle referral - create pending referral (not approved yet)
    if (referrer) {
      const Referral = require('../models/Referral');
      
      // Create pending referral record
      const referral = new Referral({
        referrer: referrer._id,
        referredUser: newUser._id,
        bonusEarned: 10, // USD bonus (legacy)
        lobTokens: 100, // LOB tokens to be awarded on approval
        activityPoints: 5, // Activity points to be awarded on approval
        status: 'pending'
      });
      await referral.save();

      // Update referrer's referral list and pending LOB tokens
      referrer.referral.referrals.push(newUser._id);
      referrer.referral.lobTokens.pending += 100;
      await referrer.save();
    }

    const token = generateToken(newUser._id);

    res.status(201).json({
      token,
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        walletAddress: newUser.walletAddress,
        connectedWalletAddress: newUser.connectedWalletAddress,
        role: newUser.role,
        profile: newUser.profile,
        stats: newUser.stats,
        wallet: newUser.wallet
      },
      loginMethod: 'email'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// @route   POST /api/auth/register-wallet
// @desc    Register a new user with wallet address
// @access  Public
router.post('/register-wallet', [
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('walletAddress').matches(/^0x[a-fA-F0-9]{40}$/).withMessage('Please enter a valid wallet address')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, walletAddress, referredBy } = req.body;

    // Normalize inputs
    const trimmedUsername = username.trim();
    const normalizedWallet = walletAddress.trim().toLowerCase();

    // Check if user already exists
    const existingUsername = await User.findOne({ 
      $expr: { $eq: [{ $toLower: "$username" }, trimmedUsername.toLowerCase()] }
    });

    const existingWallet = await User.findOne({ 
        $expr: { $eq: [{ $toLower: "$walletAddress" }, normalizedWallet] }
      });

    if (existingUsername) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    if (existingWallet) {
      return res.status(400).json({ error: 'Wallet address already registered' });
    }

    // Find referrer if provided
    let referrer = null;
    if (referredBy) {
      referrer = await User.findOne({ 'referral.referralCode': referredBy });
    }

    // Helper function to create wallet user document (without email/password)
    const createWalletUserDocument = () => {
      const referralCode = trimmedUsername + Math.random().toString(36).substr(2, 6).toUpperCase();
      return {
        username: trimmedUsername,
        walletAddress: normalizedWallet,
        referral: {
          referralCode: referralCode,
          referredBy: referrer?._id || null,
          referrals: [],
          referralBonus: 0,
          lobTokens: {
            pending: 0,
            available: 0,
            withdrawn: 0
          }
        },
        role: 'talent',
        isActive: true,
        profile: {},
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
        preferences: {
          theme: 'light',
          notifications: { email: true, push: true, chat: true }
        },
        lastSeen: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
        // CRITICAL: email and password fields are NOT included
      };
    };

    console.log('=== WALLET REGISTRATION DEBUG ===');
    console.log('Username:', trimmedUsername);
    console.log('WalletAddress:', normalizedWallet);
    console.log('Referrer:', referrer ? referrer._id : 'none');

    let newUser;
    let saveSuccessful = false;
    
    try {
      // Use direct MongoDB insert to bypass Mongoose field initialization
      // This ensures email field is NEVER included in the document
      const documentToInsert = createWalletUserDocument();
      
      console.log('Inserting wallet user directly into MongoDB (email field will NOT be included)...');
      const insertResult = await User.collection.insertOne(documentToInsert);
      console.log('Document inserted successfully! ID:', insertResult.insertedId);
      
      // Fetch the saved user using Mongoose
      newUser = await User.findById(insertResult.insertedId);
      if (!newUser) {
        throw new Error('Failed to retrieve created user');
      }
      
      saveSuccessful = true;
      console.log('User created successfully!');
    } catch (saveError) {
      console.error('=== SAVE ERROR DETAILS ===');
      console.error('Error name:', saveError.name);
      console.error('Error code:', saveError.code);
      console.error('Error message:', saveError.message);
      console.error('Key pattern:', saveError.keyPattern);
      console.error('Key value:', saveError.keyValue);
      
      // Handle email duplicate key error - clean up and retry
      if (saveError.code === 11000) {
        const field = Object.keys(saveError.keyPattern || {})[0];
        
        if (field === 'email') {
          console.error('ERROR: Email duplicate key error - cleaning up existing null emails...');
          
          try {
            // Clean up ALL users with email: null (using raw MongoDB)
            const cleanupResult = await User.collection.updateMany(
              { email: null },
              { $unset: { email: "" } }
            );
            console.log(`Cleanup: Removed email from ${cleanupResult.modifiedCount} users`);
            
            // Also clean up wallet users specifically
            await User.collection.updateMany(
              { 
                walletAddress: { $exists: true, $ne: null },
                email: { $exists: true }
              },
              { $unset: { email: "" } }
            );
            
            // Retry creating the user using insertOne
            console.log('Retrying user creation after cleanup...');
            const documentToInsert = createWalletUserDocument();
            const insertResult = await User.collection.insertOne(documentToInsert);
            newUser = await User.findById(insertResult.insertedId);
            if (!newUser) {
              throw new Error('Failed to retrieve created user after retry');
            }
            saveSuccessful = true;
            console.log('User created successfully after cleanup!');
          } catch (retryError) {
            console.error('Retry failed:', retryError);
            saveError = retryError;
          }
        } else if (field === 'username') {
          return res.status(400).json({ error: 'Username already exists' });
        } else if (field === 'walletAddress') {
          return res.status(400).json({ error: 'Wallet address already registered' });
        }
      }
      
      // If save still failed, handle other errors
      if (!saveSuccessful) {
        if (saveError.errors && saveError.name === 'ValidationError') {
          const validationErrors = Object.keys(saveError.errors).map(key => {
            return saveError.errors[key].message;
          });
          return res.status(400).json({ error: validationErrors.join(', ') });
        }
        
        console.error('Final save error:', saveError);
        return res.status(500).json({ 
          error: 'Registration failed. Please try again.',
          details: process.env.NODE_ENV === 'development' ? saveError.message : undefined
        });
      }
    }
    
    // No cleanup needed - insertOne ensures email field is never included

    // Handle referral - create pending referral (not approved yet)
    if (referrer) {
      const Referral = require('../models/Referral');
      
      // Create pending referral record
      const referral = new Referral({
        referrer: referrer._id,
        referredUser: newUser._id,
        bonusEarned: 10, // USD bonus (legacy)
        lobTokens: 100, // LOB tokens to be awarded on approval
        activityPoints: 5, // Activity points to be awarded on approval
        status: 'pending'
      });
      await referral.save();

      // Update referrer's referral list and pending LOB tokens
      referrer.referral.referrals.push(newUser._id);
      referrer.referral.lobTokens.pending += 100;
      await referrer.save();
    }

    const token = generateToken(newUser._id);

    res.status(201).json({
      token,
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        walletAddress: newUser.walletAddress,
        connectedWalletAddress: newUser.connectedWalletAddress,
        role: newUser.role,
        profile: newUser.profile,
        stats: newUser.stats,
        wallet: newUser.wallet
      },
      loginMethod: 'wallet'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Legacy register endpoint removed - use /register-email or /register-wallet instead

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', [
  body('identifier').notEmpty().withMessage('Email or wallet address is required'),
  body('password').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { identifier, password } = req.body;

    // Normalize identifier for case-insensitive lookup
    const normalizedIdentifier = identifier.toLowerCase().trim();

    // Find user by email or wallet address (case-insensitive)
    const user = await User.findOne({
      $or: [
        { email: normalizedIdentifier },
        { $expr: { $eq: [{ $toLower: "$walletAddress" }, normalizedIdentifier] } }
      ]
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Get normalized values from user document for comparison
    const normalizedEmail = user.email ? user.email.toLowerCase().trim() : null;
    const normalizedWallet = user.walletAddress ? user.walletAddress.toLowerCase().trim() : null;

    // Check if identifier matches email or wallet address
    const isEmailLogin = normalizedEmail === normalizedIdentifier;
    const isWalletLogin = normalizedWallet === normalizedIdentifier;

    // If logging in with wallet address, password is NOT required (wallet-only login)
    if (isWalletLogin) {
      // Wallet login - no password needed, allow login to proceed
      // This is the wallet-only login flow
    } 
    // If logging in with email, password is required (if user has password)
    else if (isEmailLogin) {
      if (user.password && !password) {
        return res.status(400).json({ error: 'Password is required for email login' });
      }
      if (user.password && password) {
        // Email login with password - verify it
        const isPasswordValid = await user.comparePassword(password);
        if (!isPasswordValid) {
          return res.status(400).json({ error: 'Invalid credentials' });
        }
      }
      // If user doesn't have password but logging in with email, this is an edge case
      // Allow it to proceed (though this shouldn't happen with current schema)
    } 
    // This shouldn't happen, but handle it gracefully
    else {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Update last seen
    user.lastSeen = new Date();
    await user.save();

    const token = generateToken(user._id);

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        walletAddress: user.walletAddress,
        connectedWalletAddress: user.connectedWalletAddress,
        role: user.role,
        profile: user.profile,
        stats: user.stats,
        wallet: user.wallet
      },
      loginMethod: isEmailLogin ? 'email' : 'wallet'
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', require('../middleware/auth').auth, async (req, res) => {
  try {
    // Determine login method: if user has email, they logged in with email; otherwise with wallet
    const loginMethod = req.user.email ? 'email' : 'wallet';
    
    res.json({ 
      user: req.user,
      loginMethod 
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
