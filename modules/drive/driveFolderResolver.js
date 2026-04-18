const DRIVE_DAY_SUBFOLDERS = Object.freeze({
  attendance: "Attendance",
  geoTag: "GeoTag",
});

const toFolderString = (value) => {
  const normalized = String(value || "").trim();
  return normalized || null;
};

const buildScheduleFolderFields = ({
  dayEntry,
  fallbackDayFolderId = null,
  fallbackDayFolderName = null,
  fallbackDayFolderLink = null,
  fallbackAttendanceFolderId = null,
  fallbackAttendanceFolderName = null,
  fallbackAttendanceFolderLink = null,
  fallbackGeoTagFolderId = null,
  fallbackGeoTagFolderName = null,
  fallbackGeoTagFolderLink = null,
}) => {
  const dayFolderId = toFolderString(dayEntry?.folderId) || toFolderString(fallbackDayFolderId);
  const dayFolderName =
    toFolderString(dayEntry?.folderName) ||
    toFolderString(dayEntry?.name) ||
    toFolderString(fallbackDayFolderName);
  const dayFolderLink =
    toFolderString(dayEntry?.folderLink) ||
    toFolderString(dayEntry?.link) ||
    toFolderString(fallbackDayFolderLink);

  const attendanceFolderId =
    toFolderString(dayEntry?.attendanceFolderId) ||
    toFolderString(dayEntry?.attendanceFolder?.id) ||
    toFolderString(fallbackAttendanceFolderId);
  const attendanceFolderName =
    toFolderString(dayEntry?.attendanceFolderName) ||
    toFolderString(dayEntry?.attendanceFolder?.name) ||
    toFolderString(fallbackAttendanceFolderName);
  const attendanceFolderLink =
    toFolderString(dayEntry?.attendanceFolderLink) ||
    toFolderString(dayEntry?.attendanceFolder?.link) ||
    toFolderString(fallbackAttendanceFolderLink);

  const geoTagFolderId =
    toFolderString(dayEntry?.geoTagFolderId) ||
    toFolderString(dayEntry?.geoTagFolder?.id) ||
    toFolderString(fallbackGeoTagFolderId);
  const geoTagFolderName =
    toFolderString(dayEntry?.geoTagFolderName) ||
    toFolderString(dayEntry?.geoTagFolder?.name) ||
    toFolderString(fallbackGeoTagFolderName);
  const geoTagFolderLink =
    toFolderString(dayEntry?.geoTagFolderLink) ||
    toFolderString(dayEntry?.geoTagFolder?.link) ||
    toFolderString(fallbackGeoTagFolderLink);

  return {
    dayFolderId,
    dayFolderName,
    dayFolderLink,
    attendanceFolderId,
    attendanceFolderName,
    attendanceFolderLink,
    geoTagFolderId,
    geoTagFolderName,
    geoTagFolderLink,
    // Backward compatibility for existing consumers
    driveFolderId: dayFolderId,
    driveFolderName: dayFolderName,
    driveFolderLink: dayFolderLink,
  };
};

module.exports = {
  DRIVE_DAY_SUBFOLDERS,
  toFolderString,
  buildScheduleFolderFields,
};

