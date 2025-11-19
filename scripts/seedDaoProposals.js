const mongoose = require('mongoose');
require('dotenv').config();

const Proposal = require('../models/Proposal');
const User = require('../models/User');
const Job = require('../models/Job');
const Order = require('../models/Order');

const MIN_VOTE_ACTIVITY_POINTS = 9;
const MIN_PROPOSAL_ACTIVITY_POINTS = 10;
const VOTING_DURATION_DAYS = 5;

const getVotingWindow = (days = VOTING_DURATION_DAYS) => {
  const startsAt = new Date();
  const endsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return { startsAt, endsAt, durationDays: days };
};

async function seedDaoSamples() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/workloob');
  console.log('[DAO SEED] Connected to MongoDB');

  try {
    const eligibleVotersCount = await User.countDocuments({
      'stats.activityPoints': { $gte: MIN_VOTE_ACTIVITY_POINTS }
    });

    const proposers = await User.find({
      'stats.activityPoints': { $gte: MIN_PROPOSAL_ACTIVITY_POINTS }
    })
      .sort({ 'stats.activityPoints': -1 })
      .limit(5);

    if (proposers.length === 0) {
      throw new Error('No users with enough activity points to submit DAO proposals.');
    }

    const platformTemplates = [
      {
        title: 'Introduce Tiered Reputation Levels',
        summary: 'Add Bronze, Silver, and Gold reputation tiers tied to DAO activity.',
        description:
          'This platform proposal introduces tiered reputation levels that unlock exclusive perks and voting boosts. The goal is to reward consistent participation in governance and platform contributions.',
        platformDetails: {
          problemStatement:
            'Current reputation is flat and does not highlight sustained contributions. We need contextual recognition to motivate consistent governance activity.',
          proposedSolution:
            'Launch Bronze (0-49 pts), Silver (50-149 pts), and Gold (150+ pts) tiers with progressive rewards and badges across the platform UI.',
          impact:
            'Encourages a healthy governance culture, increases repeat participation, and gives new members a clear path to higher trust levels.',
          implementationPlan:
            'Phase 1: Implement badges and profile highlights.\nPhase 2: Add tier-based voting multipliers (capped) after community vote.\nPhase 3: Launch periodic leaderboard highlights.',
          successMetrics:
            'Increase in monthly votes, higher proposal submissions, improved retention of qualified voters.',
          dependencies:
            'Requires UI updates, profile service changes, and analytics adjustments to track tier progression.'
        },
        tags: ['platform', 'reputation', 'dao']
      },
      {
        title: 'Upgrade Dispute Evidence Locker',
        summary: 'Add structured evidence upload and tagging for disputes.',
        description:
          'This upgrade improves the dispute flow by introducing a structured evidence locker. DAO members and participants can upload tagged assets, making decisions clearer and faster.',
        platformDetails: {
          problemStatement:
            'Current dispute threads mix chat messages and evidence uploads, making it difficult for DAO members to review context efficiently.',
          proposedSolution:
            'Add a dedicated evidence locker with tagging (screenshots, contracts, deliverables, chat excerpts) and chronological grouping.',
          impact:
            'Simplifies DAO reviews, reduces time-to-resolution, and creates a transparent audit trail for future disputes.',
          implementationPlan:
            'Phase 1: Backend schema for evidence assets.\nPhase 2: UI components in dispute detail page.\nPhase 3: Automated reminders for parties to provide supporting documentation.',
          successMetrics:
            'Shorter dispute resolution times, higher satisfaction ratings post-dispute, and fewer escalations.',
          dependencies:
            'Requires storage integration, file validation updates, and UI work in the dispute page.'
        },
        tags: ['platform', 'dispute', 'ux']
      }
    ];

    const { startsAt, endsAt, durationDays } = getVotingWindow();

    let created = 0;
    for (let i = 0; i < platformTemplates.length; i++) {
      const template = platformTemplates[i];
      const proposer = proposers[i % proposers.length];

      const exists = await Proposal.exists({ title: template.title });
      if (exists) {
        console.log(`[DAO SEED] Skipping existing platform proposal "${template.title}"`);
        continue;
      }

      const proposal = new Proposal({
        title: template.title,
        summary: template.summary,
        description: template.description,
        proposer: proposer._id,
        proposalType: 'platform',
        category: 'platform',
        tags: template.tags,
        platformDetails: template.platformDetails,
        voting: {
          startsAt,
          endsAt,
          durationDays,
          minActivityPoints: MIN_VOTE_ACTIVITY_POINTS,
          quorum: 0
        },
        status: 'voting',
        isActive: true,
        analytics: {
          participationRate: 0,
          totalEligibleVoters: eligibleVotersCount,
          uniqueVoters: 0
        }
      });

      await proposal.save();
      await proposer.incrementDaoStat('proposalsSubmitted');
      console.log(`[DAO SEED] Created platform proposal "${proposal.title}"`);
      created += 1;
    }

    const jobForDispute = await Job.findOne({
      status: { $in: ['in-progress', 'completed'] },
      client: { $exists: true, $ne: null },
      hiredTalent: { $exists: true, $ne: null }
    })
      .populate('client', 'username profile')
      .populate('hiredTalent', 'username profile');

    const orderForDispute = await Order.findOne({
      status: { $in: ['in-progress', 'delivered', 'completed'] },
      client: { $exists: true, $ne: null },
      talent: { $exists: true, $ne: null }
    })
      .populate('client', 'username profile')
      .populate('talent', 'username profile')
      .populate({
        path: 'gig',
        select: 'title talent',
        populate: { path: 'talent', select: 'username profile' }
      });

    const disputeTemplates = [];

    if (jobForDispute) {
      disputeTemplates.push({
        title: `Dispute Resolution • Job ${jobForDispute.title}`,
        summary: 'Client and talent disagree on scope completion.',
        description:
          'Client claims several deliverables remain incomplete, while the hired talent insists all agreed milestones were delivered. DAO review requested.',
        jobModel: 'Job',
        workItem: jobForDispute,
        issueSummary:
          'Client reports missing analytics integration deliverables; talent claims completion and points to acceptance notes.',
        clientNarrative:
          'Delivered product lacks analytics dashboard promised in sprint 2. No final QA handoff occurred.',
        talentNarrative:
          'Analytics dashboard delivered via shared repo. Client approved the pull request and asked for minor changes which were completed.'
      });
    } else {
      console.warn('[DAO SEED] No eligible Job found for dispute sample.');
    }

    if (orderForDispute) {
      disputeTemplates.push({
        title: `Dispute Resolution • Order ${orderForDispute.orderNumber || orderForDispute._id}`,
        summary: 'Client requests partial refund over missed revision cycle.',
        description:
          'A gig order deliverable was submitted two days late. Client requests partial refund; talent seeks full payment citing unforeseen blockers.',
        jobModel: 'Order',
        workItem: orderForDispute,
        issueSummary:
          'Submission arrived 48 hours past deadline; client claims the delay impacted their campaign launch.',
        clientNarrative:
          'Marketing campaign was delayed. Talent did not communicate proactively, causing missed launch window.',
        talentNarrative:
          'Delay caused by unexpected platform outage. Delivered extra revisions and assets to compensate.'
      });
    } else {
      console.warn('[DAO SEED] No eligible Order found for dispute sample.');
    }

    for (let i = 0; i < disputeTemplates.length; i++) {
      const template = disputeTemplates[i];
      const proposer = proposers[(i + platformTemplates.length) % proposers.length];

      const exists = await Proposal.exists({
        proposalType: 'dispute',
        'disputeContext.job': template.workItem._id
      });
      if (exists) {
        console.log(`[DAO SEED] Skipping existing dispute for ${template.title}`);
        continue;
      }

      const proposal = new Proposal({
        title: template.title,
        summary: template.summary,
        description: template.description,
        proposer: proposer._id,
        proposalType: 'dispute',
        category: 'dispute',
        tags: ['dispute', 'escrow'],
        voting: {
          startsAt,
          endsAt,
          durationDays,
          minActivityPoints: MIN_VOTE_ACTIVITY_POINTS,
          quorum: 0
        },
        status: 'voting',
        isActive: true,
        disputeContext: {
          job: template.workItem._id,
          jobModel: template.jobModel,
          client: template.workItem.client?._id || template.workItem.client,
          talent:
            template.jobModel === 'Job'
              ? template.workItem.hiredTalent?._id || template.workItem.hiredTalent
              : template.workItem.talent?._id ||
                template.workItem.talent ||
                template.workItem.gig?.talent?._id,
          issueSummary: template.issueSummary,
          clientNarrative: template.clientNarrative,
          talentNarrative: template.talentNarrative,
          history: [
            {
              label: 'Escalated to DAO',
              description: 'Client escalated to DAO after bilateral negotiation failed.',
              occurredAt: new Date()
            }
          ]
        },
        analytics: {
          participationRate: 0,
          totalEligibleVoters: eligibleVotersCount,
          uniqueVoters: 0
        }
      });

      await proposal.save();
      await proposer.incrementDaoStat('disputesRaised');
      console.log(`[DAO SEED] Created dispute proposal "${proposal.title}"`);
      created += 1;
    }

    console.log(`[DAO SEED] Completed. Created ${created} DAO proposals.`);
  } finally {
    await mongoose.disconnect();
    console.log('[DAO SEED] Disconnected from MongoDB');
  }
}

seedDaoSamples()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[DAO SEED] Failed to seed DAO proposals', error);
    process.exit(1);
  });

