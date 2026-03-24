function welcomeEmailTemplate({
  adminName,
  companyName,
  phone,
  email,
  address,
  logoUrl,
  verifyLink,
}) {
  return `
  <div style="font-family:Arial,sans-serif;background:#f4f6f9;padding:30px;">
    <div style="max-width:650px;margin:auto;background:#ffffff;border-radius:12px;padding:30px;box-shadow:0 10px 25px rgba(0,0,0,0.05);">
      
      <div style="text-align:center;margin-bottom:20px;">
        <img src="${logoUrl}" alt="Company Logo" style="max-height:80px;" />
      </div>

      <h2 style="color:#1e3a8a;text-align:center;">
        Welcome to MBK 🎉
      </h2>

      <p>Hello <strong>${adminName}</strong>,</p>

      <p>
        Thank you for joining <strong>MBK Platform</strong>.
        Your company <strong>${companyName}</strong> has been successfully registered.
      </p>

      <div style="background:#f1f5f9;padding:15px;border-radius:8px;margin:20px 0;">
        <p><strong>Admin Name:</strong> ${adminName}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone}</p>
        <p><strong>Address:</strong> ${address}</p>
      </div>

      <p>Please verify your email address to activate your Company Admin account.</p>

      <div style="text-align:center;margin:30px 0;">
        <a href="${verifyLink}" 
           style="background:#2563eb;color:white;padding:12px 25px;
           text-decoration:none;border-radius:6px;font-weight:bold;">
           Verify Email
        </a>
      </div>

      <p>
        We look forward to working with you and growing together.
      </p>

      <p>Thanks & Regards,<br/>
      <strong>MBK Team</strong></p>

      <hr style="margin-top:30px;" />

      <p style="font-size:12px;color:#888;text-align:center;">
        © ${new Date().getFullYear()} MBK. All rights reserved.
      </p>

    </div>
  </div>
  `;
}

module.exports = welcomeEmailTemplate;
