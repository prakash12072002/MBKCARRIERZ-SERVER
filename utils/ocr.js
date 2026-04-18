const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');

let sharp = null;
try {
    sharp = require('sharp');
} catch (error) {
    sharp = null;
}

const OCR_CACHE_PATH = path.join(process.cwd(), '.tesseract-cache');
const OCR_TEXT_LIMIT = 500;
const LATITUDE_PATTERNS = [
    /\b(?:lat|latitude)[^\d-]*(-?\d{1,2}(?:\.\d+)?)/i,
];
const LONGITUDE_PATTERNS = [
    /\b(?:lon|long|longitude|lng)[^\d-]*(-?\d{1,3}(?:\.\d+)?)/i,
];
const DATE_PATTERNS = [
    /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?\s*,?\s*(\d{2})[\/\-](\d{2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)(?:\s*gmt\s*([+\-]\d{2}:\d{2}))?/i,
];

let workerPromise = null;

const toNullableNumber = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
};

const normalizeOcrText = (text) => {
    if (typeof text !== 'string') return null;
    const normalized = text
        .replace(/[|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized ? normalized.slice(0, OCR_TEXT_LIMIT) : null;
};

const mergeNormalizedText = (primaryText, nextText) => {
    const parts = [primaryText, nextText]
        .filter((value) => typeof value === 'string' && value.trim())
        .map((value) => value.trim());

    if (!parts.length) return null;

    const merged = parts.filter((value, index) => parts.indexOf(value) === index).join(' | ');
    return merged.slice(0, OCR_TEXT_LIMIT);
};

const extractCoordinateFromText = (text, patterns) => {
    if (!text) return null;

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;

        const value = toNullableNumber(match[1]);
        if (value === null) continue;
        return value;
    }

    return null;
};

const extractDateFromText = (text) => {
    if (!text) return null;

    for (const pattern of DATE_PATTERNS) {
        const match = text.match(pattern);
        if (!match) continue;

        const [, day, month, year, hour, minute, meridiem, offset = '+05:30'] = match;
        let normalizedHour = Number(hour);
        if (!Number.isFinite(normalizedHour)) continue;

        const normalizedMeridiem = String(meridiem || '').trim().toLowerCase();
        if (normalizedMeridiem === 'pm' && normalizedHour !== 12) normalizedHour += 12;
        if (normalizedMeridiem === 'am' && normalizedHour === 12) normalizedHour = 0;

        const isoString = `${year}-${month}-${day}T${String(normalizedHour).padStart(2, '0')}:${minute}:00${offset}`;
        const parsed = new Date(isoString);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }

    return null;
};

const getWorker = async () => {
    if (workerPromise) return workerPromise;

    workerPromise = (async () => {
        fs.mkdirSync(OCR_CACHE_PATH, { recursive: true });
        const worker = await createWorker('eng', 1, {
            cachePath: OCR_CACHE_PATH,
            logger: () => {},
        });
        await worker.setParameters({
            preserve_interword_spaces: '1',
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:./,-+() GMTLatLongLongitudeLatitude',
        });
        return worker;
    })().catch((error) => {
        workerPromise = null;
        throw error;
    });

    return workerPromise;
};

const preprocessImageForOcr = async (filePath) => {
    if (!sharp) return filePath;

    try {
        return await sharp(filePath)
            .rotate()
            .grayscale()
            .normalize()
            .sharpen()
            .png()
            .toBuffer();
    } catch (error) {
        return filePath;
    }
};

const buildBottomStampTarget = async (filePath) => {
    if (!sharp) return null;

    try {
        const metadata = await sharp(filePath).metadata();
        const width = Number(metadata?.width);
        const height = Number(metadata?.height);

        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return null;
        }

        const cropTop = Math.max(0, Math.floor(height * 0.5));
        const cropHeight = Math.max(1, height - cropTop);
        return await sharp(filePath)
            .extract({
                left: 0,
                top: cropTop,
                width,
                height: cropHeight,
            })
            .resize({ width: Math.max(Math.min(width, 1400), 1200), withoutEnlargement: false })
            .grayscale()
            .normalize()
            .sharpen()
            .png()
            .toBuffer();
    } catch (error) {
        return null;
    }
};

const toRecognitionSnapshot = (text) => {
    const normalizedText = normalizeOcrText(text);
    const capturedAt = extractDateFromText(normalizedText);

    return {
        text: normalizedText,
        latitude: extractCoordinateFromText(normalizedText, LATITUDE_PATTERNS),
        longitude: extractCoordinateFromText(normalizedText, LONGITUDE_PATTERNS),
        capturedAt,
        timestamp: capturedAt ? Math.floor(capturedAt.getTime() / 1000) : null,
    };
};

const mergeRecognitionSnapshot = (baseSnapshot, nextSnapshot) => ({
    text: mergeNormalizedText(baseSnapshot?.text, nextSnapshot?.text),
    latitude: toNullableNumber(baseSnapshot?.latitude ?? nextSnapshot?.latitude),
    longitude: toNullableNumber(baseSnapshot?.longitude ?? nextSnapshot?.longitude),
    capturedAt: baseSnapshot?.capturedAt || nextSnapshot?.capturedAt || null,
    timestamp: toNullableNumber(baseSnapshot?.timestamp ?? nextSnapshot?.timestamp),
});

const hasCompleteOcrEvidence = (snapshot) => (
    Number.isFinite(snapshot?.latitude)
    && Number.isFinite(snapshot?.longitude)
    && Number.isFinite(snapshot?.timestamp)
);

const extractOcrStampData = async (filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return null;

    try {
        const worker = await getWorker();
        let combinedSnapshot = {
            text: null,
            latitude: null,
            longitude: null,
            capturedAt: null,
            timestamp: null,
        };

        const bottomStampTarget = await buildBottomStampTarget(filePath);
        if (bottomStampTarget) {
            const bottomStampResult = await worker.recognize(bottomStampTarget);
            combinedSnapshot = mergeRecognitionSnapshot(
                combinedSnapshot,
                toRecognitionSnapshot(bottomStampResult?.data?.text || '')
            );
        }

        if (!hasCompleteOcrEvidence(combinedSnapshot)) {
            const fullFrameTarget = await preprocessImageForOcr(filePath);
            const fullFrameResult = await worker.recognize(fullFrameTarget);
            combinedSnapshot = mergeRecognitionSnapshot(
                combinedSnapshot,
                toRecognitionSnapshot(fullFrameResult?.data?.text || '')
            );
        }

        return combinedSnapshot.text
            || Number.isFinite(combinedSnapshot.latitude)
            || Number.isFinite(combinedSnapshot.longitude)
            || Number.isFinite(combinedSnapshot.timestamp)
            ? combinedSnapshot
            : null;
    } catch (error) {
        console.error('[OCR] Failed to extract stamped data:', error.message);
        return null;
    }
};

module.exports = {
    extractOcrStampData,
};
