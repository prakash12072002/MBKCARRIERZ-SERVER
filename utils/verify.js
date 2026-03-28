const { calculateDistance } = require('./distance');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_MAX_RADIUS_KM = 10;

const toZonedDateKey = (value, timeZone = DEFAULT_TIMEZONE) => {
    if (!value && value !== 0) return null;

    const normalizedValue =
        typeof value === 'number'
            ? new Date(value * 1000)
            : value instanceof Date
                ? value
                : new Date(value);

    if (Number.isNaN(normalizedValue.getTime())) return null;

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(normalizedValue);

    const year = parts.find((item) => item.type === 'year')?.value;
    const month = parts.find((item) => item.type === 'month')?.value;
    const day = parts.find((item) => item.type === 'day')?.value;

    return year && month && day ? `${year}-${month}-${day}` : null;
};

function verifyGeoTag({
    geoData,
    assignedDate,
    collegeLocation,
    maxRadiusKm = DEFAULT_MAX_RADIUS_KM,
    businessTimeZone = DEFAULT_TIMEZONE,
}) {
    const latitude = Number(geoData?.latitude);
    const longitude = Number(geoData?.longitude);
    const timestamp = geoData?.timestamp ?? null;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
            status: 'PENDING',
            reason: 'Location not matched',
            reasons: ['Location not matched'],
            distance: null,
            timestamp,
            latitude: null,
            longitude: null,
        };
    }

    const collegeLat = Number(collegeLocation?.lat);
    const collegeLng = Number(collegeLocation?.lng);
    const distance = calculateDistance(latitude, longitude, collegeLat, collegeLng);

    if (!Number.isFinite(distance) || distance > maxRadiusKm) {
        return {
            status: 'PENDING',
            reason: 'Location not matched',
            reasons: ['Location not matched'],
            distance: Number.isFinite(distance) ? Number(distance.toFixed(2)) : null,
            timestamp,
            latitude,
            longitude,
        };
    }

    const assignedDateKey = toZonedDateKey(assignedDate, businessTimeZone);
    const imageDateKey = toZonedDateKey(timestamp, businessTimeZone);

    if (!imageDateKey || imageDateKey !== assignedDateKey) {
        return {
            status: 'PENDING',
            reason: 'Date not matched',
            reasons: ['Date not matched'],
            distance: Number(distance.toFixed(2)),
            timestamp,
            latitude,
            longitude,
        };
    }

    return {
        status: 'COMPLETED',
        reason: 'Check-out completed',
        reasons: [],
        distance: Number(distance.toFixed(2)),
        timestamp,
        latitude,
        longitude,
    };
}

module.exports = {
    verifyGeoTag,
    toZonedDateKey,
};
