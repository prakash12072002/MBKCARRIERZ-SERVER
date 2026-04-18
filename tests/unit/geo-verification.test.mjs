import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyGeoTag } = require("../../utils/verify.js");

export async function runGeoVerificationTests() {
    console.log("Running geo-verification logic unit tests...");

    const collegeLocation = { lat: 12.9716, lng: 77.5946 }; // Bangalore
    const assignedDate = "2026-04-08";
    const businessTimeZone = "Asia/Kolkata";

    // Test 1: Success Scenario
    {
        process.stdout.write("  - Valid EXIF GPS + Correct Date ... ");
        const geoData = {
            latitude: 12.9717,
            longitude: 77.5947,
            capturedAt: new Date("2026-04-08T10:00:00"),
            hasGps: true
        };
        const validation = verifyGeoTag({
            geoData,
            assignedDate,
            collegeLocation,
            businessTimeZone
        });

        assert.strictEqual(validation.status, 'COMPLETED');
        assert.strictEqual(validation.reasonCode, 'VERIFIED');
        console.log("PASS");
    }

    // Test 2: Missing EXIF GPS
    {
        process.stdout.write("  - Missing EXIF GPS (No coordinates) ... ");
        const geoData = {
            latitude: null,
            longitude: null,
            capturedAt: new Date("2026-04-08T10:00:00"),
            hasGps: false
        };
        const validation = verifyGeoTag({
            geoData,
            assignedDate,
            collegeLocation,
            businessTimeZone
        });

        assert.strictEqual(validation.status, 'PENDING');
        assert.strictEqual(validation.reasonCode, 'EXIF_GPS_MISSING');
        assert.deepEqual(validation.missingFields, ['latitude', 'longitude']);
        console.log("PASS");
    }

    // Test 3: Location Mismatch
    {
        process.stdout.write("  - Location Mismatch (Outside range) ... ");
        const geoData = {
            latitude: 13.5, // Far from Bangalore
            longitude: 78.5,
            capturedAt: new Date("2026-04-08T10:00:00"),
            hasGps: true
        };
        const validation = verifyGeoTag({
            geoData,
            assignedDate,
            collegeLocation,
            businessTimeZone,
            maxRadiusKm: 10
        });

        assert.strictEqual(validation.status, 'PENDING');
        assert.strictEqual(validation.reasonCode, 'LOCATION_MISMATCH');
        console.log("PASS");
    }

    // Test 4: Date Mismatch
    {
        process.stdout.write("  - Date Mismatch (Wrong day) ... ");
        const geoData = {
            latitude: 12.9717,
            longitude: 77.5947,
            capturedAt: new Date("2026-04-07T10:00:00"), // Previous day
            hasGps: true
        };
        const validation = verifyGeoTag({
            geoData,
            assignedDate,
            collegeLocation,
            businessTimeZone
        });

        assert.strictEqual(validation.status, 'PENDING');
        assert.strictEqual(validation.reasonCode, 'DATE_MISMATCH');
        console.log("PASS");
    }

    // Test 5: Geo Mismatch (EXIF vs OCR)
    {
        process.stdout.write("  - Geo Mismatch (EXIF vs OCR) ... ");
        const geoData = {
            latitude: 12.9717,
            longitude: 77.5947,
            capturedAt: new Date("2026-04-08T10:00:00"),
            hasGps: true
        };
        const ocrData = {
            latitude: 13.1, // Different
            longitude: 77.6,
            capturedAt: new Date("2026-04-08T10:00:00")
        };
        const validation = verifyGeoTag({
            geoData,
            ocrData,
            assignedDate,
            collegeLocation,
            businessTimeZone
        });

        assert.strictEqual(validation.status, 'PENDING');
        assert.strictEqual(validation.reasonCode, 'GEO_MISMATCH');
        console.log("PASS");
    }

    console.log("All geo-verification unit tests passed!");
}

if (process.argv[1] && process.argv[1].endsWith('geo-verification.test.mjs')) {
    runGeoVerificationTests().catch(err => {
        console.error("Test execution failed:", err);
        process.exit(1);
    });
}
