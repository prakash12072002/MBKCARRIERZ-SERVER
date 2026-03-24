const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User'); // Assuming you have a User model

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  User.findById(id).then((user) => {
    done(null, user);
  });
});

// Only configure Google Strategy if credentials are provided
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: '/api/auth/google/callback',
        proxy: true
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          // 1. Check if user exists with this Google ID
          let user = await User.findOne({ googleId: profile.id });

          if (user) {
            return done(null, user);
          }

          // 2. Check if user exists with this Email
          const email = profile.emails[0].value;
          user = await User.findOne({ email });

          if (user) {
            // Link Google ID to existing user
            user.googleId = profile.id;
            if (!user.profilePicture) user.profilePicture = profile.photos[0].value;
            await user.save();
            return done(null, user);
          }

          // 3. Create new user (Default to Trainer)
          // Only if not found by ID or Email
          const newUser = await new User({
            googleId: profile.id,
            name: profile.displayName,
            email: email,
            role: 'Trainer', // Default role for self-signup
            accountStatus: 'pending',
            profilePicture: profile.photos[0].value,
            emailVerified: true
          }).save();

          done(null, newUser);
        } catch (err) {
          done(err, null);
        }
      }
    )
  );
  console.log('✅ Google OAuth Strategy configured');
} else {
  console.warn('⚠️  Google OAuth credentials not found in .env - Google Login disabled');
}

module.exports = passport;
