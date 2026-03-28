const haversine = require('haversine-distance');

const calculateDistance = (lat1, lng1, lat2, lng2) => {
    const distanceInMeters = haversine(
        { latitude: Number(lat1), longitude: Number(lng1) },
        { latitude: Number(lat2), longitude: Number(lng2) },
    );

    if (!Number.isFinite(distanceInMeters)) {
        return null;
    }

    return distanceInMeters / 1000;
};

module.exports = {
    calculateDistance,
};
