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

const EXIF_HEADER = Buffer.from('Exif\0\0', 'ascii');
const EXIF_TAGS = {
    DATETIME: 0x0132,
    EXIF_IFD_POINTER: 0x8769,
    GPS_IFD_POINTER: 0x8825,
    DATETIME_ORIGINAL: 0x9003,
    CREATE_DATE: 0x9004,
    GPS_LATITUDE_REF: 0x0001,
    GPS_LATITUDE: 0x0002,
    GPS_LONGITUDE_REF: 0x0003,
    GPS_LONGITUDE: 0x0004,
};
const TIFF_TYPE_SIZES = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    7: 1,
    9: 4,
    10: 8,
};

const readUInt16 = (buffer, offset, littleEndian) => (
    littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
);

const readUInt32 = (buffer, offset, littleEndian) => (
    littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
);

const readInt32 = (buffer, offset, littleEndian) => (
    littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset)
);

const isOffsetWithinBounds = (buffer, offset, byteLength = 1) => (
    Number.isInteger(offset)
    && Number.isInteger(byteLength)
    && offset >= 0
    && byteLength >= 0
    && (offset + byteLength) <= buffer.length
);

const getExifValueAbsoluteOffset = ({
    buffer,
    entryOffset,
    type,
    count,
    tiffStart,
    littleEndian,
}) => {
    const typeSize = TIFF_TYPE_SIZES[type];
    if (!typeSize || !count) return null;

    const valueByteLength = typeSize * count;
    const valueOffsetField = entryOffset + 8;
    const absoluteOffset = valueByteLength <= 4
        ? valueOffsetField
        : (tiffStart + readUInt32(buffer, valueOffsetField, littleEndian));

    return isOffsetWithinBounds(buffer, absoluteOffset, valueByteLength)
        ? { absoluteOffset, valueByteLength }
        : null;
};

const readAsciiValue = (buffer, absoluteOffset, valueByteLength) => {
    const value = buffer
        .subarray(absoluteOffset, absoluteOffset + valueByteLength)
        .toString('ascii')
        .replace(/\0+$/g, '')
        .trim();
    return value || null;
};

const readUnsignedRationalArray = (buffer, absoluteOffset, count, littleEndian) => (
    Array.from({ length: count }, (_, index) => {
        const itemOffset = absoluteOffset + (index * 8);
        const numerator = readUInt32(buffer, itemOffset, littleEndian);
        const denominator = readUInt32(buffer, itemOffset + 4, littleEndian);
        return denominator ? numerator / denominator : null;
    }).filter((value) => Number.isFinite(value))
);

const readSignedRationalArray = (buffer, absoluteOffset, count, littleEndian) => (
    Array.from({ length: count }, (_, index) => {
        const itemOffset = absoluteOffset + (index * 8);
        const numerator = readInt32(buffer, itemOffset, littleEndian);
        const denominator = readInt32(buffer, itemOffset + 4, littleEndian);
        return denominator ? numerator / denominator : null;
    }).filter((value) => Number.isFinite(value))
);

const readUnsignedValueArray = (buffer, absoluteOffset, count, type, littleEndian) => {
    const itemSize = TIFF_TYPE_SIZES[type];
    const reader = type === 3 ? readUInt16 : readUInt32;
    return Array.from({ length: count }, (_, index) => (
        reader(buffer, absoluteOffset + (index * itemSize), littleEndian)
    ));
};

const readExifTagValue = ({
    buffer,
    entryOffset,
    type,
    count,
    tiffStart,
    littleEndian,
}) => {
    const resolvedOffset = getExifValueAbsoluteOffset({
        buffer,
        entryOffset,
        type,
        count,
        tiffStart,
        littleEndian,
    });
    if (!resolvedOffset) return null;

    const { absoluteOffset, valueByteLength } = resolvedOffset;

    switch (type) {
        case 2:
            return readAsciiValue(buffer, absoluteOffset, valueByteLength);
        case 3: {
            const values = readUnsignedValueArray(buffer, absoluteOffset, count, type, littleEndian);
            return count === 1 ? values[0] : values;
        }
        case 4: {
            const values = readUnsignedValueArray(buffer, absoluteOffset, count, type, littleEndian);
            return count === 1 ? values[0] : values;
        }
        case 5: {
            const values = readUnsignedRationalArray(buffer, absoluteOffset, count, littleEndian);
            if (!values.length) return null;
            return count === 1 ? values[0] : values;
        }
        case 9: {
            const values = Array.from({ length: count }, (_, index) => (
                readInt32(buffer, absoluteOffset + (index * 4), littleEndian)
            ));
            return count === 1 ? values[0] : values;
        }
        case 10: {
            const values = readSignedRationalArray(buffer, absoluteOffset, count, littleEndian);
            if (!values.length) return null;
            return count === 1 ? values[0] : values;
        }
        default:
            return null;
    }
};

