# Workloob Backend API

A comprehensive Node.js backend for Workloob freelance marketplace.

## Getting Started

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with the following variables:
```
NODE_ENV=development
PORT=5000
CLIENT_URL=http://localhost:3000
MONGODB_URI=mongodb://localhost:27017/workloob
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
```

3. Start MongoDB service

4. Run the development server:
```bash
npm run dev
```

5. Seed initial data:
```bash
npm run seed
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user

### Jobs
- `GET /api/jobs` - Get all jobs with filters
- `GET /api/jobs/:id` - Get single job
- `POST /api/jobs` - Create new job (client only)
- `POST /api/jobs/:id/apply` - Apply for job (talent only)

### Gigs
- `GET /api/gigs` - Get all gigs with filters
- `GET /api/gigs/:id` - Get single gig
- `POST /api/gigs` - Create gig (talent only)
- `POST /api/gigs/:id/order` - Order gig (client only)

### Chats
- `GET /api/chats` - Get user's chats
- `GET /api/chats/:id` - Get chat with messages
- `POST /api/chats/:id/messages` - Send message
- `PUT /api/chats/:id/workflow` - Update workflow status

### Wallet
- `GET /api/wallet/balance` - Get wallet balance
- `GET /api/wallet/transactions` - Get transaction history
- `POST /api/wallet/deposit` - Deposit money
- `POST /api/wallet/withdraw` - Withdraw money

### Users
- `GET /api/users/profile/:username` - Get public profile
- `PUT /api/users/profile` - Update profile
- `GET /api/users/dashboard/stats` - Get dashboard stats

### Governance
- `GET /api/governance` - Get governance proposals
- `POST /api/governance` - Create proposal
- `POST /api/governance/:id/vote` - Vote on proposal

### Referrals
- `GET /api/referral/info` - Get referral info
- `GET /api/referral/stats` - Get referral statistics
