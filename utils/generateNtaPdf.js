const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const crypto = require("crypto");
const {
  normalizeNdaTemplate,
  splitNdaTemplateContent,
} = require("./ndaTemplate");

/**
 * Generates the official NDA Agreement PDF using the trainer's profile photo.
 * Includes MBK approval stamp logic AND Pro-Level security features.
 * @param {Object} trainer - The trainer document.
 * @returns {Promise<String>} - The relative path to the generated PDF.
 */
async function generateNdaPdf(trainer, template = null) {
  const resolvedTemplate = normalizeNdaTemplate(template);
  const agreementSections = splitNdaTemplateContent(resolvedTemplate.content);
  const filePath = `uploads/NDA/${trainer._id}.pdf`;
  const fullPath = path.join(__dirname, "..", filePath);
  const uploadsDir = path.dirname(fullPath);
  const resolveUploadPath = (relativeOrAbsolutePath) => {
    if (!relativeOrAbsolutePath || typeof relativeOrAbsolutePath !== "string") {
      return null;
    }
    const normalized = relativeOrAbsolutePath.replace(/\\/g, "/");
    const trimmed = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    return path.join(__dirname, "..", trimmed);
  };
  const readBinarySource = async (source) => {
    if (!source || typeof source !== "string") {
      return null;
    }

    if (source.startsWith("data:")) {
      const encoded = source.split(",")[1];
      return encoded ? Buffer.from(encoded, "base64") : null;
    }

    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Remote asset request failed with status ${response.status}`);
      }

      return Buffer.from(await response.arrayBuffer());
    }

    const fullSourcePath = resolveUploadPath(source);
    if (fullSourcePath && fs.existsSync(fullSourcePath)) {
      return fs.readFileSync(fullSourcePath);
    }

    return null;
  };

  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(fullPath);
  doc.pipe(stream);

  /* ===== WATERMARK ===== */
  doc.save();
  doc
    .fillColor("grey")
    .opacity(0.1)
    .fontSize(50)
    .rotate(-45, { origin: [300, 400] })
    .text("OFFICIAL - MBK TECHNOLOGY", 50, 400, {
      width: 500,
      align: "center",
    });
  doc.restore();

  /* ===== MBK LOGO ===== */
  const logoPath = path.join(__dirname, "..", "assets", "mbk-logo.png");
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 40, 30, { width: 80 });
  }

  /* ===== HEADER ===== */
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .fillColor("black")
    .text("MBK TECHNOLOGY", 0, 40, { align: "center" })
    .fontSize(14)
    .text(resolvedTemplate.title || "Trainer NDA Agreement", { align: "center" });

  doc.moveDown(2);

  /* ===== PROFILE PHOTO ===== */
  const photo = trainer.documents?.selfiePhoto || trainer.documents?.passportPhoto;

  if (photo) {
    try {
      const photoBuffer = await readBinarySource(photo);

      if (photoBuffer) {
        doc.image(photoBuffer, 420, 120, {
          width: 100,
          height: 120,
        });
      }
    } catch (err) {
      console.error("Error adding profile photo to PDF:", err);
    }
  }

  /* ===== DETAILS ===== */
  doc.fontSize(12).font("Helvetica");

  doc.text(`Trainer ID: ${trainer.trainerId || "-"}`, 40, 140);
  doc.text(`Name: ${trainer.firstName || ""} ${trainer.lastName || ""}`);
  doc.text(`Qualification: ${trainer.qualification || "-"}`);
  doc.text(
    `City: ${trainer.city || (trainer.cityId && trainer.cityId.name) || ""}`,
  );

  doc.moveDown();

  /* ===== AGREEMENT TEXT ===== */
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").text(
    resolvedTemplate.title || "Agreement Terms & Conditions",
    {
      align: "left",
    },
  );
  doc.moveDown(0.4);
  doc.font("Helvetica").text(resolvedTemplate.introText || "", {
    align: "left",
  });
  doc.moveDown(0.4);
  doc.font("Helvetica");

  agreementSections.forEach((section) => {
    if (doc.y > 700) doc.addPage();
    doc.text(section, {
      align: "justify",
      lineGap: 2,
    });
    doc.moveDown(0.7);
  });

  doc.moveDown(3);

  /* ===== SIGNATURE ===== */
  if (trainer.signature) {
    try {
      const sigBuffer = await readBinarySource(trainer.signature);

      doc.text("Trainer Signature:");
      if (sigBuffer) {
        doc.image(sigBuffer, { width: 120 });
      } else {
        doc.text("[Digital Signature Recorded]");
      }
    } catch (err) {
      console.error("Error adding signature to PDF:", err);
      doc.text("[Digital Signature Recorded]");
    }
  }

  doc.moveDown();

  /* ===== QR CODE VERIFICATION ===== */
  try {
    const qrData = JSON.stringify({
      id: trainer.trainerId,
      name: `${trainer.firstName} ${trainer.lastName}`,
      status: trainer.status,
      hash: crypto
        .createHash("sha256")
        .update(trainer._id.toString())
        .digest("hex")
        .substring(0, 12)
        .toUpperCase(),
    });
    const qrDataURL = await QRCode.toDataURL(qrData);
    const qrBuffer = Buffer.from(qrDataURL.split(",")[1], "base64");
    doc.image(qrBuffer, 40, 680, { width: 80 });
    doc.fontSize(8).text("Scan to Verify Authenticity", 40, 765);
  } catch (err) {
    console.error("Error adding QR code to PDF:", err);
  }

  /* ===== APPROVAL STAMP & HASH ===== */
  if (trainer.status === "APPROVED") {
    // Approval Hash
    const approvalHash = crypto
      .createHash("sha256")
      .update(`${trainer._id}-${trainer.approvedAt}`)
      .digest("hex")
      .substring(0, 16)
      .toUpperCase();

    doc
      .fontSize(9)
      .font("Courier-Bold")
      .text(`APPROVAL ID: ${approvalHash}`, 350, 680, { align: "right" });

    const stampPath = path.join(__dirname, "..", "assets", "mbk-stamp.png");

    if (fs.existsSync(stampPath)) {
      doc.image(stampPath, 350, 700, {
        width: 120,
        opacity: 0.9,
      });
    } else {
      // Fallback: Professional Vector Stamp if image not found
      const stampX = 400;
      const stampY = 700;
      doc.save();
      doc
        .rect(stampX, stampY, 120, 40)
        .lineWidth(2)
        .strokeColor("#dc2626")
        .stroke(); // Red Border
      doc
        .fontSize(10)
        .fillColor("#dc2626")
        .font("Helvetica-Bold")
        .text("MBK TECHNOLOGY", stampX, stampY + 8, {
          width: 120,
          align: "center",
        })
        .fontSize(12)
        .text("VERIFIED & APPROVED", { width: 120, align: "center" });
      doc.restore();
      doc.fillColor("black");
    }

    doc
      .fontSize(10)
      .font("Helvetica")
      .text("Approved by MBK Technology", 350, 750, { align: "right" });
  }

  doc.moveDown();
  doc
    .fontSize(10)
    .text(`Date: ${new Date().toLocaleDateString()}`, { align: "right" });

  doc.end();

  // Return a promise that resolves when the stream is finished
  return new Promise((resolve, reject) => {
    stream.on("finish", () => resolve(filePath));
    stream.on("error", (err) => reject(err));
  });
}

module.exports = {
  generateNdaPdf,
  generateNtaPdf: generateNdaPdf,
  generateNDAPdf: generateNdaPdf,
};
