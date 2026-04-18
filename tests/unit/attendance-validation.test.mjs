import assert from "node:assert/strict";
import { createRequire } from "node:module";
import mongoose from "mongoose";

const require = createRequire(import.meta.url);
const attendanceRoutes = require("../../routes/attendanceRoutes.js");
const validateAssignedScheduleUpload = attendanceRoutes.validateAssignedScheduleUpload;

/**
 * UNIT TESTS FOR ATTENDANCE CHECK-IN VALIDATION
 * Covers fix for false 403 "Trainer can only upload for the assigned day and batch"
 */

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
    process.exit(1);
});

export async function runAttendanceValidationTests() {
    console.log("Running attendance validation unit tests...");

    const trainerIdStr = "507f1f77bcf86cd799439011";
    const collegeIdStr = "507f1f77bcf86cd799439012";
    const trainerObjectId = new mongoose.Types.ObjectId(trainerIdStr);
    const collegeObjectId = new mongoose.Types.ObjectId(collegeIdStr);

    const baseSchedule = {
        _id: new mongoose.Types.ObjectId(),
        trainerId: trainerObjectId,
        collegeId: collegeObjectId,
        dayNumber: 5
    };

    const testCases = [
        {
            name: "Parity: String ID vs ObjectId in schedule",
            args: {
                schedule: baseSchedule,
                trainerId: trainerIdStr,
                collegeId: collegeIdStr,
                dayNumber: 5
            },
            expectSuccess: true
        },
        {
            name: "Parity: ObjectId in request vs ObjectId in schedule",
            args: {
                schedule: baseSchedule,
                trainerId: trainerObjectId,
                collegeId: collegeObjectId,
                dayNumber: 5
            },
            expectSuccess: true
        },
        {
            name: "Parity: Populated object with _id vs ObjectId",
            args: {
                schedule: { ...baseSchedule, trainerId: { _id: trainerObjectId } },
                trainerId: trainerIdStr,
                collegeId: collegeIdStr,
                dayNumber: 5
            },
            expectSuccess: true
        },
        {
            name: "Parity: Populated object with id vs ObjectId",
            args: {
                schedule: baseSchedule,
                trainerId: { id: trainerIdStr },
                collegeId: collegeIdStr,
                dayNumber: 5
            },
            expectSuccess: true
        },
        {
            name: "Parity: dayNumber String vs Number",
            args: {
                schedule: baseSchedule,
                trainerId: trainerIdStr,
                collegeId: collegeIdStr,
                dayNumber: "5"
            },
            expectSuccess: true
        },
        {
            name: "Reject: Mismatched Trainer ID",
            args: {
                schedule: baseSchedule,
                trainerId: "507f1f77bcf86cd799439013",
                collegeId: collegeIdStr,
                dayNumber: 5
            },
            expectSuccess: false,
            expectedStatus: 403,
            expectedMessage: "Trainer can only upload for the assigned day and batch"
        },
        {
            name: "Reject: Mismatched College ID",
            args: {
                schedule: baseSchedule,
                trainerId: trainerIdStr,
                collegeId: "507f1f77bcf86cd799439014",
                dayNumber: 5
            },
            expectSuccess: false,
            expectedStatus: 403,
            expectedMessage: "Trainer can only upload for the assigned batch and college"
        },
        {
            name: "Reject: Mismatched Day Number",
            args: {
                schedule: baseSchedule,
                trainerId: trainerIdStr,
                collegeId: collegeIdStr,
                dayNumber: 6
            },
            expectSuccess: false,
            expectedStatus: 403,
            expectedMessage: "Trainer can only upload for the assigned day"
        },
        {
            name: "Reject: Unassigned trainer in schedule",
            args: {
                schedule: { ...baseSchedule, trainerId: null },
                trainerId: trainerIdStr,
                collegeId: collegeIdStr,
                dayNumber: 5
            },
            expectSuccess: false,
            expectedStatus: 403,
            expectedMessage: "This day is not assigned to any trainer yet"
        },
        {
            name: "Reject: Inactive schedule",
            args: {
                schedule: { ...baseSchedule, isActive: false },
                trainerId: trainerIdStr,
                collegeId: collegeIdStr,
                dayNumber: 5
            },
            expectSuccess: false,
            expectedStatus: 403,
            expectedMessage: "This schedule is inactive and cannot be modified"
        },
        {
            name: "Reject: Cancelled schedule",
            args: {
                schedule: { ...baseSchedule, status: 'cancelled' },
                trainerId: trainerIdStr,
                collegeId: collegeIdStr,
                dayNumber: 5
            },
            expectSuccess: false,
            expectedStatus: 403,
            expectedMessage: "This training session is cancelled and no longer actionable"
        },
        {
            name: "Reject: Completed schedule",
            args: {
                schedule: { ...baseSchedule, status: 'COMPLETED' },
                trainerId: trainerIdStr,
                collegeId: collegeIdStr,
                dayNumber: 5
            },
            expectSuccess: false,
            expectedStatus: 403,
            expectedMessage: "This training day is already marked as COMPLETED. No further edits allowed."
        }
    ];

    for (const tc of testCases) {
        process.stdout.write(`  - ${tc.name} ... `);
        try {
            const result = validateAssignedScheduleUpload(tc.args);
            
            if (tc.expectSuccess) {
                assert.strictEqual(result, null, `Expected success but got ${JSON.stringify(result)}`);
            } else {
                assert.notStrictEqual(result, null, `Expected rejection but got success`);
                assert.strictEqual(result.status, tc.expectedStatus, `Expected status ${tc.expectedStatus} but got ${result.status}`);
                assert.strictEqual(result.message, tc.expectedMessage, `Expected message ${tc.expectedMessage} but got ${result.message}`);
            }
            console.log("PASS");
        } catch (err) {
            console.log("FAIL");
            console.error(`    ERROR in ${tc.name}:`, err.message);
            if (err.stack) console.error(err.stack);
            throw err; // Re-throw to catch it at the top
        }
    }

    console.log("All attendance validation unit tests passed!");
}

// Run only if called directly via node --import or similar
if (process.argv[1] && (process.argv[1].endsWith('attendance-validation.test.mjs') || process.argv[1].endsWith('attendance-validation.test.js'))) {
    runAttendanceValidationTests().catch(err => {
        console.error("Unit test execution failed:", err);
        process.exit(1);
    });
}
