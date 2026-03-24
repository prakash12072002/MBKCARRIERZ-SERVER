const {
    Course,
    College,
    Department,
    Schedule,
    Attendance,
    CheckIn,
    CheckOut,
    Complaint,
    Student,
    UserDepartmentAccess,
} = require('../models');

const toIdString = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const uniqueIds = (values = []) => {
    return [...new Set(values.map(toIdString).filter(Boolean))];
};

const hasFilter = (filter = {}) => {
    return filter && Object.keys(filter).length > 0;
};

const getScheduleIds = async (filter = {}) => {
    if (!hasFilter(filter)) return [];
    const scheduleIds = await Schedule.find(filter).distinct('_id');
    return uniqueIds(scheduleIds);
};

const deleteScheduleDependenciesByIds = async (scheduleIds = []) => {
    const ids = uniqueIds(scheduleIds);
    if (!ids.length) {
        return {
            schedulesDeleted: 0,
            attendanceDeleted: 0,
            checkInsDeleted: 0,
            checkOutsDeleted: 0,
            complaintsDeletedBySchedule: 0,
        };
    }

    const [attendanceResult, checkInResult, checkOutResult, complaintResult, scheduleResult] = await Promise.all([
        Attendance.deleteMany({ scheduleId: { $in: ids } }),
        CheckIn.deleteMany({ scheduleId: { $in: ids } }),
        CheckOut.deleteMany({ scheduleId: { $in: ids } }),
        Complaint.deleteMany({ scheduleId: { $in: ids } }),
        Schedule.deleteMany({ _id: { $in: ids } }),
    ]);

    return {
        schedulesDeleted: scheduleResult?.deletedCount || 0,
        attendanceDeleted: attendanceResult?.deletedCount || 0,
        checkInsDeleted: checkInResult?.deletedCount || 0,
        checkOutsDeleted: checkOutResult?.deletedCount || 0,
        complaintsDeletedBySchedule: complaintResult?.deletedCount || 0,
    };
};

const deleteSchedulesAndDependenciesByFilter = async (filter = {}) => {
    const scheduleIds = await getScheduleIds(filter);
    return deleteScheduleDependenciesByIds(scheduleIds);
};

const cascadeDeleteDepartmentsByIds = async (departmentIds = []) => {
    const ids = uniqueIds(departmentIds);
    if (!ids.length) {
        return {
            departmentsDeleted: 0,
            departmentAccessDeleted: 0,
        };
    }

    const scheduleCleanup = await deleteSchedulesAndDependenciesByFilter({ departmentId: { $in: ids } });

    const [accessResult, departmentResult] = await Promise.all([
        UserDepartmentAccess.deleteMany({ departmentId: { $in: ids } }),
        Department.deleteMany({ _id: { $in: ids } }),
    ]);

    return {
        ...scheduleCleanup,
        departmentsDeleted: departmentResult?.deletedCount || 0,
        departmentAccessDeleted: accessResult?.deletedCount || 0,
    };
};

const cascadeDeleteCollegesByIds = async (collegeIds = []) => {
    const ids = uniqueIds(collegeIds);
    if (!ids.length) {
        return {
            collegesDeleted: 0,
        };
    }

    const colleges = await College.find({ _id: { $in: ids } }).select('_id courseId').lean();
    const existingCollegeIds = uniqueIds(colleges.map((college) => college._id));
    if (!existingCollegeIds.length) {
        return {
            collegesDeleted: 0,
        };
    }

    const departmentIds = uniqueIds(await Department.find({ collegeId: { $in: existingCollegeIds } }).distinct('_id'));
    const departmentCleanup = await cascadeDeleteDepartmentsByIds(departmentIds);
    const scheduleCleanup = await deleteSchedulesAndDependenciesByFilter({ collegeId: { $in: existingCollegeIds } });

    const [attendanceResult, complaintResult, studentResult, collegeResult] = await Promise.all([
        Attendance.deleteMany({ collegeId: { $in: existingCollegeIds } }),
        Complaint.deleteMany({ collegeId: { $in: existingCollegeIds } }),
        Student.deleteMany({ collegeId: { $in: existingCollegeIds } }),
        College.deleteMany({ _id: { $in: existingCollegeIds } }),
    ]);

    const courseIds = uniqueIds(colleges.map((college) => college.courseId));
    if (courseIds.length) {
        await Course.updateMany(
            { _id: { $in: courseIds } },
            { $pull: { colleges: { $in: existingCollegeIds } } },
        );
    }

    return {
        ...departmentCleanup,
        ...scheduleCleanup,
        collegesDeleted: collegeResult?.deletedCount || 0,
        attendanceDeletedByCollege: attendanceResult?.deletedCount || 0,
        complaintsDeletedByCollege: complaintResult?.deletedCount || 0,
        studentsDeletedByCollege: studentResult?.deletedCount || 0,
    };
};

