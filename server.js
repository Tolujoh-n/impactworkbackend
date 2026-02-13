const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
require('dotenv').config();
const cron = require("node-cron");
const { router: ethPriceRouter, updateEthPrice } = require("./routes/ethPrice");

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const jobRoutes = require('./routes/jobs');
const gigRoutes = require('./routes/gigs');
const chatRoutes = require('./routes/chats');
const walletRoutes = require('./routes/wallet');
const governanceRoutes = require('./routes/governance');
const referralRoutes = require('./routes/referral');
const notificationRoutes = require('./routes/notifications');
const deployerRoutes = require('./routes/deployer');
const searchRoutes = require('./routes/search');
const stakingRoutes = require('./routes/staking');
const blogRoutes = require('./routes/blogs');
// ethPrice router is imported above as ethPriceRouter



// Update ETH price every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  console.log("Updating ETH price from CoinGecko...");
  await updateEthPrice();
});

// Fetch once on startup
updateEthPrice();

const app = express();
const server = createServer(app);

// CORS configuration - allowed origins (defined before Socket.IO)
const allowedOrigins = [
  'http://localhost:3000',
  'https://blogs.workloob.com',
  process.env.CLIENT_URL
].filter(Boolean); // Remove any undefined values

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : ["http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Make io available to routes
app.set('io', io);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // In development, allow all origins for flexibility
      if (process.env.NODE_ENV === 'development') {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Disposition']
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Security middleware
app.use(helmet());
app.use(compression());
app.use(mongoSanitize());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// MongoDB connection with keep-alive and connection pooling
const mongoOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: 10, // Maintain up to 10 socket connections
  serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
  socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
  family: 4, // Use IPv4, skip trying IPv6
  heartbeatFrequencyMS: 10000, // Send a ping every 10 seconds to check connection
  retryWrites: true,
  retryReads: true,
};

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/workloobnew', mongoOptions)
.then(() => {
  console.log('Connected to MongoDB');
  
  // Set up connection event handlers
  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected. Attempting to reconnect...');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('MongoDB reconnected');
  });

  mongoose.connection.on('close', () => {
    console.warn('MongoDB connection closed');
  });
})
.catch((err) => {
  console.error('MongoDB initial connection error:', err);
  process.exit(1);
});