const parseTiffIfd = (buffer, tiffStart, ifdRelativeOffset, littleEndian) => {
    if (!Number.isFinite(ifdRelativeOffset) || ifdRelativeOffset <= 0) return {};

    const ifdOffset = tiffStart + ifdRelativeOffset;
    if (!isOffsetWithinBounds(buffer, ifdOffset, 2)) return {};

    const entryCount = readUInt16(buffer, ifdOffset, littleEndian);
    const entries = {};

    for (let index = 0; index < entryCount; index += 1) {
        const entryOffset = ifdOffset + 2 + (index * 12);
        if (!isOffsetWithinBounds(buffer, entryOffset, 12)) break;

        const tag = readUInt16(buffer, entryOffset, littleEndian);
        const type = readUInt16(buffer, entryOffset + 2, littleEndian);
        const count = readUInt32(buffer, entryOffset + 4, littleEndian);
        const value = readExifTagValue({
            buffer,
            entryOffset,
            type,
            count,
            tiffStart,
            littleEndian,
        });

        if (value !== null && value !== undefined) {
            entries[tag] = value;
        }
    }

    return entries;
};

const parseJpegExif = (buffer) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
    if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;

    let offset = 2;
    while (offset + 4 <= buffer.length) {
        if (buffer[offset] !== 0xFF) {
            offset += 1;
            continue;
        }

        const marker = buffer[offset + 1];
        if (marker === 0xD9 || marker === 0xDA) break;

        if (marker === 0x00 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
            offset += 2;
            continue;
        }

        if (!isOffsetWithinBounds(buffer, offset + 2, 2)) break;
        const segmentLength = buffer.readUInt16BE(offset + 2);
        if (segmentLength < 2) break;

        const segmentDataStart = offset + 4;
        const segmentDataLength = segmentLength - 2;
        if (!isOffsetWithinBounds(buffer, segmentDataStart, segmentDataLength)) break;

        if (
            marker === 0xE1
            && segmentDataLength >= EXIF_HEADER.length
            && buffer.subarray(segmentDataStart, segmentDataStart + EXIF_HEADER.length).equals(EXIF_HEADER)
        ) {
            const tiffStart = segmentDataStart + EXIF_HEADER.length;
            if (!isOffsetWithinBounds(buffer, tiffStart, 8)) return null;

            const byteOrder = buffer.toString('ascii', tiffStart, tiffStart + 2);
            const littleEndian = byteOrder === 'II';
            if (!littleEndian && byteOrder !== 'MM') return null;

            const magic = readUInt16(buffer, tiffStart + 2, littleEndian);
            if (magic !== 42) return null;

            const ifd0Offset = readUInt32(buffer, tiffStart + 4, littleEndian);
            const ifd0 = parseTiffIfd(buffer, tiffStart, ifd0Offset, littleEndian);
            const subExif = parseTiffIfd(
                buffer,
                tiffStart,
                Number(ifd0[EXIF_TAGS.EXIF_IFD_POINTER]),
                littleEndian
            );
            const gpsInfo = parseTiffIfd(
                buffer,
                tiffStart,
                Number(ifd0[EXIF_TAGS.GPS_IFD_POINTER]),
                littleEndian
            );

            return {
                GPSInfo: {
                    GPSLatitudeRef: gpsInfo[EXIF_TAGS.GPS_LATITUDE_REF] || null,
                    GPSLatitude: Array.isArray(gpsInfo[EXIF_TAGS.GPS_LATITUDE]) ? gpsInfo[EXIF_TAGS.GPS_LATITUDE] : null,
                    GPSLongitudeRef: gpsInfo[EXIF_TAGS.GPS_LONGITUDE_REF] || null,
                    GPSLongitude: Array.isArray(gpsInfo[EXIF_TAGS.GPS_LONGITUDE]) ? gpsInfo[EXIF_TAGS.GPS_LONGITUDE] : null,
                },
                SubExif: {
                    DateTimeOriginal: subExif[EXIF_TAGS.DATETIME_ORIGINAL] || null,
                    CreateDate: subExif[EXIF_TAGS.CREATE_DATE] || null,
                },
                DateTimeOriginal: subExif[EXIF_TAGS.DATETIME_ORIGINAL] || null,
                CreateDate: subExif[EXIF_TAGS.CREATE_DATE] || ifd0[EXIF_TAGS.DATETIME] || null,
            };
        }

        offset += 2 + segmentLength;
    }

    return null;
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
        if (!filePath || !fs.existsSync(filePath)) return null;
    }

    try {
        let exifData = null;

        if (jpegExif) {
            try {
                exifData = jpegExif.parseSync(filePath);
            } catch (error) {
                exifData = null;
            }
        }

        if (!exifData) {
            const fileBuffer = fs.readFileSync(filePath);
            exifData = parseJpegExif(fileBuffer);
        }
        if (!exifData) return null;

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
