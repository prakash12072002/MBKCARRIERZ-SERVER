const express = require("express");
const router = express.Router();
const { authenticate, authorize } = require("../middleware/auth");
const { Company, Course, College, Department, Schedule } = require("../models");
const {
  createFullStructure,
  ensureCompanyHierarchy,
  ensureCourseHierarchy,
  ensureCollegeHierarchy,
  ensureDepartmentHierarchy,
  isTrainingDriveEnabled,
  toDepartmentDayFolders,
} = require("../services/googleDriveTrainingHierarchyService");

const applyDriveFolderFields = (doc, folder) => {
  if (!doc || !folder?.id) return false;

  const nextId = folder.id || null;
  const nextName = folder.name || null;
  const nextLink = folder.link || null;

  if (
    doc.driveFolderId === nextId &&
    doc.driveFolderName === nextName &&
    doc.driveFolderLink === nextLink
  ) {
    return false;
  }

  doc.driveFolderId = nextId;
  doc.driveFolderName = nextName;
  doc.driveFolderLink = nextLink;
  return true;
};

const buildScheduleFolderUpdate = (dayFolder) => ({
  dayFolderId: dayFolder?.id || null,
  dayFolderName: dayFolder?.name || null,
  dayFolderLink: dayFolder?.link || null,
  attendanceFolderId: dayFolder?.attendanceFolder?.id || null,
  attendanceFolderName: dayFolder?.attendanceFolder?.name || null,
  attendanceFolderLink: dayFolder?.attendanceFolder?.link || null,
  geoTagFolderId: dayFolder?.geoTagFolder?.id || null,
  geoTagFolderName: dayFolder?.geoTagFolder?.name || null,
  geoTagFolderLink: dayFolder?.geoTagFolder?.link || null,
  driveFolderId: dayFolder?.id || null,
  driveFolderName: dayFolder?.name || null,
  driveFolderLink: dayFolder?.link || null,
});

router.post(
  "/full-structure",
  authenticate,
  authorize(["SuperAdmin", "Admin"]),
  async (req, res) => {
    try {
      const { company, course, college, department, batch, rootFolderId, totalDays } =
        req.body || {};

      if (!company || !course || !(batch || college || department)) {
        return res.status(400).json({
          success: false,
          message:
            "company and course are required. Provide batch or provide college/department so batch can be generated.",
        });
      }

      if (!isTrainingDriveEnabled() && !String(rootFolderId || "").trim()) {
        return res.status(400).json({
          success: false,
          message:
            "Google Drive training root folder is not configured. Set GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_ID (or GOOGLE_DRIVE_TRAINING_PARENT_FOLDER_ID) or pass rootFolderId in request.",
        });
      }

      const structure = await createFullStructure({
        company,
        course,
        college,
        department: department || null,
        // Important: only pass explicit batch when user provides one.
        // Otherwise let service derive stable batch name from college+department.
        batch: batch || null,
        rootFolderId,
        totalDays,
      });

      return res.status(201).json({
        success: true,
        message:
          "Drive hierarchy created successfully (Trainer-Uploads > Company > Course > [College] > Department/Batch > Day_1..Day_12 with Attendance and GeoTag subfolders).",
        data: structure,
      });
    } catch (error) {
      console.error("[GOOGLE-DRIVE] full-structure API error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create full Drive hierarchy",
        error: error.message,
      });
    }
  },
);

