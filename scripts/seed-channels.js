/**
 * scripts/seed-channels.js
 *
 * Modified to wipe demo users and pull real users from the MongoDB database.
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const { StreamChat } = require('stream-chat');
const mongoose = require('mongoose');
const User = require('../models/User');

const API_KEY    = process.env.STREAM_CHAT_API_KEY    || process.env.STREAM_API_KEY;
const API_SECRET = process.env.STREAM_CHAT_API_SECRET || process.env.STREAM_API_SECRET;

const client = StreamChat.getInstance(API_KEY, API_SECRET);

const DEMO_USERS = ['super-admin-001', 'spoc-admin-001', 'spoc-admin-002', 'trainer-001', 'trainer-002', 'trainer-003'];

async function seed() {
  console.log('🌱 Seeding REAL MBK Chat users from database…\n');

  // 0. Connect to DB
  await mongoose.connect(process.env.MONGO_URI);
  console.log('   ✓ Connected to MongoDB');

  // 1. Delete Demo Users
  console.log('🗑️ Deleting old demo users…');
  try {
     await client.deleteUsers(DEMO_USERS, { mark_messages_deleted: true, hard_delete: true });
     console.log('   ✓ Demo users deleted');
  } catch (e) {
     console.log('   - Could not cleanly delete demo users (they may already be deleted or have dependencies)');
  }

  // 2. Fetch real users
  console.log('📦 Fetching real users from MongoDB…');
  const dbUsers = await User.find({ isActive: true });
  console.log(`   ✓ Found ${dbUsers.length} active users`);

  if (dbUsers.length === 0) {
      console.log('❌ No real users found in DB. Exiting.');
      process.exit(1);
  }

  // 3. Upsert real users
  console.log('👤 Upserting real users to Stream…');
  const streamUsers = dbUsers.map(u => ({
      id: u._id.toString(),
      name: u.name || u.email || u._id.toString(),
      role: 'user', // standard stream role
      portal_role: u.role,
      image: u.profilePicture || undefined
  }));

  // Upsert in batches of 100
  for (let i = 0; i < streamUsers.length; i += 100) {
      const batch = streamUsers.slice(i, i + 100);
      await client.upsertUsers(batch);
  }
  console.log(`   ✓ ${streamUsers.length} real users upserted\n`);

  // 4. Global Announcements channel
  console.log('📢 Recreating Global Announcement channel with all real members…');
  
  // Find someone who is an admin to create the channel
  const superAdmin = streamUsers.find(u => ['SuperAdmin', 'admin', 'Super Admin'].includes(u.portal_role)) || streamUsers[0];

  const announcementChannel = client.channel('messaging', 'global-announcements', {
    name:            '📢 Company Announcements',
    is_announcement: true,
    members:         streamUsers.map(u => u.id),
    created_by_id:   superAdmin.id,
  });
  
  // Update/Create the channel
  await announcementChannel.create();

  console.log('   ✓ Announcement channel updated with all real users\n');

  console.log('\n✅ Real User Seeding complete! Your MBK Chat is now live with your database users.\n');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
