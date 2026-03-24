const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const generatePDF = (content, title = 'Document') => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      resolve(pdfData);
    });

    doc.on('error', (err) => {
      reject(err);
    });

    // Add Content to PDF
    doc.fontSize(25).text(title, { align: 'center' });
    doc.moveDown();
    
    if (typeof content === 'string') {
        doc.fontSize(12).text(content);
    } else if (typeof content === 'object') {
        // Simple object dump for now, can be enhanced
        doc.fontSize(12).text(JSON.stringify(content, null, 2));
    }

    doc.end();
  });
};

const createAndSavePDF = (content, filename, directory = 'exportedData') => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        const baseDir = path.dirname(__dirname); // backend root
        const targetDir = path.join(baseDir, directory);
        
        if (!fs.existsSync(targetDir)){
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        const filePath = path.join(targetDir, filename);
        const writeStream = fs.createWriteStream(filePath);

        doc.pipe(writeStream);

        doc.fontSize(25).text('Report', { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(JSON.stringify(content, null, 2));

        doc.end();

        writeStream.on('finish', () => {
            resolve(filePath);
        });

        writeStream.on('error', (err) => {
            reject(err);
        });
    });
};

module.exports = { generatePDF, createAndSavePDF };
