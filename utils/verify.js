const { calculateDistance } = require('./distance');
const { normalizeCollegeLocation } = require('./collegeLocation');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_MAX_RADIUS_KM = 10;
const DEFAULT_OCR_COORDINATE_TOLERANCE = 0.01;
const DEFAULT_OCR_TIME_TOLERANCE_SECONDS = 60 * 60;

const toNullableNumber = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
};

const toNullableTimestamp = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return Math.floor(parsed.getTime() / 1000);
};

const toEvidenceSnapshot = (source) => ({
    latitude: toNullableNumber(source?.latitude),
    longitude: toNullableNumber(source?.longitude),
    timestamp: toNullableTimestamp(source?.timestamp ?? source?.capturedAt),
    text: typeof source?.text === 'string'
        ? source.text.replace(/\s+/g, ' ').trim().slice(0, 500)
        : null,
});

const hasCoordinates = (source) => (
    Number.isFinite(source?.latitude) && Number.isFinite(source?.longitude)
);

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
    ocrData,
    assignedDate,
    collegeLocation,
    maxRadiusKm = DEFAULT_MAX_RADIUS_KM,
    businessTimeZone = DEFAULT_TIMEZONE,
}) {
    const exifEvidence = toEvidenceSnapshot(geoData);
    const ocrEvidence = toEvidenceSnapshot(ocrData);
    const geoMatch = hasCoordinates(exifEvidence) && hasCoordinates(ocrEvidence)
        ? (
            Math.abs(exifEvidence.latitude - ocrEvidence.latitude) <= DEFAULT_OCR_COORDINATE_TOLERANCE
            && Math.abs(exifEvidence.longitude - ocrEvidence.longitude) <= DEFAULT_OCR_COORDINATE_TOLERANCE
        )
        : null;
    const timeMatch = Number.isFinite(exifEvidence.timestamp) && Number.isFinite(ocrEvidence.timestamp)
        ? Math.abs(exifEvidence.timestamp - ocrEvidence.timestamp) <= DEFAULT_OCR_TIME_TOLERANCE_SECONDS
        : null;
    const latitude = hasCoordinates(exifEvidence) ? exifEvidence.latitude : ocrEvidence.latitude;
    const longitude = hasCoordinates(exifEvidence) ? exifEvidence.longitude : ocrEvidence.longitude;
    const timestamp = Number.isFinite(exifEvidence.timestamp) ? exifEvidence.timestamp : ocrEvidence.timestamp;
    const validationSource =
        hasCoordinates(exifEvidence) && Number.isFinite(exifEvidence.timestamp)
            ? 'exif'
            : (
                hasCoordinates(ocrEvidence) || Number.isFinite(ocrEvidence.timestamp)
                    ? (hasCoordinates(exifEvidence) || Number.isFinite(exifEvidence.timestamp) ? 'hybrid' : 'ocr')
                    : 'unknown'
            );
    const normalizedCollegeLocation = normalizeCollegeLocation(collegeLocation);
    const baseReport = {
        source: validationSource,
        exif: {
            latitude: exifEvidence.latitude,
            longitude: exifEvidence.longitude,
            timestamp: exifEvidence.timestamp,
        },
        ocr: {
            latitude: ocrEvidence.latitude,
            longitude: ocrEvidence.longitude,
            timestamp: ocrEvidence.timestamp,
            text: ocrEvidence.text,
        },
        comparisons: {
            geoMatch,
            timeMatch,
            collegeLatitude: toNullableNumber(normalizedCollegeLocation?.lat),
            collegeLongitude: toNullableNumber(normalizedCollegeLocation?.lng),
        },
    };

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
            status: 'PENDING',
            reason: 'Missing EXIF GPS metadata (latitude/longitude not found). Upload the original GPS camera JPG/JPEG with visible Lat/Long and Date/Time.',
            reasonCode: 'EXIF_GPS_MISSING',
            reasons: ['No readable location found'],
            missingFields: ['latitude', 'longitude'],
            distance: null,
            timestamp,
            latitude: null,
            longitude: null,
            validationSource,
            report: baseReport,
        };
    }

    // Keep EXIF/OCR comparisons for audit visibility, but do not block verification
    // when location+assigned-date checks pass. OCR stamp reads can be noisy.
    baseReport.comparisons.exifOcrGeoMismatch = geoMatch === false;
    baseReport.comparisons.exifOcrTimeMismatch = timeMatch === false;

    const collegeLat = Number(normalizedCollegeLocation?.lat);
    const collegeLng = Number(normalizedCollegeLocation?.lng);
    const distance = calculateDistance(latitude, longitude, collegeLat, collegeLng);

    if (!Number.isFinite(distance) || distance > maxRadiusKm) {
        return {
            status: 'PENDING',
            reason: 'Location not matched',
            reasonCode: 'LOCATION_MISMATCH',
            reasons: ['Location not matched'],
            distance: Number.isFinite(distance) ? Number(distance.toFixed(2)) : null,
            timestamp,
            latitude,
            longitude,
            validationSource,
            report: {
                ...baseReport,
                comparisons: {
                    ...baseReport.comparisons,
                    distanceKm: Number.isFinite(distance) ? Number(distance.toFixed(2)) : null,
                },
            },
        };
    }

    const assignedDateKey = toZonedDateKey(assignedDate, businessTimeZone);
    const imageDateKey = toZonedDateKey(timestamp, businessTimeZone);

    if (!imageDateKey || imageDateKey !== assignedDateKey) {
        return {
            status: 'PENDING',
            reason: 'Date not matched',
            reasonCode: 'DATE_MISMATCH',
            reasons: ['Date not matched'],
            distance: Number(distance.toFixed(2)),
            timestamp,
            latitude,
            longitude,
            validationSource,
            report: {
                ...baseReport,
                comparisons: {
                    ...baseReport.comparisons,
                    distanceKm: Number(distance.toFixed(2)),
                    assignedDate: assignedDateKey,
                    detectedDate: imageDateKey,
                },
            },
        };
    }

    return {
        status: 'COMPLETED',
        reason: 'Location and date verified',
        reasonCode: 'VERIFIED',
        reasons: [],
        distance: Number(distance.toFixed(2)),
        timestamp,
        latitude,
        longitude,
        validationSource,
        report: {
            ...baseReport,
            comparisons: {
                ...baseReport.comparisons,
                distanceKm: Number(distance.toFixed(2)),
                assignedDate: assignedDateKey,
                detectedDate: imageDateKey,
            },
        },
    };
}

module.exports = {
    verifyGeoTag,
    toZonedDateKey,
};
