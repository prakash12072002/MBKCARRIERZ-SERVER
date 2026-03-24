const jwt = require("jsonwebtoken");

const auth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) return res.status(401).json({ message: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
};

const authenticateOptional = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
    }
    next();
  } catch (err) {
    // If token is invalid, we still proceed but without req.user
    next();
  }
};

const authorize = (roles = []) => {
  if (typeof roles === "string") {
    roles = [roles];
  }

  return (req, res, next) => {
    const normalizeRole = (value) => String(value || "").trim().toLowerCase();
    const userRole = normalizeRole(req.user?.role);
    const allowedRoles = roles.map(normalizeRole);

    if (!req.user || (allowedRoles.length && !allowedRoles.includes(userRole))) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
};

module.exports = { 
  auth, 
  authenticate: auth,
  authenticateOptional,
  authorize,
  checkRole: authorize
};
