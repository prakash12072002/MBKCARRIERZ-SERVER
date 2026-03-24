const NDA_TEMPLATE_KEY = "trainer_signup_nda";

const DEFAULT_NDA_TEMPLATE = {
  key: NDA_TEMPLATE_KEY,
  title: "NDA Agreement & Signature",
  introText: "Please read the agreement carefully before signing.",
  content: `NON-DISCLOSURE AGREEMENT (NDA)

This agreement is entered into between MBK CarrierZ (the "Company") and the Trainer (the "Associate").

1. CONFIDENTIALITY
You shall not disclose any confidential information, including course materials, student records, pricing, or business processes, to any third party without prior written consent from the Company.

2. INTELLECTUAL PROPERTY
All training modules, presentations, and materials provided to you remain the exclusive property of MBK CarrierZ. You shall not reproduce or distribute any materials without written authorization.

3. CODE OF CONDUCT
You agree to maintain professional conduct at all times while representing MBK CarrierZ. This includes punctuality, dress code adherence, and respectful communication.

4. ATTENDANCE & COMMITMENT
You agree to honor all assigned sessions as confirmed. Any cancellations must be communicated at least 24 hours in advance through the official portal.

5. PAYMENT TERMS
Compensation will be processed monthly based on verified attendance records in the system. The Company reserves the right to deduct payment for unverified or absent sessions.

6. TERMINATION
Either party may terminate this agreement with 7 days written notice. The Company may terminate immediately in case of misconduct, breach of confidentiality, or repeated absence.

7. GOVERNING LAW
This agreement shall be governed by the laws of India.

By providing your signature below, you confirm that you have read, understood, and agree to all the terms and conditions stated in this agreement.`,
  checkboxLabel:
    "I have read and agree to the NDA Agreement terms and conditions.",
  acceptanceConditions: [
    "I have read and agree to the NDA Agreement terms and conditions.",
  ],
  version: 1,
};

const toPlainObject = (value) =>
  value?.toObject ? value.toObject() : { ...(value || {}) };

const normalizeAcceptanceConditions = (value) => {
  const source = toPlainObject(value);
  const normalizedConditions = Array.isArray(source.acceptanceConditions)
    ? source.acceptanceConditions
        .map((entry) => String(entry || "").trim())
        .filter(Boolean)
    : [];

  if (normalizedConditions.length > 0) {
    return normalizedConditions;
  }

  const legacyCheckboxLabel = String(
    source.checkboxLabel || DEFAULT_NDA_TEMPLATE.checkboxLabel,
  ).trim();

  return [legacyCheckboxLabel || DEFAULT_NDA_TEMPLATE.checkboxLabel];
};

const normalizeNdaTemplate = (value) => {
  const source = toPlainObject(value);
  const acceptanceConditions = normalizeAcceptanceConditions(source);

  return {
    key: source.key || DEFAULT_NDA_TEMPLATE.key,
    title: String(source.title || DEFAULT_NDA_TEMPLATE.title).trim(),
    introText: String(
      source.introText || DEFAULT_NDA_TEMPLATE.introText,
    ).trim(),
    content: String(source.content || DEFAULT_NDA_TEMPLATE.content).trim(),
    checkboxLabel: acceptanceConditions[0] || DEFAULT_NDA_TEMPLATE.checkboxLabel,
    acceptanceConditions,
    version:
      Number.isFinite(Number(source.version)) && Number(source.version) > 0
        ? Number(source.version)
        : DEFAULT_NDA_TEMPLATE.version,
    updatedAt: source.updatedAt || null,
    updatedBy: source.updatedBy || null,
  };
};

const splitNdaTemplateContent = (content = "") =>
  String(content || "")
    .split(/\n\s*\n/g)
    .map((section) => section.trim())
    .filter(Boolean);

module.exports = {
  NDA_TEMPLATE_KEY,
  DEFAULT_NDA_TEMPLATE,
  normalizeAcceptanceConditions,
  normalizeNdaTemplate,
  splitNdaTemplateContent,
};
