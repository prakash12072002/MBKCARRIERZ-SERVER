import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createVerifyAttendanceDocumentController } = require("../../modules/attendance/attendance.controller.js");

export async function runAttendanceVerificationTests() {
    console.log("Running attendance verification unit tests...");

    let verifyPayloadCalled = false;
    let syncScheduleDayStateCalled = false;
    let emitRealtimeUpdateCalled = false;

    const mockVerifyDocumentPayload = async (args) => {
        verifyPayloadCalled = true;
        if (!args.documentId) {
            const error = new Error("Document ID is required");
            error.statusCode = 400;
            throw error;
        }
        if (args.documentId === '507f1f77bcf86cd799439014') {
            const error = new Error("Document not found");
            error.statusCode = 404;
            throw error;
        }
        if (args.documentId === '507f1f77bcf86cd799439015') {
            throw new Error("Internal failure");
        }
        
        return {
            success: true,
            message: "Document verified successfully",
            data: { id: args.documentId },
            meta: { scheduleId: "mock-schedule-id", attendanceId: "mock-attendance-id", attendance: {} }
        };
    };

    const mockSyncScheduleDayStateHelper = async () => {
        syncScheduleDayStateCalled = true;
        return { dayStatus: "completed", attendanceUploaded: true, geoTagUploaded: false };
    };

    const mockEmitRealtimeUpdateHelper = () => {
        emitRealtimeUpdateCalled = true;
    };

    const controller = createVerifyAttendanceDocumentController({
        verifyDocumentPayload: mockVerifyDocumentPayload,
        syncScheduleDayStateHelper: mockSyncScheduleDayStateHelper,
        emitRealtimeUpdateHelper: mockEmitRealtimeUpdateHelper
    });

    const createMockReqRes = (body) => {
        const req = { body, user: { id: "user-123" } };
        const res = {
            statusCode: null,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; }
        };
        return { req, res };
    };

    // Test 1: Success Parity & Side Effects Parity
    {
        process.stdout.write("  - Success and side-effects parity ... ");
        verifyPayloadCalled = false;
        syncScheduleDayStateCalled = false;
        emitRealtimeUpdateCalled = false;

        const { req, res } = createMockReqRes({ documentId: "507f1f77bcf86cd799439011" });
        await controller(req, res);

        assert.strictEqual(verifyPayloadCalled, true);
        assert.strictEqual(syncScheduleDayStateCalled, true);
        assert.strictEqual(emitRealtimeUpdateCalled, true);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.message, "Document verified successfully");
        console.log("PASS");
    }

    // Test 2: Invalid Payload Parity (400)
    {
        process.stdout.write("  - Invalid payload parity (400) ... ");
        verifyPayloadCalled = false;
        syncScheduleDayStateCalled = false;
        
        const { req, res } = createMockReqRes({}); // Missing documentId
        await controller(req, res);

        assert.strictEqual(verifyPayloadCalled, false);
        assert.strictEqual(syncScheduleDayStateCalled, false);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.success, false);
        console.log("PASS");
    }

    // Test 3: Not Found Parity (404)
    {
        process.stdout.write("  - Not Found parity (404) ... ");
        const { req, res } = createMockReqRes({ documentId: "507f1f77bcf86cd799439014" });
        await controller(req, res);

        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.body.success, false);
        console.log("PASS");
    }

    // Test 4: Internal Error Parity (500)
    {
        process.stdout.write("  - Internal Error parity (500) ... ");
        const { req, res } = createMockReqRes({ documentId: "507f1f77bcf86cd799439015" });
        await controller(req, res);

        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.success, false);
        console.log("PASS");
    }

    console.log("All attendance verification parity unit tests passed!");
}

if (process.argv[1] && process.argv[1].endsWith('attendance-verification.test.mjs')) {
    runAttendanceVerificationTests().catch(err => {
        console.error("Test execution failed:", err);
        process.exit(1);
    });
}
