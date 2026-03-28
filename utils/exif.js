const fs = require('fs');

let jpegExif = null;
try {
    jpegExif = require('jpeg-exif');
} catch (error) {
    jpegExif = null;
}

const toPlainObject = (value) => {
    if (!value || typeof value !== 'object') return null;
    if (!Array.isArray(value)) return value;

    return value.reduce((result, entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            return { ...result, ...entry };
        }
        return result;
    }, {});
};

const toDecimalCoordinate = (coordinate, ref) => {
    if (!Array.isArray(coordinate) || coordinate.length < 3) return null;

    const degrees = Number(coordinate[0]);
    const minutes = Number(coordinate[1]);
    const seconds = Number(coordinate[2]);

    if (![degrees, minutes, seconds].every(Number.isFinite)) return null;

    const decimal = degrees + (minutes / 60) + (seconds / 3600);
    return ['S', 'W'].includes(String(ref || '').trim().toUpperCase()) ? -decimal : decimal;
};

const parseExifDate = (value) => {
    if (!value) return null;

    const normalized = String(value).trim();
    const match = normalized.match(
        /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
    );

    if (!match) return null;

    const [, year, month, day, hour, minute, second] = match;
    const parsed = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
    );

    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getGeoTagData = (filePath) => {
    if (!filePath || !jpegExif || !fs.existsSync(filePath)) {
        return null;
    }

    try {
        const exifData = jpegExif.parseSync(filePath);
        const gpsInfo = toPlainObject(exifData?.GPSInfo) || {};
        const subExif = toPlainObject(exifData?.SubExif) || {};

        const latitude = toDecimalCoordinate(gpsInfo.GPSLatitude, gpsInfo.GPSLatitudeRef);
        const longitude = toDecimalCoordinate(gpsInfo.GPSLongitude, gpsInfo.GPSLongitudeRef);
        const capturedAt = parseExifDate(
            subExif.DateTimeOriginal
            || subExif.CreateDate
            || exifData?.DateTimeOriginal
            || exifData?.CreateDate,
        );

        return {
            latitude,
            longitude,
            capturedAt,
            timestamp: capturedAt ? Math.floor(capturedAt.getTime() / 1000) : null,
            hasGps: Number.isFinite(latitude) && Number.isFinite(longitude),
            raw: exifData,
        };
    } catch (error) {
        return null;
    }
};

module.exports = {
    getGeoTagData,
};
