const mongoose = require('mongoose');
const Config = require('../models/Config');

require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/workloob';

async function initBlogEarningsConfig() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Initialize blog earnings configuration with defaults
    await Config.setValue(
      'blog_earnings_views_rate',
      100, // LOB tokens per 1000 views
      'LOB tokens earned per 1000 blog views'
    );

    await Config.setValue(
      'blog_earnings_views_threshold',
      1000, // Views threshold
      'Number of views required to earn tokens'
    );

    await Config.setValue(
      'blog_earnings_impressions_rate',
      100, // LOB tokens per 100 impressions
      'LOB tokens earned per 100 blog impressions'
    );

    await Config.setValue(
      'blog_earnings_impressions_threshold',
      100, // Impressions threshold
      'Number of impressions required to earn tokens'
    );

    console.log('✓ Blog earnings configuration initialized');
    console.log('\nDefault rates:');
    console.log(`  - ${await Config.getValue('blog_earnings_views_threshold')} views = ${await Config.getValue('blog_earnings_views_rate')} LOB`);
    console.log(`  - ${await Config.getValue('blog_earnings_impressions_threshold')} impressions = ${await Config.getValue('blog_earnings_impressions_rate')} LOB`);

  } catch (error) {
    console.error('Error initializing blog earnings config:', error);
  } finally {
    await mongoose.connection.close();
    console.log('✓ Database connection closed');
  }
}

initBlogEarningsConfig();
