const mongoose = require('mongoose');
require('dotenv').config();
const Blog = require('../models/Blog');
const User = require('../models/User');
const Notification = require('../models/Notification');

const categories = ['Recruiting', 'News', 'Sport', 'Business', 'Innovation', 'Health', 'Culture', 'Arts', 'Travel', 'Earth', 'Technology', 'Education', 'Entertainment'];

const sampleBlogs = [
  {
    title: "The Future of Remote Work: How Technology is Transforming the Workplace",
    excerpt: "Exploring how remote work technologies are reshaping the modern workplace and what it means for employees and employers.",
    category: "Business",
    tags: ["remote-work", "technology", "workplace", "innovation"],
    sections: [
      {
        type: "text",
        content: "Remote work has become more than just a trend—it's a fundamental shift in how we approach employment. Companies worldwide are adopting flexible work arrangements, and technology is at the heart of this transformation.",
        order: 1
      },
      {
        type: "heading",
        content: "Key Technologies Driving Remote Work",
        order: 2
      },
      {
        type: "list",
        content: {
          type: "unordered",
          items: [
            "Video conferencing platforms",
            "Cloud-based collaboration tools",
            "Project management software",
            "Virtual reality meeting spaces"
          ]
        },
        order: 3
      },
      {
        type: "text",
        content: "These technologies have enabled seamless communication and collaboration across time zones, making remote work not just possible, but often more efficient than traditional office setups.",
        order: 4
      }
    ]
  },
  {
    title: "Sustainable Innovation in Tech: Building a Greener Future",
    excerpt: "How tech companies are leading the charge in environmental sustainability through innovative solutions.",
    category: "Innovation",
    tags: ["sustainability", "technology", "environment", "green-tech"],
    sections: [
      {
        type: "text",
        content: "The technology sector is increasingly focusing on sustainability, with companies investing in renewable energy, carbon-neutral operations, and eco-friendly product designs.",
        order: 1
      },
      {
        type: "quote",
        content: "Innovation and sustainability go hand in hand. The future belongs to companies that can create value while protecting our planet.",
        order: 2
      },
      {
        type: "text",
        content: "From data centers powered by renewable energy to devices made from recycled materials, the tech industry is proving that profitability and environmental responsibility can coexist.",
        order: 3
      }
    ]
  },
  {
    title: "Mental Health in the Digital Age: Finding Balance",
    excerpt: "Understanding the impact of digital technology on mental health and strategies for maintaining wellbeing.",
    category: "Health",
    tags: ["mental-health", "wellness", "digital-age", "self-care"],
    sections: [
      {
        type: "text",
        content: "As we spend more time online, understanding the relationship between digital technology and mental health has never been more important.",
        order: 1
      },
      {
        type: "heading",
        content: "Strategies for Digital Wellness",
        order: 2
      },
      {
        type: "list",
        content: {
          type: "ordered",
          items: [
            "Set boundaries for screen time",
            "Take regular breaks from devices",
            "Practice mindfulness and meditation",
            "Maintain real-world social connections"
          ]
        },
        order: 3
      }
    ]
  },
  {
    title: "The Rise of AI in Creative Industries",
    excerpt: "Exploring how artificial intelligence is revolutionizing creative fields from art to music to writing.",
    category: "Arts",
    tags: ["ai", "creativity", "artificial-intelligence", "innovation"],
    sections: [
      {
        type: "text",
        content: "Artificial intelligence is no longer just a tool for data analysis—it's becoming a creative partner in industries once thought to be exclusively human domains.",
        order: 1
      },
      {
        type: "text",
        content: "From AI-generated art winning competitions to music composition algorithms creating original pieces, the boundaries between human and machine creativity are blurring.",
        order: 2
      }
    ]
  },
  {
    title: "Recruiting in 2024: What Talent Wants",
    excerpt: "Insights into the evolving expectations of job seekers and how companies are adapting their recruitment strategies.",
    category: "Recruiting",
    tags: ["recruiting", "talent", "hr", "careers"],
    sections: [
      {
        type: "text",
        content: "The recruitment landscape has shifted dramatically. Today's talent values flexibility, purpose, and company culture more than ever before.",
        order: 1
      },
      {
        type: "table",
        content: {
          headers: ["Priority", "Percentage of Candidates"],
          rows: [
            ["Work-life balance", "78%"],
            ["Remote work options", "65%"],
            ["Company culture", "72%"],
            ["Career growth", "68%"]
          ]
        },
        order: 2
      }
    ]
  },
  {
    title: "Sports Technology: How Data is Changing the Game",
    excerpt: "From wearable devices to performance analytics, technology is revolutionizing how athletes train and compete.",
    category: "Sport",
    tags: ["sports", "technology", "analytics", "performance"],
    sections: [
      {
        type: "text",
        content: "Modern sports are increasingly data-driven, with teams using advanced analytics to optimize performance, prevent injuries, and gain competitive advantages.",
        order: 1
      },
      {
        type: "text",
        content: "Wearable technology tracks everything from heart rate to movement patterns, providing coaches and athletes with unprecedented insights into performance.",
        order: 2
      }
    ]
  },
  {
    title: "Cultural Preservation in the Digital Era",
    excerpt: "How digital technologies are being used to preserve and share cultural heritage for future generations.",
    category: "Culture",
    tags: ["culture", "heritage", "preservation", "digital"],
    sections: [
      {
        type: "text",
        content: "Digital technologies offer new ways to document, preserve, and share cultural heritage, ensuring that traditions and knowledge are not lost to time.",
        order: 1
      },
      {
        type: "text",
        content: "From virtual museum tours to digital archives of ancient texts, technology is making cultural resources more accessible than ever before.",
        order: 2
      }
    ]
  },
  {
    title: "Travel Tech: Smart Solutions for Modern Explorers",
    excerpt: "Discover how technology is making travel more accessible, sustainable, and enjoyable.",
    category: "Travel",
    tags: ["travel", "technology", "tourism", "adventure"],
    sections: [
      {
        type: "text",
        content: "Travel technology has transformed how we explore the world, from booking platforms to translation apps to sustainable travel solutions.",
        order: 1
      },
      {
        type: "text",
        content: "Smart travel apps help us find the best deals, navigate unfamiliar places, and connect with local communities in meaningful ways.",
        order: 2
      }
    ]
  },
  {
    title: "Climate Action: Technology's Role in Environmental Protection",
    excerpt: "Examining how innovative technologies are helping combat climate change and protect our planet.",
    category: "Earth",
    tags: ["climate", "environment", "sustainability", "technology"],
    sections: [
      {
        type: "text",
        content: "Technology plays a crucial role in addressing climate change, from renewable energy systems to carbon capture technologies to environmental monitoring.",
        order: 1
      },
      {
        type: "quote",
        content: "The best time to act on climate change was yesterday. The second best time is now.",
        order: 2
      }
    ]
  },
  {
    title: "Breaking News: Latest Developments in Tech Industry",
    excerpt: "Stay updated with the most recent news and developments shaping the technology sector.",
    category: "News",
    tags: ["news", "technology", "updates", "industry"],
    sections: [
      {
        type: "text",
        content: "The tech industry continues to evolve at a rapid pace, with new innovations, partnerships, and market developments emerging daily.",
        order: 1
      },
      {
        type: "text",
        content: "From major acquisitions to breakthrough innovations, staying informed about tech news helps professionals and enthusiasts alike understand the direction of the industry.",
        order: 2
      }
    ]
  }
];

