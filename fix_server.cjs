const fs = require('fs');
const path = require('path');

const serverJsPath = 'e:\\Master V\\M-server\\server.js';

const content = `const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
// Force restart timestamp: 1737650000003
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const routes = require('./routes');
require('./config/database');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 5000;

// Create server
let server;
const sslKeyPath = path.join(__dirname, 'key.pem');
const sslCertPath = path.join(__dirname, 'cert.pem');

if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
    const https = require('https');
    const options = {
        key: fs.readFileSync(sslKeyPath),
        cert: fs.readFileSync(sslCertPath)
    };
    server = https.createServer(options, app);
    console.log('Security: HTTPS enabled');
} else {
    server = http.createServer(app);
    console.log('Security: HTTPS disabled (Certificates not found).');
}

// Initialize Socket.io
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

const cookieParser = require('cookie-parser');
const session = require('express-session');
const captchaRoute = require('./routes/captchaRoute');

// Middleware
app.use(cors({
    origin: function (origin, callback) {
        return callback(null, true);
    },
    credentials: true
}));

app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cookieParser());

// Session middleware for CAPTCHA
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mbkcarrierz-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { 
      secure: process.env.NODE_ENV === 'production', 
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax' 
    }
  })
);

// Public access for trainer profile photos ONLY (test-*.jpg pattern)
app.get('/uploads/trainer-documents/:filename', (req, res, next) => {
    const { filename } = req.params;
    if ((filename.startsWith('test-') && filename.toLowerCase().endsWith('.jpg')) || filename.match(/\\.(xlsx|xls)$/i)) {
        const filePath = path.join(__dirname, 'uploads/trainer-documents', filename);
        return res.sendFile(filePath, (err) => {
            if (err) res.status(404).json({ success: false, message: 'File not found' });
        });
    }
    next();
});

// Public access for attendance sheets (Excel)
app.get('/uploads/attendance-sheets/:filename', (req, res, next) => {
    const { filename } = req.params;
    if (filename.match(/\\.(xlsx|xls)$/i)) {
        const filePath = path.join(__dirname, 'uploads/attendance-sheets', filename);
        return res.sendFile(filePath, (err) => {
            if (err) res.status(404).json({ success: false, message: 'File not found' });
        });
    }
    next();
});

app.use('/uploads/NDA', express.static(path.join(__dirname, 'uploads/NDA')));
app.use('/api/uploads/NDA', express.static(path.join(__dirname, 'uploads/NDA')));

// Secure File Access Route
app.get('/api/uploads/trainer-documents/:filename', (req, res, next) => {
    if (req.query.token) {
        req.headers.authorization = \`Bearer \${req.query.token}\`;
    }
    const { filename } = req.params;
    if (filename.match(/\\.(xlsx|xls)$/i)) {
        const filePath = path.join(__dirname, 'uploads/trainer-documents', filename);
        return res.sendFile(filePath, (err) => {
             if (err && !res.headersSent) {
                res.status(404).json({ success: false, message: 'File not found' });
             }
        });
    }

    const { authenticate } = require('./middleware/auth');
    authenticate(req, res, () => {
        const filename = req.params.filename;
        const filePath = path.join(__dirname, 'uploads/trainer-documents', filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'File not found' });
        }
        res.sendFile(filePath, (err) => {
            if (err && !res.headersSent) {
                res.status(404).json({ success: false, message: 'File not found' });
            }
        });
    });
});

// Attach io to req
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Socket.io connection handler
io.on('connection', (socket) => {
    socket.on('disconnect', () => { });
});

// Root Route
app.get('/', (req, res) => {
    res.send('Server is running');
});

// Session Test Route
app.get('/api/session-test', (req, res) => {
    if (!req.session.testCount) {
        req.session.testCount = 1;
    } else {
        req.session.testCount++;
    }
    res.json({
        success: true,
        sessionID: req.sessionID,
        testCount: req.session.testCount,
        cookie: req.session.cookie,
        env: process.env.NODE_ENV
    });
});

// Routes
app.use('/api', captchaRoute);
app.use('/api', routes);
app.use('/api/test', require('./routes/testRoutes'));

// Initialize Services
const reminderService = require('./services/reminderService');
reminderService.init();
const trainerOnboardingReminderService = require('./services/trainerOnboardingReminderService');
trainerOnboardingReminderService.init();
const dailyTrainerReportService = require('./services/dailyTrainerReportService');
dailyTrainerReportService.init();
const weeklySummaryReportService = require('./services/weeklySummaryReportService');
weeklySummaryReportService.init();
const monthlyAnalyticsReportService = require('./services/monthlyAnalyticsReportService');
monthlyAnalyticsReportService.init();

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Global Error:', err);
    const statusCode = err.name === 'MulterError' ? 400 : 500;
    res.status(statusCode).json({ 
        success: false,
        message: err.name === 'MulterError' ? \`Upload Error: \${err.message}\` : 'Internal Server Error'
    });
});

// Start Server
const startServer = async () => {
    const serverListener = server.listen(PORT, () => {
        console.log(\`Server is running on port \${PORT}\`);
    });
};

startServer();
`;

fs.writeFileSync(serverJsPath, content, 'utf8');
console.log("Server.js completely rewritten correctly.");