// Keep MongoDB connection alive with periodic ping
setInterval(async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      console.log('MongoDB connection ping successful');
    } else {
      console.warn('MongoDB connection not ready, attempting to reconnect...');
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/workloobnew', mongoOptions);
    }
  } catch (error) {
    console.error('MongoDB keep-alive ping failed:', error);
    // Attempt reconnection
    try {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/workloobnew', mongoOptions);
      console.log('MongoDB reconnection successful');
    } catch (reconnectError) {
      console.error('MongoDB reconnection failed:', reconnectError);
    }
  }
}, 30000); // Ping every 30 seconds

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/gigs', gigRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/governance', governanceRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/deployer', deployerRoutes);
app.use('/api/staking', stakingRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/blogs', blogRoutes);
app.use('/api/ethprice', ethPriceRouter);
// Alias route for Escrowintegration.js compatibility
app.use('/api/v1/price', ethPriceRouter);

// Socket.IO for real-time messaging
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join chat room
  socket.on('join-chat', (chatId) => {
    socket.join(chatId);
    console.log(`User ${socket.id} joined chat ${chatId}`);
  });

  // Leave chat room
  socket.on('leave-chat', (chatId) => {
    socket.leave(chatId);
    console.log(`User ${socket.id} left chat ${chatId}`);
  });

  // Handle new message
  socket.on('send-message', async (data) => {
    try {
      const { chatId, senderId, content, type } = data;
      
      // Store message in database
      const Message = require('./models/Message');
      const Chat = require('./models/Chat');
      const Notification = require('./models/Notification');
      
      const message = new Message({
        chatId,
        senderId,
        content,
        type,
        timestamp: new Date()
      });
      await message.save();

      // Update chat's last message and unread counts
      const chat = await Chat.findById(chatId)
        .populate('job', 'title')
        .populate('gig', 'title');
        
      if (chat) {
        // Get sender info for notifications
        const User = require('./models/User');
        const sender = await User.findById(senderId).select('username');
        
        chat.lastMessage = {
          content,
          sender: senderId,
          timestamp: new Date()
        };

        // Increment unread count for all participants except sender and create notifications
        const notificationPromises = [];
        const emailPromises = [];
        const { sendNotificationEmail } = require('./utils/emailService');
        
        // Fetch all recipients to check their preferences
        const recipientIds = chat.participants
          .filter(p => p.user.toString() !== senderId)
          .map(p => p.user);
        
        const recipients = await User.find({ _id: { $in: recipientIds } })
          .select('notificationEmail preferences.notifications');
        
        const recipientMap = new Map();
        recipients.forEach(r => recipientMap.set(r._id.toString(), r));
        
        chat.participants.forEach(participant => {
          if (participant.user.toString() !== senderId) {
            const currentCount = chat.unreadCount.get(participant.user.toString()) || 0;
            chat.unreadCount.set(participant.user.toString(), currentCount + 1);

            const recipient = recipientMap.get(participant.user.toString());
            const shouldSendEmail = recipient?.preferences?.notifications?.email && 
                                   recipient?.preferences?.notifications?.chat &&
                                   recipient?.notificationEmail;

            // Create notification for the recipient
            const notification = new Notification({
              user: participant.user,
              type: 'message',
              title: 'New Message',
              message: `${sender?.username || 'Someone'} sent you a message${chat.job ? ` about "${chat.job.title}"` : chat.gig ? ` about "${chat.gig.title}"` : ''}`,
              data: {
                chatId,
                senderId,
                senderUsername: sender?.username,
                messageId: message._id
              }
            });
            notificationPromises.push(notification.save());

            // Send email if chat notifications are enabled and email notifications are enabled
            if (shouldSendEmail) {
              const actionUrl = `/chats/${chatId}`;
              emailPromises.push(
                sendNotificationEmail({
                  to: recipient.notificationEmail,
                  subject: 'New Message on Workloob',
                  title: 'New Message',
                  message: `${sender?.username || 'Someone'} sent you a message${chat.job ? ` about "${chat.job.title}"` : chat.gig ? ` about "${chat.gig.title}"` : ''}`,
                  actionUrl: actionUrl,
                  actionText: 'View Message'
                }).then(result => {
                  if (!result.success) {
                    console.error('Failed to send email notification:', {
                      to: recipient.notificationEmail,
                      error: result.error,
                      details: result.details
                    });
                  }
                  return result;
                }).catch(err => {
                  console.error('Exception sending email notification:', {
                    to: recipient.notificationEmail,
                    error: err.message,
                    code: err.code,
                    responseCode: err.responseCode
                  });
                  // Don't fail the whole operation if email fails
                  return { success: false, error: err.message };
                })
              );
            } else {
              console.log('Email not sent for user:', {
                userId: recipient._id,
                hasEmail: !!recipient.notificationEmail,
                emailEnabled: recipient?.preferences?.notifications?.email,
                chatEnabled: recipient?.preferences?.notifications?.chat
              });
            }
          }
        });

        await chat.save();
        
        // Save all notifications
        await Promise.all(notificationPromises);
        
        // Send emails (don't await to avoid blocking)
        Promise.all(emailPromises).catch(err => {
          console.error('Error sending email notifications:', err);
        });
        
        // Emit unread count update for all participants except sender
        chat.participants.forEach(participant => {
          if (participant.user.toString() !== senderId) {
            io.emit('unread-count-updated', { userId: participant.user.toString() });
          }
        });
      }

      // Broadcast message to all users in the chat room
      io.to(chatId).emit('new-message', {
        id: message._id,
        chatId,
        senderId,
        content,
        type,
        timestamp: message.timestamp
      });

      console.log(`Message broadcasted to chat ${chatId}:`, {
        id: message._id,
        chatId,
        senderId,
        content: content.substring(0, 50) + '...'
      });

      // Emit notification event
      io.emit('new-notification');
      
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Something went wrong!',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal Server Error'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    uptime: process.uptime()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Helper function to clean environment variable values
const cleanEnvVar = (value, defaultValue = '') => {
  if (!value) return defaultValue;
  // Convert to string
  let cleaned = String(value);
  // Remove all single and double quotes from anywhere in the string
  cleaned = cleaned.replace(/['"]/g, '');
  // Remove trailing commas
  cleaned = cleaned.replace(/,+$/g, '');
  // Trim whitespace
  cleaned = cleaned.trim();
  return cleaned || defaultValue;
};

// Check SMTP configuration on startup
const checkSMTPConfig = () => {
  const smtpUser = cleanEnvVar(process.env.SMTP_USER);
  const smtpPass = cleanEnvVar(process.env.SMTP_PASS);
  const smtpHost = cleanEnvVar(process.env.SMTP_HOST, 'smtp.gmail.com');
  const smtpPort = cleanEnvVar(process.env.SMTP_PORT, '587');
  
  if (!smtpUser || !smtpPass) {
    console.warn('⚠️  SMTP not configured. Email notifications will not work.');
    console.warn('   Please set SMTP_USER and SMTP_PASS in your .env file');
    console.warn('   Raw values:', {
      SMTP_HOST: process.env.SMTP_HOST || 'undefined',
      SMTP_PORT: process.env.SMTP_PORT || 'undefined',
      SMTP_USER: process.env.SMTP_USER ? '***' + process.env.SMTP_USER.slice(-4) : 'NOT SET',
      SMTP_PASS: process.env.SMTP_PASS ? 'SET' : 'NOT SET'
    });
    console.warn('   Cleaned values:', {
      SMTP_HOST: smtpHost,
      SMTP_PORT: smtpPort,
      SMTP_USER: smtpUser ? '***' + smtpUser.slice(-4) : 'NOT SET',
      SMTP_PASS: smtpPass ? 'SET' : 'NOT SET'
    });
  } else {
    console.log('✅ SMTP configured:', {
      SMTP_HOST: smtpHost,
      SMTP_PORT: smtpPort,
      SMTP_USER: smtpUser.substring(0, 3) + '***' + smtpUser.slice(-4)
    });
  }
};

checkSMTPConfig();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, io };
