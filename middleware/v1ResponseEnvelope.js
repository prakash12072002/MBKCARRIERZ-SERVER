const toPlainObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

const omitKeys = (source = {}, keys = []) => {
  const excluded = new Set(keys);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !excluded.has(key)),
  );
};

const buildSuccessEnvelope = (payload) => {
  if (!toPlainObject(payload)) {
    return {
      success: true,
      data: payload ?? null,
      error: null,
    };
  }

  if (Object.prototype.hasOwnProperty.call(payload, "success")) {
    const normalized = omitKeys(payload, ["success", "error", "message"]);
    const keys = Object.keys(normalized);
    const hasOnlyDataKey = keys.length === 1 && keys[0] === "data";

    return {
      success: true,
      data: hasOnlyDataKey ? normalized.data ?? null : normalized,
      error: null,
    };
  }

  return {
    success: true,
    data: payload,
    error: null,
  };
};

const buildErrorEnvelope = (payload, statusCode = 500) => {
  if (!toPlainObject(payload)) {
    return {
      success: false,
      data: null,
      error: {
        message: typeof payload === "string" && payload.trim()
          ? payload
          : "Request failed",
        statusCode,
        details: null,
      },
    };
  }

  const message = String(
    payload.message
      || payload.error?.message
      || payload.error
      || "Request failed",
  ).trim();

  const extraDetails = omitKeys(payload, ["success", "message", "error", "data"]);
  const hasExtraDetails = Object.keys(extraDetails).length > 0;

  return {
    success: false,
    data: Object.prototype.hasOwnProperty.call(payload, "data")
      ? payload.data
      : null,
    error: {
      message,
      statusCode,
      details: payload.error ?? (hasExtraDetails ? extraDetails : null),
    },
  };
};

const toV1Envelope = (payload, statusCode = 200) => {
  if (
    toPlainObject(payload)
    && Object.prototype.hasOwnProperty.call(payload, "success")
    && Object.prototype.hasOwnProperty.call(payload, "data")
    && Object.prototype.hasOwnProperty.call(payload, "error")
  ) {
    return payload;
  }

  const hasFailureFlag = toPlainObject(payload) && payload.success === false;
  const isHttpError = statusCode >= 400;
  if (hasFailureFlag || isHttpError) {
    return buildErrorEnvelope(payload, statusCode);
  }

  return buildSuccessEnvelope(payload);
};

const v1ResponseEnvelope = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (payload) => {
    const envelope = toV1Envelope(payload, res.statusCode);
    return originalJson(envelope);
  };

  next();
};

module.exports = {
  v1ResponseEnvelope,
  toV1Envelope,
};