const cascadeDeleteCoursesByIds = async (courseIds = []) => {
    const ids = uniqueIds(courseIds);
    if (!ids.length) {
        return {
            coursesDeleted: 0,
        };
    }

    const existingCourseIds = uniqueIds(await Course.find({ _id: { $in: ids } }).distinct('_id'));
    if (!existingCourseIds.length) {
        return {
            coursesDeleted: 0,
        };
    }

    const collegeIds = uniqueIds(await College.find({ courseId: { $in: existingCourseIds } }).distinct('_id'));
    const collegeCleanup = await cascadeDeleteCollegesByIds(collegeIds);

    const strayDepartmentIds = uniqueIds(await Department.find({ courseId: { $in: existingCourseIds } }).distinct('_id'));
    const departmentCleanup = await cascadeDeleteDepartmentsByIds(strayDepartmentIds);
    const scheduleCleanup = await deleteSchedulesAndDependenciesByFilter({ courseId: { $in: existingCourseIds } });

    const [attendanceResult, complaintResult, studentResult, courseResult] = await Promise.all([
        Attendance.deleteMany({ courseId: { $in: existingCourseIds } }),
        Complaint.deleteMany({ courseId: { $in: existingCourseIds } }),
        Student.deleteMany({ courseId: { $in: existingCourseIds } }),
        Course.deleteMany({ _id: { $in: existingCourseIds } }),
    ]);

    return {
        ...collegeCleanup,
        ...departmentCleanup,
        ...scheduleCleanup,
        coursesDeleted: courseResult?.deletedCount || 0,
        attendanceDeletedByCourse: attendanceResult?.deletedCount || 0,
        complaintsDeletedByCourse: complaintResult?.deletedCount || 0,
        studentsDeletedByCourse: studentResult?.deletedCount || 0,
    };
};

const cascadeDeleteCompanyHierarchy = async (companyId) => {
    const companyIdValue = toIdString(companyId);
    if (!companyIdValue) {
        return {
            coursesDeleted: 0,
            collegesDeleted: 0,
            departmentsDeleted: 0,
        };
    }

    const courseIds = uniqueIds(await Course.find({ companyId: companyIdValue }).distinct('_id'));
    const courseCleanup = await cascadeDeleteCoursesByIds(courseIds);

    const leftoverCollegeIds = uniqueIds(await College.find({ companyId: companyIdValue }).distinct('_id'));
    const collegeCleanup = await cascadeDeleteCollegesByIds(leftoverCollegeIds);

    const leftoverDepartmentIds = uniqueIds(await Department.find({ companyId: companyIdValue }).distinct('_id'));
    const departmentCleanup = await cascadeDeleteDepartmentsByIds(leftoverDepartmentIds);
    const scheduleCleanup = await deleteSchedulesAndDependenciesByFilter({ companyId: companyIdValue });

    const [complaintResult, studentResult] = await Promise.all([
        Complaint.deleteMany({ companyId: companyIdValue }),
        Student.deleteMany({ companyId: companyIdValue }),
    ]);

    return {
        ...courseCleanup,
        ...collegeCleanup,
        ...departmentCleanup,
        ...scheduleCleanup,
        complaintsDeletedByCompany: complaintResult?.deletedCount || 0,
        studentsDeletedByCompany: studentResult?.deletedCount || 0,
    };
};

module.exports = {
    cascadeDeleteDepartmentsByIds,
    cascadeDeleteCollegesByIds,
    cascadeDeleteCoursesByIds,
    cascadeDeleteCompanyHierarchy,
};
