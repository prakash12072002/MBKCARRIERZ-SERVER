const normalizeTrainingRole = (value) => String(value || "").trim().toLowerCase();

const TRAINING_PLATFORM_ROLE_KEYS = Object.freeze({
  SUPER_ADMIN: "superadmin",
  ADMIN: "admin",
  SPOC_ADMIN: "spocadmin",
  TRAINER: "trainer",
  COLLEGE_ADMIN: "collegeadmin",
  COMPANY_ADMIN: "companyadmin",
  COMPANY: "company",
});

const TRAINING_HIERARCHY_MANAGER_ROLES = new Set([
  TRAINING_PLATFORM_ROLE_KEYS.SUPER_ADMIN,
  TRAINING_PLATFORM_ROLE_KEYS.ADMIN,
]);

const TRAINING_ASSIGNMENT_MANAGER_ROLES = new Set([
  TRAINING_PLATFORM_ROLE_KEYS.SUPER_ADMIN,
  TRAINING_PLATFORM_ROLE_KEYS.ADMIN,
  TRAINING_PLATFORM_ROLE_KEYS.SPOC_ADMIN,
  TRAINING_PLATFORM_ROLE_KEYS.COLLEGE_ADMIN,
]);

const TRAINING_FILE_MANAGER_ROLES = new Set([
  TRAINING_PLATFORM_ROLE_KEYS.SUPER_ADMIN,
  TRAINING_PLATFORM_ROLE_KEYS.ADMIN,
  TRAINING_PLATFORM_ROLE_KEYS.SPOC_ADMIN,
  TRAINING_PLATFORM_ROLE_KEYS.COLLEGE_ADMIN,
]);

const TRAINING_FILE_VIEWER_ROLES = new Set([
  ...TRAINING_FILE_MANAGER_ROLES,
  TRAINING_PLATFORM_ROLE_KEYS.COMPANY_ADMIN,
  TRAINING_PLATFORM_ROLE_KEYS.COMPANY,
  TRAINING_PLATFORM_ROLE_KEYS.TRAINER,
]);

const canManageTrainingHierarchy = (role) =>
  TRAINING_HIERARCHY_MANAGER_ROLES.has(normalizeTrainingRole(role));

const canAssignTrainingDays = (role) =>
  TRAINING_ASSIGNMENT_MANAGER_ROLES.has(normalizeTrainingRole(role));

const canManageTrainingFiles = (role) =>
  TRAINING_FILE_MANAGER_ROLES.has(normalizeTrainingRole(role));

const canViewTrainingFiles = (role) =>
  TRAINING_FILE_VIEWER_ROLES.has(normalizeTrainingRole(role));

const isTrainerRole = (role) =>
  normalizeTrainingRole(role) === TRAINING_PLATFORM_ROLE_KEYS.TRAINER;

module.exports = {
  TRAINING_PLATFORM_ROLE_KEYS,
  normalizeTrainingRole,
  canManageTrainingHierarchy,
  canAssignTrainingDays,
  canManageTrainingFiles,
  canViewTrainingFiles,
  isTrainerRole,
};
