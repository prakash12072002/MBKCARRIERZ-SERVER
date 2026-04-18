import 'dotenv/config';
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import session from "express-session";
import compression from "compression";
import mongoose from "mongoose";

// Route Imports
import routes from "./routes/index.mjs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { startAnalyticsWorker } = require("./workers/analyticsWorker.js");
import './config/database.js';

// dotenv.config() removed as it is now handled by top-level import 'dotenv/config'


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = process.env.NODE_ENV === "production";

const normalizeOrigin = (value = "") => value.trim().replace(/\/+$/, "");
const defaultAllowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://mbktechnologies.info",
  "https://www.mbktechnologies.info",
  "https://*.mbktechnologies.info",
];
const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map(normalizeOrigin)
  .filter(Boolean);

const allowedOrigins = new Set(
  [...defaultAllowedOrigins, ...configuredOrigins].map(normalizeOrigin),
);

const isLocalDevOrigin = (origin = "") =>
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(
    normalizeOrigin(origin),
  );

const getDefaultPort = (protocol = "") => {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
};

const wildcardOriginPattern = /^([a-z]+):\/\/\*\.(.+?)(?::(\d+))?$/i;

const matchesAllowedOriginPattern = (origin, allowedOriginPattern) => {
  const wildcardMatch = wildcardOriginPattern.exec(allowedOriginPattern);
  if (!wildcardMatch) {
    return false;
  }

  try {
    const parsedOrigin = new URL(origin);
    const [, protocol, hostSuffix, explicitPort = ""] = wildcardMatch;
    const normalizedSuffix = hostSuffix.toLowerCase().replace(/^\.+/, "");
    const originProtocol = parsedOrigin.protocol.toLowerCase();
    const originHost = parsedOrigin.hostname.toLowerCase();
    const originPort = parsedOrigin.port || getDefaultPort(originProtocol);
    const allowedProtocol = `${protocol.toLowerCase()}:`;
    const allowedPort = explicitPort || getDefaultPort(allowedProtocol);

    return (
      originProtocol === allowedProtocol &&
      originPort === allowedPort &&
      originHost.endsWith(`.${normalizedSuffix}`)
    );
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // Allows same-server calls, curl, and health checks.
  const normalizedOrigin = normalizeOrigin(origin);

  // In local development, allow localhost/127.0.0.1 across ports
  // so frontend port auto-switches (3000/3001/etc.) do not break API calls.
  if (!isProduction && isLocalDevOrigin(normalizedOrigin)) {
    return true;
  }

  return (
    allowedOrigins.has(normalizedOrigin) ||
    Array.from(allowedOrigins).some((allowedOrigin) =>
      matchesAllowedOriginPattern(normalizedOrigin, allowedOrigin),
    )
  );
};

const corsOriginHandler = (origin, callback) => {
  if (isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error(`Not allowed by CORS: ${origin}`));
};

const app = express();
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: corsOriginHandler,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Middleware
app.use(cors({
  origin: corsOriginHandler,
  credentials: true,
}));
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "mbk-secret",
  resave: false,
  saveUninitialized: true,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: "lax",
  },
}));

// Attach io to req
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Global Caching Middleware
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  }
  next();
});

// Static Files
const uploadsDir = path.join(__dirname, 'uploads');
const uploadsStaticOptions = {
  maxAge: '1y',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000');
  }
};

app.use('/uploads', express.static(uploadsDir, uploadsStaticOptions));
// Backward-compatible alias for clients using API base URL + file path.
app.use('/api/uploads', express.static(uploadsDir, uploadsStaticOptions));

// Routes
app.get("/api/health", (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    database: dbStatus,
    timestamp: new Date().toISOString(),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    }
  });
});

app.use("/api", routes);

// Root
app.get("/", (req, res) => res.send("MBK API is running..."));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
  // Start the Event-Driven Background Workers
  startAnalyticsWorker();
});

// Socket.io connection handler
import socketManager from './services/socketManager.mjs';
socketManager.init(io);