// Generate blog templates programmatically
const generateBlogTemplates = () => {
  const templates = [...sampleBlogs];
  
  const blogTitles = {
    'Business': [
      'The Future of E-Commerce: Trends Shaping Online Retail',
      'Cryptocurrency and Traditional Banking: A New Era',
      'Startup Funding Strategies for 2024',
      'Corporate Social Responsibility in Modern Business',
      'Supply Chain Innovation: Technology Meets Logistics',
      'The Gig Economy: Reshaping Traditional Employment',
      'Digital Marketing Strategies That Actually Work',
      'Leadership in Times of Crisis',
      'Sustainable Business Practices for Long-Term Success',
      'The Impact of AI on Business Operations',
    ],
    'Technology': [
      'Quantum Computing: The Next Frontier',
      '5G Networks: Transforming Connectivity',
      'Cybersecurity in the Age of IoT',
      'Blockchain Beyond Cryptocurrency',
      'Edge Computing: Bringing Processing Closer',
      'Machine Learning in Everyday Applications',
      'The Evolution of Programming Languages',
      'Cloud Computing: Past, Present, and Future',
      'Augmented Reality in Professional Settings',
      'The Internet of Things: Connecting Everything',
    ],
    'Innovation': [
      'Disruptive Technologies Changing Industries',
      'Innovation Labs: Where Ideas Become Reality',
      'The Role of Failure in Innovation',
      'Open Source: Driving Collaborative Innovation',
      'Biotechnology Breakthroughs',
      'Green Energy Innovations',
      'Space Technology: New Horizons',
      'Medical Device Innovation',
      'Smart Cities: Urban Innovation',
      'Innovation in Education Technology',
    ],
    'Health': [
      'Telemedicine: Healthcare Goes Digital',
      'Mental Health Awareness in the Workplace',
      'Nutrition Science: Debunking Myths',
      'Exercise and Longevity',
      'Preventive Healthcare Strategies',
      'The Future of Personalized Medicine',
      'Public Health Challenges in 2024',
      'Wellness Technology: Apps and Devices',
      'Healthcare Access in Rural Areas',
      'The Science of Sleep',
    ],
    'Recruiting': [
      'Remote Hiring Best Practices',
      'Diversity and Inclusion in Recruitment',
      'Employer Branding Strategies',
      'The Future of Job Interviews',
      'Skills-Based Hiring Trends',
      'Recruitment Technology Tools',
      'Building Strong Candidate Pipelines',
      'Onboarding for Remote Teams',
      'Retention Strategies That Work',
      'The Gig Economy and Talent Acquisition',
    ],
    'News': [
      'Global Tech Industry Updates',
      'Economic Trends and Analysis',
      'Political Impact on Business',
      'International Trade Developments',
      'Social Media and News Consumption',
      'Investigative Journalism in the Digital Age',
      'Media Literacy in 2024',
      'Breaking: Major Industry Shifts',
      'News Consumption Patterns',
      'The Future of Journalism',
    ],
    'Sport': [
      'Sports Analytics Revolution',
      'Athlete Mental Health',
      'Women in Sports: Breaking Barriers',
      'Sports Technology Innovations',
      'The Business of Professional Sports',
      'Youth Sports Development',
      'Esports: The New Frontier',
      'Sports Medicine Advances',
      'Olympic Games and Global Unity',
      'Fantasy Sports and Data Analytics',
    ],
    'Culture': [
      'Cultural Exchange in the Digital Age',
      'Preserving Heritage Through Technology',
      'Global Cultural Trends',
      'Language and Cultural Identity',
      'Cultural Appropriation vs. Appreciation',
      'Festivals and Community Building',
      'Cultural Tourism',
      'Food Culture Around the World',
      'Music and Cultural Expression',
      'Traditional Arts in Modern Times',
    ],
    'Arts': [
      'Digital Art and NFTs',
      'The Renaissance of Street Art',
      'Art Therapy and Mental Health',
      'Museums in the Digital Era',
      'Contemporary Art Movements',
      'Photography as Art Form',
      'Literature in the 21st Century',
      'Performing Arts Innovation',
      'Art Education and Accessibility',
      'The Business of Art',
    ],
    'Travel': [
      'Sustainable Tourism Practices',
      'Solo Travel: A Growing Trend',
      'Digital Nomad Lifestyle',
      'Hidden Gems: Off-the-Beaten-Path Destinations',
      'Travel Technology and Apps',
      'Cultural Immersion Travel',
      'Adventure Travel Safety',
      'Budget Travel Tips',
      'Luxury Travel Experiences',
      'Travel Photography Tips',
    ],
    'Earth': [
      'Climate Change Solutions',
      'Renewable Energy Progress',
      'Ocean Conservation Efforts',
      'Wildlife Protection Initiatives',
      'Sustainable Agriculture',
      'Water Conservation Strategies',
      'Forest Restoration Projects',
      'Plastic Pollution Solutions',
      'Biodiversity Preservation',
      'Environmental Policy Updates',
    ],
    'Education': [
      'Online Learning Evolution',
      'STEM Education Initiatives',
      'Personalized Learning Approaches',
      'Education Technology Tools',
      'Lifelong Learning Trends',
      'Accessibility in Education',
      'Teacher Training and Development',
      'Student Mental Health Support',
      'Education Funding Challenges',
      'The Future of Universities',
    ],
    'Entertainment': [
      'Streaming Wars: Content Battle',
      'Virtual Concerts and Events',
      'Gaming Industry Growth',
      'Podcast Culture',
      'Social Media Entertainment',
      'Film Industry Innovations',
      'Music Streaming Trends',
      'Celebrity Culture and Influence',
      'Entertainment Technology',
      'The Future of Live Events',
    ],
  };

  // Generate blogs for each category
  categories.forEach(category => {
    const titles = blogTitles[category] || [];
    titles.forEach((title, idx) => {
      const excerpt = `Discover insights and trends in ${category.toLowerCase()}. ${title.toLowerCase()} explores the latest developments and future possibilities.`;
      templates.push({
        title,
        excerpt,
        category,
        tags: [category.toLowerCase(), 'trends', 'insights', 'analysis'],
        sections: [
          {
            type: 'text',
            content: `${title} represents a significant development in the field. This comprehensive analysis explores the key factors, trends, and implications that are shaping the future.`,
            order: 1
          },
          {
            type: 'heading',
            content: 'Key Insights',
            order: 2
          },
          {
            type: 'text',
            content: 'Understanding these developments is crucial for staying ahead in an ever-evolving landscape. The implications extend far beyond immediate concerns.',
            order: 3
          }
        ]
      });
    });
  });

  return templates;
};

