const { UserDepartmentAccess } = require('../models');

const normalizeRole = (role) => String(role || '').trim().toLowerCase();

const isSuperAdmin = (role) => {
    const normalized = normalizeRole(role);
    return normalized === 'superadmin' || normalized === 'admin';
};

const hasPermission = (permissions = [], requiredPermission = 'view') => {
    const normalizedPermissions = permissions.map((item) => String(item || '').trim().toLowerCase());
    if (!normalizedPermissions.length) {
        return requiredPermission === 'view';
    }

    return normalizedPermissions.includes(requiredPermission)
        || normalizedPermissions.includes('*')
        || normalizedPermissions.includes('all');
};

const authorizeDepartmentPermission = (requiredPermission = 'view') => async (req, res, next) => {
    try {
        const { departmentId } = req.params;
        const user = req.user;

        if (!user) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        if (isSuperAdmin(user.role)) {
            return next();
        }

        const access = await UserDepartmentAccess.findOne({
            userId: user.id || user._id,
            departmentId,
        }).select('permissions userId departmentId');

        if (access && hasPermission(access.permissions || [], requiredPermission)) {
            req.departmentAccess = access;
            req.departmeNDAccess = access;
            return next();
        }

        // Backward compatibility fallback for old departmentIds field.
        const userDepartmentIds = Array.isArray(user.departmentIds)
            ? user.departmentIds.map((id) => String(id))
            : [];
        if (requiredPermission === 'view' && userDepartmentIds.includes(String(departmentId))) {
            return next();
        }

        return res.status(403).json({
            message: 'Access denied to this department',
        });
    } catch (error) {
        console.error('authorizeDepartmentPermission error:', error);
        return res.status(500).json({ message: 'Failed to verify department access' });
    }
};

const authorizeDepartmeNDAccess = authorizeDepartmentPermission('view');

module.exports = {
    authorizeDepartmeNDAccess,
    authorizeDepartmentPermission,
};
