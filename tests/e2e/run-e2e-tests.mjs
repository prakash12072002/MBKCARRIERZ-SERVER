import assert from "node:assert/strict";
import { createRequire } from "node:module";
import express from "express";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const { authenticate } = require("../../middleware/auth.js");
const { v1ResponseEnvelope } = require("../../middleware/v1ResponseEnvelope.js");
const { verifyGeoTag } = require("../../utils/verify.js");

process.env.JWT_SECRET = process.env.JWT_SECRET || "mbk-test-secret";

const startServer = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });

const stopServer = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const createApp = () => {
  const app = express();
  const router = express.Router();

  router.post("/checkout/auto-verify", authenticate, (req, res) => {
    const validation = verifyGeoTag({
      geoData: req.body?.exif,
      ocrData: req.body?.ocr,
      assignedDate: req.body?.assignedDate,
      collegeLocation: req.body?.collegeLocation,
      maxRadiusKm: 10,
      businessTimeZone: "Asia/Kolkata",
    });

    const isAutoVerified = validation.status === "COMPLETED";

    res.json({
      attendanceId: req.body?.attendanceId || "ATT-MOCK-1001",
      checkOutVerificationStatus: isAutoVerified
        ? "AUTO_VERIFIED"
        : "MANUAL_REVIEW_REQUIRED",
      checkOutVerificationReason: isAutoVerified ? null : validation.reason,
      checkOutVerificationMode: isAutoVerified ? "AUTO" : "MANUAL_REVIEW",
      checkOutLatitude: validation.latitude,
      checkOutLongitude: validation.longitude,
      checkOutGeoDistanceMeters:
        Number.isFinite(validation.distance) ? Math.round(validation.distance * 1000) : null,
      report: validation.report,
    });
  });

  app.use(express.json());
  app.use("/api/v1/attendance", v1ResponseEnvelope, router);

  return app;
};

const signToken = (overrides = {}) =>
  jwt.sign(
    {
      userId: "user-101",
      role: "spocadmin",
      ...overrides,
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" },
  );

const runUnauthorizedFlowCase = async () => {
  const app = createApp();
  const { server, baseUrl } = await startServer(app);

  try {
    const response = await fetch(`${baseUrl}/api/v1/attendance/checkout/auto-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.error.statusCode, 401);
    assert.match(payload.error.message, /No token|Invalid token/i);
  } finally {
    await stopServer(server);
  }
};

const runAutoVerifiedFlowCase = async () => {
  const app = createApp();
  const { server, baseUrl } = await startServer(app);

  try {
    const token = signToken();
    const response = await fetch(`${baseUrl}/api/v1/attendance/checkout/auto-verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        attendanceId: "ATT-2001",
        assignedDate: "2026-04-02",
        exif: {
          latitude: 12.9717,
          longitude: 77.5947,
          timestamp: Math.floor(new Date("2026-04-02T09:15:00+05:30").getTime() / 1000),
        },
        ocr: {
          latitude: 12.9717,
          longitude: 77.5947,
          timestamp: Math.floor(new Date("2026-04-02T09:15:15+05:30").getTime() / 1000),
        },
        collegeLocation: { lat: 12.9716, lng: 77.5946 },
      }),
    });

    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.checkOutVerificationStatus, "AUTO_VERIFIED");
    assert.equal(payload.data.checkOutVerificationMode, "AUTO");
    assert.equal(payload.error, null);
  } finally {
    await stopServer(server);
  }
};

const runManualReviewFlowCase = async () => {
  const app = createApp();
  const { server, baseUrl } = await startServer(app);

  try {
    const token = signToken({ role: "trainer" });
    const response = await fetch(`${baseUrl}/api/v1/attendance/checkout/auto-verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        attendanceId: "ATT-2002",
        assignedDate: "2026-04-02",
        exif: {},
        ocr: {},
        collegeLocation: { lat: 12.9716, lng: 77.5946 },
      }),
    });

    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.checkOutVerificationStatus, "MANUAL_REVIEW_REQUIRED");
    assert.match(
      payload.data.checkOutVerificationReason,
      /(No readable location|Missing EXIF GPS metadata)/i,
    );
  } finally {
    await stopServer(server);
  }
};

const tests = [
  {
    name: "unauthenticated checkout verification is rejected",
    run: runUnauthorizedFlowCase,
  },
  {
    name: "valid geotag evidence is auto-verified",
    run: runAutoVerifiedFlowCase,
  },
  {
    name: "missing metadata is routed to manual review",
    run: runManualReviewFlowCase,
  },
];

let failedCount = 0;

for (const testCase of tests) {
  try {
    await testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failedCount += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}

if (failedCount > 0) {
  console.error(`\n${failedCount} e2e test(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} e2e tests passed.`);
