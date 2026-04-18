const toNullableNumber = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
};

const cleanString = (value) => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized || null;
};

const normalizeCollegeLocation = (source) => {
    if (!source || typeof source !== 'object') return null;

    const nestedLocation = source.location && typeof source.location === 'object'
        ? source.location
        : {};

    const lat = toNullableNumber(
        source.lat ?? source.latitude ?? nestedLocation.lat ?? nestedLocation.latitude
    );
    const lng = toNullableNumber(
        source.lng ?? source.longitude ?? nestedLocation.lng ?? nestedLocation.longitude
    );
    const address = cleanString(source.address ?? nestedLocation.address);
    const mapUrl = cleanString(source.mapUrl ?? nestedLocation.mapUrl);

    if (lat === null && lng === null && !address && !mapUrl) {
        return null;
    }

    return {
        address,
        lat,
        lng,
        mapUrl,
    };
};

const hasValidCollegeCoordinates = (location) => (
    Number.isFinite(location?.lat) && Number.isFinite(location?.lng)
);

const mergeCollegeLocations = (...sources) => {
    const normalizedSources = sources
        .map((item) => normalizeCollegeLocation(item))
        .filter(Boolean);

    if (!normalizedSources.length) return null;

    const sourceWithCoordinates = normalizedSources.find((item) => hasValidCollegeCoordinates(item));
    const fallbackSource = sourceWithCoordinates || normalizedSources[0];
    const address = normalizedSources.find((item) => item.address)?.address || null;
    const mapUrl = normalizedSources.find((item) => item.mapUrl)?.mapUrl || null;

    return {
        address: fallbackSource.address ?? address,
        lat: hasValidCollegeCoordinates(fallbackSource) ? fallbackSource.lat : null,
        lng: hasValidCollegeCoordinates(fallbackSource) ? fallbackSource.lng : null,
        mapUrl: fallbackSource.mapUrl ?? mapUrl,
    };
};

const numbersEqual = (left, right) => {
    if (left === null && right === null) return true;
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) < 0.000001;
};

const collegeLocationsEqual = (left, right) => {
    const normalizedLeft = normalizeCollegeLocation(left);
    const normalizedRight = normalizeCollegeLocation(right);

    if (!normalizedLeft && !normalizedRight) return true;
    if (!normalizedLeft || !normalizedRight) return false;

    return (
        numbersEqual(normalizedLeft.lat, normalizedRight.lat)
        && numbersEqual(normalizedLeft.lng, normalizedRight.lng)
        && (normalizedLeft.address || null) === (normalizedRight.address || null)
        && (normalizedLeft.mapUrl || null) === (normalizedRight.mapUrl || null)
    );
};

module.exports = {
    normalizeCollegeLocation,
    hasValidCollegeCoordinates,
    mergeCollegeLocations,
    collegeLocationsEqual,
};
