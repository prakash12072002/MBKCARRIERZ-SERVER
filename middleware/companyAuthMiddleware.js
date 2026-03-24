const jwt = require('jsonwebtoken');

// Middleware to require CompanyAdmin role
const requireCompanyAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required'
        });
    }

    const role = String(req.user.role || '').toLowerCase();
    if (role !== 'companyadmin') {
        return res.status(403).json({
            success: false,
            message: 'Access denied. Company admin access required.'
        });
    }

    next();
};

// Middleware to block all editing operations for company admins
const blockCompanyEdits = (req, res, next) => {
    const role = String(req.user?.role || '').toLowerCase();
    if (role === 'companyadmin') {
        if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Company admins have read-only access.'
            });
        }
    }
    next();
};

// Middleware to ensure only GET requests for company admins
const companyViewOnly = (req, res, next) => {
    const role = String(req.user?.role || '').toLowerCase();
    if (role === 'companyadmin') {
        if (req.method !== 'GET') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Company admins can only view data.'
            });
        }
    }
    next();
};

module.exports = {
    requireCompanyAdmin,
    blockCompanyEdits,
    companyViewOnly
};
