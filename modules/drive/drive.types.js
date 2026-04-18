const DRIVE_DAY_SUBFOLDERS = Object.freeze({
  attendance: "Attendance",
  geoTag: "GeoTag",
});

const DRIVE_LEGACY_FOLDER_NAMES = Object.freeze({
  checkout: "Checkout",
});

const DRIVE_SYNC_SUMMARY_FIELDS = Object.freeze([
  "totalScanned",
  "candidateMatches",
  "attendanceWouldBackfill",
  "geoWouldBackfill",
  "refreshedLinksWouldChange",
  "duplicateDayFoldersWouldClear",
  "canonicalMappingsWouldChange",
  "skippedAmbiguous",
  "unchanged",
  "warnings",
  "errors",
]);

module.exports = {
  DRIVE_DAY_SUBFOLDERS,
  DRIVE_LEGACY_FOLDER_NAMES,
  DRIVE_SYNC_SUMMARY_FIELDS,
};