const seedBlogs = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/workloob');
    console.log('Connected to MongoDB');

    // Get users to assign as authors
    const users = await User.find().limit(50);
    if (users.length === 0) {
      console.log('No users found. Please create users first.');
      process.exit(1);
    }

    // Clear existing blogs
    await Blog.deleteMany({});
    console.log('Cleared existing blogs');

    // Generate all blog templates
    const allBlogTemplates = generateBlogTemplates();
    console.log(`Generated ${allBlogTemplates.length} blog templates`);

    // Create blogs
    const createdBlogs = [];
    for (let i = 0; i < allBlogTemplates.length; i++) {
      const blogData = allBlogTemplates[i];
      const author = users[i % users.length];
      
      // Generate slug
      let slug = blogData.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

      // Ensure unique slug
      let slugExists = await Blog.findOne({ slug });
      let counter = 1;
      while (slugExists) {
        slug = `${slug}-${counter}`;
        slugExists = await Blog.findOne({ slug });
        counter++;
      }

      const views = Math.floor(Math.random() * 10000) + 100;
      const impressions = Math.floor(Math.random() * 2000) + 50;
      const likes = Math.floor(Math.random() * 500) + 10;

      const blog = new Blog({
        title: blogData.title,
        slug,
        excerpt: blogData.excerpt,
        thumbnail: `https://picsum.photos/800/400?random=${i + Date.now()}`,
        author: author._id,
        category: blogData.category,
        tags: blogData.tags,
        sections: blogData.sections,
        status: 'published',
        publishedAt: new Date(Date.now() - i * 2 * 60 * 60 * 1000), // Stagger publish dates
        views,
        impressions,
        likes,
        featured: i < 20 || (i % 10 === 0), // More featured blogs
        sponsored: i < 5 || (i % 15 === 0), // More sponsored blogs
        priority: i < 20 ? Math.max(0, 20 - i) : Math.floor(Math.random() * 5)
      });

      // Calculate earnings based on views and impressions
      const viewEarnings = Math.floor(views / 1000) * 100;
      const impressionEarnings = Math.floor(impressions / 100) * 100;
      blog.earnings = {
        totalEarned: viewEarnings + impressionEarnings,
        available: viewEarnings + impressionEarnings,
        withdrawn: 0
      };

      await blog.save();
      createdBlogs.push(blog);
      
      if ((i + 1) % 10 === 0) {
        console.log(`Created ${i + 1} blogs...`);
      }
    }

    console.log(`\n✅ Successfully seeded ${createdBlogs.length} blogs!`);
    console.log(`\nBreakdown by category:`);
    categories.forEach(cat => {
      const count = createdBlogs.filter(b => b.category === cat).length;
      console.log(`  ${cat}: ${count} blogs`);
    });
    console.log(`\nFeatured: ${createdBlogs.filter(b => b.featured).length}`);
    console.log(`Sponsored: ${createdBlogs.filter(b => b.sponsored).length}`);

    process.exit(0);
  } catch (error) {
    console.error('Error seeding blogs:', error);
    process.exit(1);
  }
};

// Run if called directly
if (require.main === module) {
  seedBlogs();
}

module.exports = seedBlogs;
