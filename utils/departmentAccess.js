const normalizeRole = (role) => String(role || '').trim().toLowerCase();

const normalizeDepartment = (value) => String(value || '').trim().toLowerCase();

const toIdString = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
};

const parseDepartments = (departmentValue) => {
    if (Array.isArray(departmentValue)) {
        const values = departmentValue
            .map((item) => String(item || '').trim())
            .filter(Boolean);
        return values.length ? values : ['General'];
    }

    if (!departmentValue || typeof departmentValue !== 'string') {
        return ['General'];
    }

    const values = departmentValue
        .split(/[|,/]/)
        .map((item) => item.trim())
        .filter(Boolean);

    return values.length ? values : ['General'];
};

const getUserCompanyIds = (user) => {
    const ids = [];
    if (user?.companyId) ids.push(String(user.companyId));
    if (Array.isArray(user?.companyIds)) {
        user.companyIds.forEach((id) => {
            if (id) ids.push(String(id));
        });
    }
    return [...new Set(ids)];
};

const getUserCollegeIds = (user) => {
    const ids = [];
    if (user?.collegeId) ids.push(String(user.collegeId));
    if (Array.isArray(user?.collegeIds)) {
        user.collegeIds.forEach((id) => {
            if (id) ids.push(String(id));
        });
    }
    return [...new Set(ids)];
};

const isSuperAdminRole = (role) => {
    const normalized = normalizeRole(role);
    return normalized === 'superadmin' || normalized === 'admin';
};

const canAccessCollegeByCompany = ({ user, college }) => {
    const role = normalizeRole(user?.role);
    if (isSuperAdminRole(role)) return true;

    if (role === 'collegeadmin') {
        const collegeIds = getUserCollegeIds(user);
        if (collegeIds.length) {
            return collegeIds.includes(toIdString(college?._id));
        }

        const scopeMatched = Array.isArray(user?.departmeNDAccess)
            && user.departmeNDAccess.some((scope) => scopeMatchesCollege(scope, college));
        if (scopeMatched) return true;

        const userEmail = String(user?.email || '').toLowerCase();
        const collegeEmail = String(college?.email || '').toLowerCase();
        if (userEmail && collegeEmail && userEmail === collegeEmail) return true;

        return false;
    }

    const companyScopedRoles = new Set(['companyadmin', 'company', 'accouNDAnt', 'spocadmin']);

    if (!companyScopedRoles.has(role)) return true;

    const companyIds = getUserCompanyIds(user);
    if (!companyIds.length) return true; // Backward compatible fallback

    return companyIds.includes(toIdString(college?.companyId));
};

const scopeMatchesCollege = (scope, college) => {
    if (!scope || !college) return false;

    if (scope.companyId && toIdString(scope.companyId) !== toIdString(college.companyId)) {
        return false;
    }
    if (scope.courseId && toIdString(scope.courseId) !== toIdString(college.courseId)) {
        return false;
    }
    if (scope.collegeId && toIdString(scope.collegeId) !== toIdString(college._id)) {
        return false;
    }

    return true;
};

const hasWildcardDepartments = (departments = []) => {
    return departments.some((dep) => {
        const value = normalizeDepartment(dep);
        return value === '*' || value === 'all' || value === 'any' || value === 'all departments';
    });
};

const resolveVisibleDepartments = ({ user, college, requestedDepartment, salaryDepartments = [] }) => {
    const allDepartments = parseDepartments(college?.department);
    const role = normalizeRole(user?.role);

    if (isSuperAdminRole(role)) {
        const requestedAllowed = !requestedDepartment
            || allDepartments.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));
        return { visibleDepartments: allDepartments, requestedAllowed };
    }

    const scopes = Array.isArray(user?.departmeNDAccess)
        ? user.departmeNDAccess.filter((scope) => scopeMatchesCollege(scope, college))
        : [];

    if (role === 'companyadmin' || role === 'company' || role === 'spocadmin' || role === 'collegeadmin') {
        const requestedAllowed = !requestedDepartment
            || allDepartments.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));
        return { visibleDepartments: allDepartments, requestedAllowed };
    }

    if (role === 'trainer') {
        if (!scopes.length) {
            // Strict default: trainer must have explicit mapping unless college has only one department.
            const fallback = allDepartments.length === 1 ? allDepartments : [];
            const requestedAllowed = !requestedDepartment
                || fallback.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));
            return { visibleDepartments: fallback, requestedAllowed };
        }
    }

    if (role === 'accouNDAnt') {
        const salaryDepartmentValues = Array.isArray(salaryDepartments)
            ? salaryDepartments.map((dep) => String(dep || '').trim()).filter(Boolean)
            : parseDepartments(salaryDepartments);
        const salarySet = new Set(
            salaryDepartmentValues
                .map((dep) => normalizeDepartment(dep))
                .filter(Boolean)
        );
        const salaryVisible = allDepartments.filter((dep) => salarySet.has(normalizeDepartment(dep)));

        if (!scopes.length) {
            const requestedAllowed = !requestedDepartment
                || salaryVisible.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));
            return { visibleDepartments: salaryVisible, requestedAllowed };
        }

        const scopedDepartments = scopes.flatMap((scope) => Array.isArray(scope.departments) ? scope.departments : []);
        if (hasWildcardDepartments(scopedDepartments)) {
            const requestedAllowed = !requestedDepartment
                || salaryVisible.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));
            return { visibleDepartments: salaryVisible, requestedAllowed };
        }

        const scopedSet = new Set(
            scopedDepartments
                .map((dep) => normalizeDepartment(dep))
                .filter(Boolean)
        );
        const intersected = salaryVisible.filter((dep) => scopedSet.has(normalizeDepartment(dep)));
        const requestedAllowed = !requestedDepartment
            || intersected.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));
        return { visibleDepartments: intersected, requestedAllowed };
    }

    if (!scopes.length) {
        const requestedAllowed = !requestedDepartment
            || allDepartments.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));
        return { visibleDepartments: allDepartments, requestedAllowed };
    }

    const scopedDepartments = scopes.flatMap((scope) => Array.isArray(scope.departments) ? scope.departments : []);
    if (hasWildcardDepartments(scopedDepartments)) {
        const requestedAllowed = !requestedDepartment
            || allDepartments.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));
        return { visibleDepartments: allDepartments, requestedAllowed };
    }

    const allowedSet = new Set(
        scopedDepartments
            .map((dep) => normalizeDepartment(dep))
            .filter(Boolean)
    );

    const visibleDepartments = allDepartments.filter((dep) => allowedSet.has(normalizeDepartment(dep)));

    const requestedAllowed = !requestedDepartment
        || visibleDepartments.some((dep) => normalizeDepartment(dep) === normalizeDepartment(requestedDepartment));

    return { visibleDepartments, requestedAllowed };
};

module.exports = {
    normalizeRole,
    parseDepartments,
    getUserCompanyIds,
    getUserCollegeIds,
    canAccessCollegeByCompany,
    resolveVisibleDepartments,
};
