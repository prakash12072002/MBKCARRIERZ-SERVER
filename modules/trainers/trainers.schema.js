const {
  TRAINER_DIRECTORY_SORT,
  DEFAULT_TRAINER_DIRECTORY_PAGE,
  DEFAULT_TRAINER_DIRECTORY_LIMIT,
  MAX_TRAINER_DIRECTORY_LIMIT,
} = require("./trainers.types");

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const toSafeTrimmedString = (value) => String(value || "").trim();

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toSortMode = (value) => {
  const normalized = toSafeTrimmedString(value).toLowerCase();
  if (Object.values(TRAINER_DIRECTORY_SORT).includes(normalized)) {
    return normalized;
  }
  return TRAINER_DIRECTORY_SORT.NEWEST;
};

const toSortStage = (sortMode) => {
  if (sortMode === TRAINER_DIRECTORY_SORT.OLDEST) {
    return { createdAt: 1, _id: 1 };
  }
  if (sortMode === TRAINER_DIRECTORY_SORT.NAME_ASC) {
    return { userSortName: 1, createdAt: -1, _id: -1 };
  }
  if (sortMode === TRAINER_DIRECTORY_SORT.NAME_DESC) {
    return { userSortName: -1, createdAt: -1, _id: -1 };
  }
  return { createdAt: -1, _id: -1 };
};

const parseTrainerDirectoryQuery = (query = {}) => {
  const page = toPositiveInteger(query.page, DEFAULT_TRAINER_DIRECTORY_PAGE);
  const requestedLimit = toPositiveInteger(
    query.limit,
    DEFAULT_TRAINER_DIRECTORY_LIMIT,
  );
  const limit = Math.min(requestedLimit, MAX_TRAINER_DIRECTORY_LIMIT);
  const sort = toSortMode(query.sort);
  const search = toSafeTrimmedString(query.search);
  const city = toSafeTrimmedString(query.city);
  const skip = (page - 1) * limit;

  return {
    page,
    limit,
    skip,
    sort,
    sortStage: toSortStage(sort),
    search,
    city,
    hasSearch: Boolean(search),
    hasCity: Boolean(city),
    searchRegex: search ? new RegExp(escapeRegex(search), "i") : null,
    cityRegex: city ? new RegExp(`^${escapeRegex(city)}$`, "i") : null,
  };
};

module.exports = {
  parseTrainerDirectoryQuery,
  escapeRegex,
};