router.post(
  "/sync-db",
  authenticate,
  authorize(["SuperAdmin", "Admin"]),
  async (req, res) => {
    try {
      const { companyId, courseId, collegeId, departmentId, totalDays } = req.body || {};

      if (!isTrainingDriveEnabled()) {
        return res.status(400).json({
          success: false,
          message:
            "Google Drive training root folder is not configured. Set GOOGLE_DRIVE_TRAINING_ROOT_FOLDER_ID or GOOGLE_DRIVE_TRAINING_PARENT_FOLDER_ID first.",
        });
      }

      const counts = {
        companiesSynced: 0,
        coursesSynced: 0,
        collegesSynced: 0,
        departmentsSynced: 0,
        schedulesUpdated: 0,
      };

      const requestedDepartment = departmentId
        ? await Department.findById(departmentId).select(
            "_id name companyId courseId collegeId driveFolderId driveFolderName driveFolderLink dayFolders",
          )
        : null;
      if (departmentId && !requestedDepartment) {
        return res.status(404).json({ success: false, message: "Department not found" });
      }

      const requestedCollege = collegeId
        ? await College.findById(collegeId).select(
            "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
          )
        : requestedDepartment?.collegeId
          ? await College.findById(requestedDepartment.collegeId).select(
              "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
            )
          : null;
      if ((collegeId || requestedDepartment?.collegeId) && !requestedCollege) {
        return res.status(404).json({ success: false, message: "College not found" });
      }

      const requestedCourse = courseId
        ? await Course.findById(courseId).select(
            "_id title companyId driveFolderId driveFolderName driveFolderLink",
          )
        : requestedCollege?.courseId
          ? await Course.findById(requestedCollege.courseId).select(
              "_id title companyId driveFolderId driveFolderName driveFolderLink",
            )
          : requestedDepartment?.courseId
            ? await Course.findById(requestedDepartment.courseId).select(
                "_id title companyId driveFolderId driveFolderName driveFolderLink",
              )
            : null;
      if (courseId && !requestedCourse) {
        return res.status(404).json({ success: false, message: "Course not found" });
      }

      const resolvedCompanyId =
        companyId ||
        requestedCourse?.companyId ||
        requestedCollege?.companyId ||
        requestedDepartment?.companyId ||
        null;

      const companies = resolvedCompanyId
        ? await Company.find({ _id: resolvedCompanyId }).select(
            "_id name driveFolderId driveFolderName driveFolderLink",
          )
        : await Company.find({}).select("_id name driveFolderId driveFolderName driveFolderLink");

      if (!companies.length) {
        return res.status(404).json({ success: false, message: "No companies found to sync" });
      }

      for (const company of companies) {
        const companyHierarchy = await ensureCompanyHierarchy({ company });
        if (applyDriveFolderFields(company, companyHierarchy?.companyFolder)) {
          await company.save();
        }
        counts.companiesSynced += 1;

        const courseFilter = { companyId: company._id };
        if (requestedCourse?._id) {
          courseFilter._id = requestedCourse._id;
        }

        const courses = await Course.find(courseFilter).select(
          "_id title companyId driveFolderId driveFolderName driveFolderLink",
        );
        const courseMap = new Map();

        for (const course of courses) {
          const courseHierarchy = await ensureCourseHierarchy({ company, course });
          if (applyDriveFolderFields(company, courseHierarchy?.companyFolder)) {
            await company.save();
          }
          if (applyDriveFolderFields(course, courseHierarchy?.courseFolder)) {
            await course.save();
          }
          courseMap.set(String(course._id), course);
          counts.coursesSynced += 1;
        }

        const collegeFilter = { companyId: company._id };
        if (requestedCollege?._id) {
          collegeFilter._id = requestedCollege._id;
        } else if (requestedCourse?._id) {
          collegeFilter.courseId = requestedCourse._id;
        }

        const colleges = await College.find(collegeFilter).select(
          "_id name companyId courseId driveFolderId driveFolderName driveFolderLink",
        );

        for (const college of colleges) {
          const courseForCollege = college.courseId
            ? courseMap.get(String(college.courseId)) ||
              (await Course.findById(college.courseId).select(
                "_id title companyId driveFolderId driveFolderName driveFolderLink",
              ))
            : null;

          if (courseForCollege && !courseMap.has(String(courseForCollege._id))) {
            courseMap.set(String(courseForCollege._id), courseForCollege);
          }

          const collegeHierarchy = await ensureCollegeHierarchy({
            company,
            course: courseForCollege || null,
            college,
          });

          if (applyDriveFolderFields(company, collegeHierarchy?.companyFolder)) {
            await company.save();
          }

          if (courseForCollege && applyDriveFolderFields(courseForCollege, collegeHierarchy?.courseFolder)) {
            await courseForCollege.save();
          }

          if (applyDriveFolderFields(college, collegeHierarchy?.collegeFolder)) {
            await college.save();
          }
          counts.collegesSynced += 1;

          const departmentFilter = { collegeId: college._id };
          if (requestedDepartment?._id) {
            departmentFilter._id = requestedDepartment._id;
          }

          const departments = await Department.find(departmentFilter).select(
            "_id name companyId courseId collegeId driveFolderId driveFolderName driveFolderLink dayFolders",
          );

          for (const department of departments) {
            const schedules = await Schedule.find({ departmentId: department._id }).select(
              "_id dayNumber dayFolderId dayFolderName dayFolderLink attendanceFolderId attendanceFolderName attendanceFolderLink geoTagFolderId geoTagFolderName geoTagFolderLink driveFolderId driveFolderName driveFolderLink",
            );

            const maxScheduleDay = schedules.reduce(
              (maxDay, schedule) => Math.max(maxDay, Number(schedule.dayNumber) || 0),
              0,
            );
            const normalizedTotalDays = Math.max(
              Number(totalDays) || 0,
              maxScheduleDay,
              12,
            );

            const departmentHierarchy = await ensureDepartmentHierarchy({
              company,
              course: courseForCollege || null,
              college,
              department,
              totalDays: normalizedTotalDays,
            });

            if (applyDriveFolderFields(company, departmentHierarchy?.companyFolder)) {
              await company.save();
            }

            if (courseForCollege && applyDriveFolderFields(courseForCollege, departmentHierarchy?.courseFolder)) {
              await courseForCollege.save();
            }

            if (applyDriveFolderFields(college, departmentHierarchy?.collegeFolder)) {
              await college.save();
            }

            let shouldSaveDepartment = false;
            if (applyDriveFolderFields(department, departmentHierarchy?.departmentFolder)) {
              shouldSaveDepartment = true;
            }

            const dayFolders = toDepartmentDayFolders(
              departmentHierarchy?.dayFoldersByDayNumber || {},
            );
            if (JSON.stringify(department.dayFolders || []) !== JSON.stringify(dayFolders)) {
              department.dayFolders = dayFolders;
              shouldSaveDepartment = true;
            }

            if (shouldSaveDepartment) {
              await department.save();
            }
            counts.departmentsSynced += 1;

            const scheduleUpdates = schedules
              .map((schedule) => {
                const dayFolder =
                  departmentHierarchy?.dayFoldersByDayNumber?.[schedule.dayNumber] || null;
                if (!dayFolder?.id) return null;

                const nextFields = buildScheduleFolderUpdate(dayFolder);
                const changed = Object.entries(nextFields).some(
                  ([key, value]) => schedule[key] !== value,
                );
                if (!changed) return null;

                return {
                  updateOne: {
                    filter: { _id: schedule._id },
                    update: { $set: nextFields },
                  },
                };
              })
              .filter(Boolean);

            if (scheduleUpdates.length) {
              await Schedule.bulkWrite(scheduleUpdates, { ordered: false });
              counts.schedulesUpdated += scheduleUpdates.length;
            }
          }
        }
      }

      return res.json({
        success: true,
        message:
          "Drive folder IDs synced into Company, Course, College, Department, and Day records.",
        data: counts,
      });
    } catch (error) {
      console.error("[GOOGLE-DRIVE] sync-db API error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to sync Drive folder IDs into database",
        error: error.message,
      });
    }
  },
);

module.exports = router;
