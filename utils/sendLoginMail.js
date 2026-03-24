const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER || 'mbktechnology8@gmail.com',
        pass: process.env.SMTP_PASS || 'lydf lkxq baue icfm'
    }
});

const sendLoginMail = async (email, password, name) => {
  const loginLink = `${process.env.FRONTEND_URL || 'https://mbkcarrierz.com'}/login`;
  const year = new Date().getFullYear();

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body style="margin:0; padding:0; background-color:#f0f2f5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f2f5; padding:40px 20px;">
      <tr>
        <td align="center">
          <table width="520" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <tr>
              <td style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); padding:32px 40px; text-align:center;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <div style="width:56px; height:56px; background:rgba(255,255,255,0.2); border-radius:50%; line-height:56px; font-size:28px; margin:0 auto 12px;">
                        ✓
                      </div>
                      <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:700; letter-spacing:-0.3px;">
                        Password Changed Successfully
                      </h1>
                      <p style="margin:8px 0 0; color:rgba(255,255,255,0.85); font-size:13px; font-weight:400;">
                        Your account credentials have been updated
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:32px 40px;">
                <p style="margin:0 0 20px; color:#1f2937; font-size:15px; line-height:1.6;">
                  Hello <strong>${name || 'User'}</strong>,
                </p>
                <p style="margin:0 0 24px; color:#4b5563; font-size:14px; line-height:1.6;">
                  Your password has been successfully changed. Below are your updated login credentials. Please keep them safe.
                </p>

                <!-- Credentials Card -->
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden;">
                  <tr>
                    <td style="padding:20px 24px; border-bottom:1px solid #e2e8f0;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">
                            Email Address
                          </td>
                        </tr>
                        <tr>
                          <td style="color:#0f172a; font-size:15px; font-weight:600; padding-top:4px;">
                            ${email}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:20px 24px;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="color:#64748b; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; font-weight:600;">
                            New Password
                          </td>
                        </tr>
                        <tr>
                          <td style="color:#0f172a; font-size:15px; font-weight:600; padding-top:4px; font-family: 'Courier New', monospace; letter-spacing:1px;">
                            ${password}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- CTA Button -->
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                  <tr>
                    <td align="center">
                      <a href="${loginLink}" style="display:inline-block; background:linear-gradient(135deg, #4f46e5 0%, #6366f1 100%); color:#ffffff; padding:14px 36px; border-radius:10px; text-decoration:none; font-weight:600; font-size:14px; letter-spacing:0.2px; box-shadow: 0 4px 12px rgba(79,70,229,0.3);">
                        Login to MBK CarrierZ
                      </a>
                    </td>
                  </tr>
                </table>

                <!-- Security Note -->
                <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px; background:#fffbeb; border:1px solid #fde68a; border-radius:10px;">
                  <tr>
                    <td style="padding:14px 18px;">
                      <p style="margin:0; color:#92400e; font-size:12px; line-height:1.5;">
                        <strong>🔒 Security Tip:</strong> For your safety, we recommend changing your password after your first login. Never share your credentials with anyone.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background:#f8fafc; padding:20px 40px; border-top:1px solid #e2e8f0; text-align:center;">
                <p style="margin:0 0 4px; color:#94a3b8; font-size:11px;">
                  This is an automated message from <strong>MBK CarrierZ</strong>
                </p>
                <p style="margin:0; color:#cbd5e1; font-size:11px;">
                  © ${year} MBK Technologies. All rights reserved.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  try {
    const info = await transporter.sendMail({
        from: process.env.EMAIL_FROM || '"MBK CarrierZ" <official@mbktechnologies.info>',
        to: email,
        subject: "✅ Password Changed Successfully — MBK CarrierZ",
        html
    });
    console.log('Login details email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Error sending login details email:', error);
    throw error;
  }
};

module.exports = { sendLoginMail };
