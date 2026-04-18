const DEFAULT_COMPLAINT_PAGE_LIMIT = 10;
const MAX_COMPLAINT_PAGE_LIMIT = 50;

const COMPLAINT_ALLOWED_LIST_ROLES = Object.freeze([
  "superadmin",
  "trainer",
  "spocadmin",
  "collegeadmin",
  "accountant",
  "accoundant",
]);

const COMPLAINT_ALLOWED_UPDATE_ROLES = Object.freeze([
  "superadmin",
  "spocadmin",
]);

const COMPLAINT_ALLOWED_CREATE_ROLES = Object.freeze([
  "trainer",
]);

module.exports = {
  DEFAULT_COMPLAINT_PAGE_LIMIT,
  MAX_COMPLAINT_PAGE_LIMIT,
  COMPLAINT_ALLOWED_LIST_ROLES,
  COMPLAINT_ALLOWED_UPDATE_ROLES,
  COMPLAINT_ALLOWED_CREATE_ROLES,
};
