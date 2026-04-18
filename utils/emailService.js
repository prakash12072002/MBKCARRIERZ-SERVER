const nodemailer = require("nodemailer");
const welcomeEmailTemplate = require("./welcomeEmailTemplate");

const smtpUser = (process.env.SMTP_USER || "mbktechnology8@gmail.com").trim();
const smtpPass = (process.env.SMTP_PASS || "lydf lkxq baue icfm").replace(/\s+/g, "");

// Email Configuration
const smtpConfig = {
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true", // true for 465, false for other ports
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
};

console.log("Initializing Email Service with:", {
  host: smtpConfig.host,
  user: smtpConfig.auth.user,
  passLength: smtpConfig.auth.pass ? smtpConfig.auth.pass.length : 0,
});

let transporter = nodemailer.createTransport(smtpConfig);

// Generic sendMail helper — supports optional html body
const sendMail = async (to, subject, text, html = null, attachments = null) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK CarrierZ" <mbktechnology8@gmail.com>',
    to,
    subject,
    text,
    ...(html && { html }),
    ...(attachments && attachments.length ? { attachments } : {}),
  };
  return await transporter.sendMail(mailOptions);
};

// ──────────────────────────────────────────────────────────────────────────────
// OTP Email Template — Premium HTML design
// ──────────────────────────────────────────────────────────────────────────────
const otpEmailTemplate = (otp) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e3a8a,#2563eb);padding:36px 30px;text-align:center;">
      <h1 style="margin:0;color:#ffffff;font-size:26px;letter-spacing:1px;">🔐 Email Verification</h1>
      <p style="margin:8px 0 0;color:#bfdbfe;font-size:14px;">Company Admin Account Setup</p>
    </div>

    <!-- Body -->
    <div style="padding:36px 30px;">
      <p style="color:#374151;font-size:15px;margin-top:0;">Hello,</p>
      <p style="color:#374151;font-size:15px;">
        You are setting up a <strong>Company Admin</strong> account on <strong>MBK CarrierZ</strong>.
        Please verify your email using the OTP below:
      </p>

      <!-- OTP Box -->
      <div style="
        background:#eff6ff;
        border:2px dashed #2563eb;
        border-radius:12px;
        text-align:center;
        padding:24px 16px;
        margin:28px 0;">
        <p style="margin:0 0 8px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:2px;">Your One-Time Password</p>
        <div style="
          font-size:38px;
          font-weight:800;
          letter-spacing:12px;
          color:#1e3a8a;
          font-family:'Courier New',monospace;">
          ${otp}
        </div>
      </div>

      <p style="color:#374151;font-size:14px;">
        ⏱ This OTP is valid for <strong>5 minutes</strong>.
      </p>
      <p style="color:#6b7280;font-size:13px;">
        If you did not request this, please ignore this email. Your account will not be created without verification.
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 30px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#9ca3af;">
        © ${new Date().getFullYear()} MBK CarrierZ · All rights reserved<br/>
        <span style="font-size:11px;">This is an automated message. Please do not reply.</span>
      </p>
    </div>

  </div>
</body>
</html>`;

// Dedicated OTP sender — uses the premium HTML template
const sendOtpEmail = async (to, otp) => {
  return await sendMail(
    to,
    "🔐 Your Company Admin Verification OTP — MBK CarrierZ",
    `Your OTP is: ${otp}\n\nThis code is valid for 5 minutes. Do not share it with anyone.`,
    otpEmailTemplate(otp)
  );
};



// Send verification email
const sendVerificationEmail = async (
  userEmail,
  userName,
  verificationToken,
) => {
  const verificationUrl = `${process.env.FRONTEND_URL || "http://localhost:5174"}/verify-email/${verificationToken}`;

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: userEmail,
    subject: "Verify Your Email - MBK BY TSMG",
    html: `
            <h2>Welcome to MBK BY TSMG, ${userName}!</h2>
            <p>Thank you for creating an account. Please verify your email address by clicking the link below:</p>
            <p>
                <a href="${verificationUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                    Verify Email Address
                </a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p><a href="${verificationUrl}">${verificationUrl}</a></p>
            <p>This link will expire in 24 hours.</p>
            <p>If you didn't create an account, please ignore this email.</p>
            <hr>
            <p style="color: #666; font-size: 12px;">This is an automated message from MBK BY TSMG, please do not reply.</p>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Verification email sent:", info.messageId);

    // For development, log preview URL
    if (process.env.NODE_ENV !== "production") {
      console.log("Preview URL:", nodemailer.getTestMessageUrl(info));
    }

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending verification email:", error);
    throw error;
  }
};

// Send password reset email (OTP)
const sendPasswordResetEmail = async (userEmail, userName, otp) => {
  const year = new Date().getFullYear();

  const mailOptions = {
    from:
      process.env.EMAIL_FROM ||
      '"MBK CarrierZ" <official@mbktechnologies.info>',
    to: userEmail,
    subject: "🔐 Password Reset OTP — MBK CarrierZ",
    html: `
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
                    <td style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding:32px 40px; text-align:center;">
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td align="center">
                            <div style="width:56px; height:56px; background:rgba(255,255,255,0.2); border-radius:50%; line-height:56px; font-size:28px; margin:0 auto 12px;">
                              🔐
                            </div>
                            <h1 style="margin:0; color:#ffffff; font-size:22px; font-weight:700; letter-spacing:-0.3px;">
                              Password Reset Request
                            </h1>
                            <p style="margin:8px 0 0; color:rgba(255,255,255,0.85); font-size:13px; font-weight:400;">
                              Use the OTP below to reset your password
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
                        Hello <strong>${userName || "User"}</strong>,
                      </p>
                      <p style="margin:0 0 24px; color:#4b5563; font-size:14px; line-height:1.6;">
                        We received a request to reset your password. Enter the following verification code to proceed:
                      </p>

                      <!-- OTP Code -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%); border:2px solid #c7d2fe; border-radius:14px;">
                        <tr>
                          <td align="center" style="padding:28px 20px;">
                            <p style="margin:0 0 8px; color:#6366f1; font-size:11px; text-transform:uppercase; letter-spacing:1.5px; font-weight:700;">
                              Your Verification Code
                            </p>
                            <p style="margin:0; color:#312e81; font-size:40px; font-weight:800; letter-spacing:12px; font-family: 'Courier New', monospace;">
                              ${otp}
                            </p>
                          </td>
                        </tr>
                      </table>

                      <!-- Timer -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
                        <tr>
                          <td align="center">
                            <p style="margin:0; color:#dc2626; font-size:13px; font-weight:600;">
                              ⏱ This code expires in 10 minutes
                            </p>
                          </td>
                        </tr>
                      </table>

                      <!-- Security Note -->
                      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px; background:#fefce8; border:1px solid #fde68a; border-radius:10px;">
                        <tr>
                          <td style="padding:14px 18px;">
                            <p style="margin:0; color:#92400e; font-size:12px; line-height:1.5;">
                              <strong>⚠️ Important:</strong> If you did not request this password reset, please ignore this email. Your account remains secure and no changes will be made.
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
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Password reset email sent:", info.messageId);
    console.log("----------------------------------------");
    console.log(`🔐 PASSWORD RESET OTP for ${userEmail}: ${otp}`);
    console.log("----------------------------------------");

    if (process.env.NODE_ENV !== "production") {
      console.log("Preview URL:", nodemailer.getTestMessageUrl(info));
    }

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending password reset email:", error);
    throw error;
  }
};

// Old Complaint Notification Email removed in favor of new Smart Design below

// Send Complaint Status Update Email to Trainer
const sendComplaintStatusUpdateEmail = async (
  trainerEmail,
  trainerName,
  complaintData,
) => {
  const { subject, status, adminRemarks, ticketId } = complaintData;

  let statusColor = "#3B82F6"; // Blue
  if (status === "Resolved") statusColor = "#059669"; // Green
  if (status === "Closed") statusColor = "#6B7280"; // Gray
  if (status === "In Progress") statusColor = "#D97706"; // Orange

  const senderIdentity = '"MBK BY TSMG" <mbktechnology8@gmail.com>'; // Hardcoded for verification
  console.log("DEBUG: Attempting to send email from:", senderIdentity);

  const mailOptions = {
    from: senderIdentity,
    to: trainerEmail,
    subject: `[Update] Complaint Status Changed: ${status} - ${ticketId || "Ticket"}`,
    html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #1F2937;">Complaint Status Update</h2>
                <p>Hello ${trainerName},</p>
                <p>The status of your complaint has been updated.</p>
                
                <div style="background-color: #F9FAFB; border-left: 4px solid ${statusColor}; padding: 15px; margin: 20px 0;">
                    <p style="margin: 5px 0;"><strong>Subject:</strong> ${subject}</p>
                    <p style="margin: 5px 0;"><strong>New Status:</strong> <span style="color: ${statusColor}; font-weight: bold;">${status}</span></p>
                    ${adminRemarks ? `<p style="margin: 5px 0;"><strong>Admin Remarks:</strong> ${adminRemarks}</p>` : ""}
                </div>

                <p>You can view more details by logging into your dashboard.</p>
                
                <div style="margin-top: 30px; border-top: 1px solid #E5E7EB; padding-top: 15px;">
                    <p style="margin: 0; font-size: 12px; color: #6B7280;">This is an automated notification from MBK BY TSMG.</p>
                </div>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Complaint update email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending complaint update email:", error);
    return { success: false, error: error.message };
  }
};

// Send New Trainer Registration Notification to Admins
const sendTrainerRegistrationNotificationEmail = async (
  adminEmails,
  trainerData,
) => {
  if (!adminEmails || adminEmails.length === 0) return;

  const { name, email, phone, city } = trainerData;

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: adminEmails, // Array or comma-separated string
    subject: `[New Signup] New Trainer Registration: ${name}`,
    html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #1F2937;">New Trainer Registration</h2>
                <div style="background-color: #F3F4F6; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 5px 0;"><strong>Name:</strong> ${name}</p>
                    <p style="margin: 5px 0;"><strong>Email:</strong> ${email}</p>
                    ${phone ? `<p style="margin: 5px 0;"><strong>Phone:</strong> ${phone}</p>` : ""}
                    ${city ? `<p style="margin: 5px 0;"><strong>City:</strong> ${city}</p>` : ""}
                    <p style="margin: 5px 0;"><strong>Status:</strong> <span style="color: #D97706; font-weight: bold;">Pending Approval</span></p>
                </div>
                
                <p>Please log in to the Admin Portal to review and approve this account.</p>
                
                <div style="margin-top: 30px; border-top: 1px solid #E5E7EB; padding-top: 15px;">
                    <p style="margin: 0; font-size: 12px; color: #6B7280;">This is an automated notification from MBK BY TSMG.</p>
                </div>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(
      "Trainer registration notification email sent:",
      info.messageId,
    );
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(
      "Error sending trainer registration notification email:",
      error,
    );
    return { success: false, error: error.message };
  }
};

// Send Bulk Schedule Notification to Trainer
const sendBulkScheduleEmail = async (trainerEmail, trainerName, schedules) => {
  // Note: The bulk email design was not explicitly requested in "Smart Design",
  // but we will apply the same "Assign Schedule" style for consistency, adapting for multiple items.
  // However, the request specifically detailed "Assign Schedule" as a single item concept.
  // We will keep the bulk email cleanly formatted using the previously established "Premium" style
  // but ensure it aligns with the color scheme (Green).

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: `Training Assigned – ${schedules.length} Sessions`,
    html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden;">
                <div style="text-align: center; padding: 30px 20px;">
                    <h2 style="color: #16a34a; margin: 0; font-size: 24px; font-weight: 800;">✅ Training Assigned</h2>
                    <p style="color: #6b7280; font-size: 15px; margin-top: 8px;">You have been assigned ${schedules.length} new sessions.</p>
                </div>

                <div style="padding: 0 20px 30px;">
                    ${schedules
                      .map(
                        (s) => `
                        <div style="background: #f9fafb; padding: 16px; border-radius: 10px; margin-bottom: 16px; border: 1px solid #f3f4f6;">
                            <p style="margin: 4px 0; font-size: 15px; color: #374151;"><b>Course:</b> ${s.course}</p>
                            <p style="margin: 4px 0; font-size: 14px; color: #374151;"><b>Day:</b> ${s.day}</p>
                            <p style="margin: 4px 0; font-size: 14px; color: #374151;"><b>College:</b> ${s.college}</p>
                            <p style="margin: 4px 0; font-size: 14px; color: #374151;"><b>Date:</b> ${s.date}</p>
                            <p style="margin: 4px 0; font-size: 14px; color: #374151;"><b>Time:</b> ${s.startTime} – ${s.endTime}</p>
                            <p style="margin: 4px 0; font-size: 14px; color: #374151;"><b>SPOC:</b> ${s.spocName} (<a href="tel:${s.spocPhone}" style="color: #4f46e5; text-decoration: none;">${s.spocPhone}</a>)</p>
                            ${
                              s.mapLink
                                ? `
                            <div style="margin-top: 12px;">
                                <a href="${s.mapLink}" style="color: #16a34a; text-decoration: none; font-weight: 600; font-size: 14px;">📍 View College Location</a>
                            </div>`
                                : ""
                            }
                        </div>
                    `,
                      )
                      .join("")}

                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/schedule" 
                           style="background: #4f46e5; color: #fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
                            Access My Portal
                        </a>
                    </div>
                </div>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Smart Bulk Assign email sent to ${trainerEmail}:`,
      info.messageId,
    );
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Error sending smart bulk email to ${trainerEmail}:`, error);
    return { success: false, error: error.message };
  }
};

const { generateICS } = require("./calendar");

// Send Schedule Change Notification (Reschedule or Cancellation or Assignment)
const sendScheduleChangeEmail = async (
  trainerEmail,
  trainerName,
  scheduleData,
  changeType,
  reason,
) => {
  const {
    date,
    college,
    course,
    startTime,
    endTime,
    location,
    mapLink,
    spocName,
    spocPhone,
    oldDate,
    day,
  } = scheduleData;
  const isCancellation = changeType === "cancellation";
  const isAssignment = changeType === "assignment";
  const isReschedule = changeType === "reschedule";

  // Default Configuration
  let subject = `Notification – ${course}`;
  let bodyContent = "";

  // Generate ICS if not cancellation
  let attachments = [];
  if (!isCancellation) {
    try {
      const icsContent = await generateICS(scheduleData);
      attachments.push({
        filename: `${course.replace(/[^a-z0-9]/gi, "_")}.ics`,
        content: icsContent,
        contentType: "text/calendar",
      });
    } catch (err) {
      console.error("Error generating ICS:", err);
    }
  }

  // 1️⃣ ASSIGN SCHEDULE
  if (isAssignment) {
    subject = `Training Assigned – ${course} (${day || "Day 1"})`;
    bodyContent = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; background-color: #ffffff; padding: 20px;">
                <h2 style="color:#16a34a; text-align: center; margin-bottom: 24px;">✅ Training Assigned</h2>

                <div style="background:#f9fafb; padding: 16px; border-radius: 10px; border: 1px solid #eff6ff;">
                    <p style="margin: 8px 0; color: #374151;"><b>Course:</b> ${course}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Day:</b> ${day || "Day 1"}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>College:</b> ${college}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Date:</b> ${date}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Time:</b> ${startTime} – ${endTime}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>SPOC Name:</b> ${spocName || "N/A"}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>SPOC Phone:</b> <a href="tel:${spocPhone}" style="color: #4f46e5; text-decoration: none;">${spocPhone || "N/A"}</a></p>
                </div>

                ${
                  mapLink
                    ? `
                <div style="margin-top: 16px; text-align: center;">
                    <a href="${mapLink}" style="background:#16a34a; color:#fff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
                        📍 View College Location
                    </a>
                </div>`
                    : ""
                }

                <div style="text-align: center; margin-top: 20px;">
                    <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/schedule" 
                       style="background:#4f46e5; color:#fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
                        Access My Portal
                    </a>
                </div>
            </div>
        `;
  }

  // 2️⃣ RESCHEDULE
  else if (isReschedule) {
    subject = `Training Rescheduled – ${course} (${day || "Day 1"})`;
    bodyContent = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; background-color: #ffffff; padding: 20px;">
                <h2 style="color:#f59e0b; text-align: center; margin-bottom: 24px;">🔁 Training Rescheduled</h2>
                
                <p style="text-align: center; color: #4b5563; margin-bottom: 20px;">The following training has been rescheduled.</p>

                <div style="background:#f9fafb; padding: 16px; border-radius: 10px; border: 1px solid #fff7ed;">
                    <p style="margin: 8px 0; color: #374151;"><b>Course:</b> ${course}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>College:</b> ${college}</p>
                    ${oldDate ? `<p style="margin: 8px 0; color: #6b7280; text-decoration: line-through;"><b>Old Date:</b> ${oldDate}</p>` : ""}
                    <p style="margin: 8px 0; color: #374151;"><b>New Date:</b> ${date}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>New Time:</b> ${startTime} – ${endTime}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>SPOC Name:</b> ${spocName || "N/A"}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>SPOC Phone:</b> <a href="tel:${spocPhone}" style="color: #4f46e5; text-decoration: none;">${spocPhone || "N/A"}</a></p>
                </div>

                ${
                  mapLink
                    ? `
                <div style="margin-top: 16px; text-align: center;">
                    <a href="${mapLink}" style="background:#16a34a; color:#fff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
                        📍 View College Location
                    </a>
                </div>`
                    : ""
                }
                
                <div style="text-align: center; margin-top: 20px;">
                    <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/schedule" 
                       style="background:#4f46e5; color:#fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
                        Access My Portal
                    </a>
                </div>
            </div>
        `;
  }

  // 3️⃣ CANCEL SCHEDULE
  else if (isCancellation) {
    subject = `Training Cancelled – ${course}`;
    bodyContent = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; background-color: #ffffff; padding: 20px;">
                <h2 style="color:#dc2626; text-align: center; margin-bottom: 24px;">❌ Training Cancelled</h2>

                <div style="background:#fef2f2; padding: 16px; border-left: 4px solid #dc2626; border-radius: 4px;">
                    <p style="margin: 8px 0; color: #374151;"><b>Course:</b> ${course}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>College:</b> ${college}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Date:</b> ${date}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Time:</b> ${startTime} – ${endTime}</p>
                </div>

                <div style="margin-top: 16px; padding: 12px; background:#fff1f2; border-radius: 8px; color: #be123c;">
                    <b>Admin Remarks:</b><br/>
                    “${reason || "No remarks provided"}”
                </div>

                <div style="text-align: center; margin-top: 20px;">
                    <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/schedule" 
                       style="background:#4f46e5; color:#fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
                        Access My Portal
                    </a>
                </div>
            </div>
        `;
  }

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: subject,
    html: bodyContent,
    attachments: attachments,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Smart ${changeType} email sent to ${trainerEmail}:`,
      info.messageId,
    );
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(
      `Error sending smart ${changeType} email to ${trainerEmail}:`,
      error,
    );
    return { success: false, error: error.message };
  }
};

// 4️⃣ TRAINER COMPLAINT – EMAIL
const sendComplaintNotificationEmail = async (recipients, complaintData) => {
  const {
    trainerName,
    course,
    collegeName,
    date,
    description,
    type,
    category,
    priority,
  } = complaintData;

  // Support single string or array of emails
  const toAddress = Array.isArray(recipients)
    ? recipients.join(",")
    : recipients;

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: toAddress,
    subject: `New Trainer Complaint – ${collegeName || "Details"}`,
    html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 0 auto; background-color: #ffffff; padding: 20px;">
                <h2 style="color:#dc2626; text-align: center; margin-bottom: 24px;">🚨 Trainer Complaint Received</h2>

                <div style="background:#f9fafb; padding: 16px; border-radius: 10px; border: 1px solid #e5e7eb;">
                    <p style="margin: 8px 0; color: #374151;"><b>Trainer:</b> ${trainerName}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Course:</b> ${course || "N/A"}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>College:</b> ${collegeName || "N/A"}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Date:</b> ${date || new Date().toISOString().split("T")[0]}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Category:</b> ${category}</p>
                    <p style="margin: 8px 0; color: #374151;"><b>Priority:</b> ${priority}</p>
                </div>

                <div style="margin-top: 12px; padding: 14px; background:#fff7ed; border-left: 4px solid #f97316; border-radius: 0 8px 8px 0;">
                    <b>Complaint Message:</b><br/>
                    “${description}”
                </div>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`Complaint email sent to ${toAddress}:`, info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Error sending complaint email:`, error);
    return { success: false, error: error.message };
  }
};

// Keep existing status update email logic if used, or update it to match style if needed.
// For now, we focus on the core 4 requirements.

// 5️⃣ TRAINING COMPLETION – EMAIL
const sendTrainingCompletionEmail = async (
  trainerEmail,
  trainerName,
  scheduleData,
) => {
  const { course, college, day, date, status, portalUrl } = scheduleData;
  const isCompleted = status === "Completed" || status === "COMPLETED";

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: `Training Completed – ${course} (${day})`,
    html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden;">
                <div style="text-align: center; padding: 30px 20px;">
                    <h2 style="color:#16a34a; margin: 0; font-size: 24px; font-weight: 800;">✅ Training Day Completed</h2>
                    <p style="color: #6b7280; font-size: 15px; margin-top: 8px;">Your training session has been successfully completed and approved.</p>
                </div>

                <div style="padding: 0 20px 30px;">
                    <div style="background:#f9fafb; padding: 16px; border-radius: 10px; border: 1px solid #f3f4f6;">
                        <p style="margin: 6px 0; color: #374151;"><b>Course:</b> ${course}</p>
                        <p style="margin: 6px 0; color: #374151;"><b>College:</b> ${college}</p>
                        <p style="margin: 6px 0; color: #374151;"><b>Day:</b> ${day}</p>
                        <p style="margin: 6px 0; color: #374151;"><b>Date:</b> ${date}</p>
                        <p style="margin: 6px 0; color: #374151;"><b>Status:</b> 
                            <span style="color:#16a34a; font-weight: 700;">${status}</span>
                        </p>
                    </div>

                    <p style="margin-top: 24px; color: #374151; text-align: center; line-height: 1.5;">
                        Thank you for completing today’s session.<br/>
                        This day is now counted for attendance and salary processing.
                    </p>

                    <div style="text-align: center; margin-top: 24px;">
                        <a href="${portalUrl || process.env.FRONTEND_URL || "#"}" 
                           style="background:#4f46e5; color:#fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
                            View in Portal
                        </a>
                    </div>
                </div>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Training completion email sent to ${trainerEmail}:`,
      info.messageId,
    );
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(
      `Error sending training completion email to ${trainerEmail}:`,
      error,
    );
    return { success: false, error: error.message };
  }
};

// 6️⃣ ACCOUNT VERIFICATION SUCCESS – EMAIL
const sendAccountVerificationSuccessEmail = async (
  trainerEmail,
  trainerName,
) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: `🎉 Account Verified – Access Unlocked`,
    html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 20px;">
                <h2 style="color:#16a34a; text-align: center; margin-bottom: 24px;">✅ Account Verified</h2>

                <div style="background:#f0fdf4; padding: 20px; border-radius: 12px; border: 1px solid #bbf7d0; text-align: center;">
                    <p style="font-size: 16px; color: #166534; margin: 0;">
                        Congratulations <b>${trainerName}</b>! <br/><br/>
                        Your profile and documents have been successfully verified by the Admin Team.
                    </p>
                    
                    <p style="margin-top: 16px; font-weight: bold; color: #15803d;">
                        🔓 Your Dashboard is now UNLOCKED.
                    </p>
                </div>

                <p style="text-align: center; color: #374151; margin-top: 24px;">
                    You can now access your schedule, view pay slips, and manage your profile fully.
                </p>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/dashboard" 
                       style="background:#16a34a; color:#fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; display: inline-block; box-shadow: 0 4px 6px -1px rgba(22, 163, 74, 0.3);">
                        Enter Dashboard
                    </a>
                </div>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Verification Success email sent to ${trainerEmail}:`,
      info.messageId,
    );
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Error sending verification success email:`, error);
    return { success: false, error: error.message };
  }
};

// 7️⃣ DOCUMENT REJECTION – EMAIL
const sendDocumentRejectionEmail = async (
  trainerEmail,
  trainerName,
  documentName,
  reason,
  options = {},
) => {
  const rejectedDocuments = Array.isArray(documentName)
    ? documentName.filter(Boolean)
    : [documentName].filter(Boolean);
  const actionUrl =
    options.actionUrl ||
    `${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer-signup`;
  const buttonLabel = options.buttonLabel || "Upload Corrected Document";
  const rejectedDocumentsHtml = rejectedDocuments
    .map(
      (entry) =>
        `<li style="margin: 0 0 8px; color: #111827; font-weight: 600;">${entry}</li>`,
    )
    .join("");
  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: "Document Re-upload Required",
    html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 20px;">
                <h2 style="color:#0f172a; text-align: center; margin-bottom: 24px;">Document Re-upload Required</h2>

                <p style="margin: 0 0 18px; color: #111827; font-size: 15px;">
                    Hello <b>${trainerName}</b>,
                </p>
                <p style="margin: 0 0 18px; color: #374151; font-size: 15px; line-height: 1.6;">
                    Your trainer registration requires document correction.
                </p>
                <div style="margin-top: 20px; padding: 18px; background:#f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <p style="margin: 0 0 12px; color: #0f172a; font-size: 14px; font-weight: 700;">Rejected Documents:</p>
                    <ul style="margin: 0; padding-left: 18px;">
                        ${rejectedDocumentsHtml}
                    </ul>
                </div>
                ${
                  reason
                    ? `
                <div style="margin-top: 18px; padding: 15px; background:#fff1f2; border-left: 4px solid #e11d48; border-radius: 4px;">
                    <p style="margin: 0; color: #881337; font-size: 14px;"><b>Reason:</b></p>
                    <p style="margin-top: 5px; color: #be123c; font-weight: 600;">${reason}</p>
                </div>`
                    : ""
                }
                <p style="text-align: center; color: #374151; margin-top: 24px; line-height: 1.6;">
                    Please upload the corrected document using the link below:
                </p>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${actionUrl}" 
                       style="background:#dc2626; color:#fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; display: inline-block; box-shadow: 0 4px 6px -1px rgba(220, 38, 38, 0.3);">
                        ${buttonLabel}
                    </a>
                </div>
                <p style="margin: 28px 0 0; color: #374151; font-size: 14px; line-height: 1.7;">
                    Regards<br/>
                    <b>MBK CARRIERZ</b>
                </p>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Document Rejection email sent to ${trainerEmail}:`,
      info.messageId,
    );
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Error sending rejection email:`, error);
    return { success: false, error: error.message };
  }
};

// 8️⃣ PROFILE REJECTION – EMAIL (Re-upload All)
const sendProfileRejectionEmail = async (trainerEmail, trainerName, reason) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: `⚠️ Critical Action Required: Profile Rejected`,
    html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 20px;">
                <h2 style="color:#dc2626; text-align: center; margin-bottom: 24px;">❌ Profile Verification Failed</h2>

                <div style="background:#fef2f2; padding: 20px; border-radius: 12px; border: 1px solid #fecaca;">
                    <p style="margin: 0; color: #991b1b; font-size: 15px;">
                        Hello <b>${trainerName}</b>,<br/><br/>
                        Your profile verification has been <b>REJECTED</b> by the admin team.
                    </p>
                </div>

                <div style="margin-top: 20px; padding: 15px; background:#fff1f2; border-left: 4px solid #e11d48; border-radius: 4px;">
                    <p style="margin: 0; color: #881337; font-size: 14px;"><b>Reason for Rejection:</b></p>
                    <p style="margin-top: 5px; color: #be123c; font-weight: 600; font-style: italic;">"${reason}"</p>
                </div>

                <p style="text-align: center; color: #374151; margin-top: 24px; font-weight: bold;">
                    ⚠️ Please re-upload ALL required documents to proceed.
                </p>

                <div style="text-align: center; margin-top: 30px;">
                    <a href="${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/profile" 
                       style="background:#dc2626; color:#fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; display: inline-block; box-shadow: 0 4px 6px -1px rgba(220, 38, 38, 0.3);">
                        Go to Profile
                    </a>
                </div>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Profile Rejection email sent to ${trainerEmail}:`,
      info.messageId,
    );
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Error sending profile rejection email:`, error);
    return { success: false, error: error.message };
  }
};

// 9️⃣ DOCUMENT SUBMISSION NOTIFICATION – EMAIL (To Admin)
const sendTrainerDocumentReminderEmail = async ({
  trainerEmail,
  trainerName,
  missingDocuments = [],
  loginUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer/profile`,
}) => {
  const htmlList = missingDocuments
    .map((item) => `<li style="margin: 6px 0;">${item}</li>`)
    .join("");
  const textList = missingDocuments.map((item) => `- ${item}`).join("\n");

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK CarrierZ" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: "Complete Your Trainer Registration",
    text: [
      `Hello ${trainerName || "Trainer"},`,
      "",
      "Your trainer registration is still incomplete.",
      "",
      "Pending documents:",
      textList || "- Please complete all required documents",
      "",
      "Please upload the required documents to complete your trainer registration.",
      "",
      `Login and upload documents here: ${loginUrl}`,
      "",
      "Regards,",
      "MBK Technologies",
    ].join("\n"),
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 620px; margin: 0 auto; background-color: #ffffff; padding: 24px;">
        <h2 style="color:#b45309; text-align:center; margin-bottom:24px;">Complete Your Trainer Registration</h2>
        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:12px; padding:20px;">
          <p style="margin:0; color:#78350f; font-size:15px;">
            Hello <b>${trainerName || "Trainer"}</b>,
            <br/><br/>
            Your trainer registration is still incomplete.
          </p>
        </div>
        <div style="margin-top:20px; background:#fff7ed; border-left:4px solid #f59e0b; border-radius:8px; padding:16px 18px;">
          <p style="margin:0 0 10px; color:#9a3412; font-weight:700;">Pending documents:</p>
          <ul style="margin:0; padding-left:18px; color:#7c2d12;">
            ${htmlList || "<li>Please complete all required documents</li>"}
          </ul>
        </div>
        <p style="text-align:center; color:#374151; margin-top:24px; font-size:14px;">
          Please upload the required documents to complete your trainer registration.
        </p>
        <div style="text-align:center; margin-top:28px;">
          <a href="${loginUrl}" style="background:#f59e0b; color:#ffffff; padding:14px 28px; border-radius:8px; text-decoration:none; font-weight:700; display:inline-block;">
            Upload Missing Documents
          </a>
        </div>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Trainer document reminder email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending trainer document reminder email:", error);
    return { success: false, error: error.message };
  }
};

const sendTrainerRegistrationReminderEmail = async ({
  trainerEmail,
  trainerName,
  nextStepLabel = "Trainer Registration",
  reminderDay = null,
  pendingItems = [],
  pendingLabel = "Pending items",
  actionLabel = "Continue Registration",
  loginUrl = `${process.env.FRONTEND_URL || "http://localhost:3000"}/trainer-signup`,
}) => {
  const htmlList = pendingItems
    .map((item) => `<li style="margin: 6px 0;">${item}</li>`)
    .join("");
  const textList = pendingItems.map((item) => `- ${item}`).join("\n");
  const reminderPrefix = reminderDay ? `Day ${reminderDay} Reminder` : "Reminder";

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK CarrierZ" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: `${reminderPrefix}: Complete ${nextStepLabel}`,
    text: [
      `Hello ${trainerName || "Trainer"},`,
      "",
      `This is your ${reminderPrefix.toLowerCase()} to complete your trainer onboarding.`,
      "",
      `Next step: ${nextStepLabel}`,
      "",
      `${pendingLabel}:`,
      textList || "- Continue your pending onboarding step",
      "",
      `Continue here: ${loginUrl}`,
      "",
      "Regards,",
      "MBK CarrierZ",
    ].join("\n"),
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 620px; margin: 0 auto; background-color: #ffffff; padding: 24px;">
        <h2 style="color:#174264; text-align:center; margin-bottom:24px;">${reminderPrefix}: Complete ${nextStepLabel}</h2>
        <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:20px;">
          <p style="margin:0; color:#1e3a8a; font-size:15px;">
            Hello <b>${trainerName || "Trainer"}</b>,
            <br/><br/>
            This is your ${reminderPrefix.toLowerCase()} to complete your trainer onboarding.
          </p>
        </div>
        <div style="margin-top:20px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:8px; padding:16px 18px;">
          <p style="margin:0 0 10px; color:#0f172a; font-weight:700;">Next step: ${nextStepLabel}</p>
          <p style="margin:0 0 10px; color:#334155; font-weight:600;">${pendingLabel}</p>
          <ul style="margin:0; padding-left:18px; color:#475569;">
            ${htmlList || "<li>Continue your pending onboarding step</li>"}
          </ul>
        </div>
        <div style="text-align:center; margin-top:28px;">
          <a href="${loginUrl}" style="background:#1d7b56; color:#ffffff; padding:14px 28px; border-radius:8px; text-decoration:none; font-weight:700; display:inline-block;">
            ${actionLabel}
          </a>
        </div>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Trainer registration reminder email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending trainer registration reminder email:", error);
    return { success: false, error: error.message };
  }
};

const sendAdminSubmissionNotificationEmail = async (
  adminEmails,
  trainerName,
  trainerEmail,
  trainerId,
  city = "N/A",
  qualification = "N/A",
) => {
  // Ensure adminEmails is an array or string
  const toAddress = Array.isArray(adminEmails)
    ? adminEmails.join(",")
    : adminEmails;
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  const reviewUrl = `${frontendUrl}/dashboard/trainers`;

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: toAddress,
    subject: `New Trainer Registration: ${trainerName}`,
    html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 20px;">
                <h2 style="color:#2563eb; text-align: center;">New Trainer Registration</h2>

                <div style="background:#f3f4f6; padding: 20px; border-radius: 12px; border: 1px solid #e5e7eb;">
                    <p style="margin: 5px 0;"><b>Name:</b> ${trainerName}</p>
                    <p style="margin: 5px 0;"><b>City:</b> ${city}</p>
                    <p style="margin: 5px 0;"><b>Qualification:</b> ${qualification}</p>
                    <p style="margin: 5px 0;"><b>Email:</b> ${trainerEmail}</p>
                </div>

                <p style="text-align: center; margin-top: 24px;">
                    Review:<br/>
                    <a href="${reviewUrl}" 
                       style="color: #2563eb; font-weight: bold; text-decoration: underline;">
                        ${reviewUrl}
                    </a>
                </p>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `Admin Submission Notification sent to ${toAddress}:`,
      info.messageId,
    );
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`Error sending admin submission notification:`, error);
    return { success: false, error: error.message };
  }
};

// 10️⃣ REGISTRATION OTP – EMAIL
const sendRegistrationOTP = async (userEmail, userName, otp) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: userEmail,
    subject: `Your Verification Code - MBK BY TSMG`,
    html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
                <h2 style="color: #4F46E5; text-align: center;">Email Verification</h2>
                <p>Hello ${userName},</p>
                <p>Thank you for registering. Please use the following OTP to verify your email address:</p>
                <div style="text-align: center; margin: 30px 0;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #1F2937; background-color: #F3F4F6; padding: 10px 20px; border-radius: 8px;">${otp}</span>
                </div>
                <p>This code will expire in 10 minutes.</p>
                <p>If you did not request this, please ignore this email.</p>
                <hr style="border: 0; border-top: 1px solid #E5E7EB; margin: 20px 0;">
                <p style="color: #6B7280; font-size: 12px; text-align: center;">This is an automated message from MBK BY TSMG.</p>
            </div>
        `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Registration OTP email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending registration OTP email:", error);
    throw new Error(`Email delivery failed: ${error.message}`);
  }
};

// 11️⃣ TRAINER APPROVAL + LOGIN CREDENTIALS – EMAIL
const sendTrainerApprovalEmail = async (
  trainerEmail,
  trainerName,
  loginUrl,
  trainerId,
  plainPassword,
) => {
  const year = new Date().getFullYear();
  const loginPasswordRow = plainPassword
    ? `
                            <tr>
                              <td style="padding:6px 0; border-top:1px solid #e5e7eb;">
                                <span style="color:#6b7280; font-size:13px; font-weight:600;">Login Password</span><br>
                                <span style="color:#1f2937; font-size:14px; font-family:'Courier New',monospace; font-weight:700; background:#f3f4f6; padding:2px 8px; border-radius:4px;">${plainPassword}</span>
                              </td>
                            </tr>`
    : `
                            <tr>
                              <td style="padding:6px 0; border-top:1px solid #e5e7eb;">
                                <span style="color:#6b7280; font-size:13px; font-weight:600;">Login Password</span><br>
                                <span style="color:#1f2937; font-size:13px;">Use your existing password to sign in.</span>
                              </td>
                            </tr>`;

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK CarrierZ" <mbktechnology8@gmail.com>',
    to: trainerEmail,
    subject: "Profile Approved Successfully - MBK CarrierZ",
    html: `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
      <body style="margin:0; padding:0; background-color:#f0f9f4; font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f9f4; padding:40px 20px;">
          <tr>
            <td align="center">
              <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);">
                <tr>
                  <td style="background:linear-gradient(135deg, #059669 0%, #10b981 100%); padding:36px 40px; text-align:center;">
                    <div style="width:64px; height:64px; background:rgba(255,255,255,0.25); border-radius:50%; line-height:64px; font-size:20px; font-weight:700; margin:0 auto 14px; color:#ffffff;">OK</div>
                    <h1 style="margin:0; color:#ffffff; font-size:24px; font-weight:800;">Profile Approved Successfully</h1>
                    <p style="margin:8px 0 0; color:rgba(255,255,255,0.9); font-size:14px;">Your trainer profile is approved and ready for portal login.</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:32px 40px;">
                    <p style="margin:0 0 16px; color:#1f2937; font-size:15px;">Hello <strong>${trainerName}</strong>,</p>
                    <p style="margin:0 0 24px; color:#4b5563; font-size:14px; line-height:1.7;">
                      Your trainer profile has been <strong style="color:#059669;">approved successfully</strong>. You can now log in to the MBK CarrierZ portal using the login details below.
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%); border:2px solid #a7f3d0; border-radius:14px; margin-bottom:24px;">
                      <tr>
                        <td align="center" style="padding:24px 20px;">
                          <p style="margin:0 0 6px; color:#065f46; font-size:11px; text-transform:uppercase; letter-spacing:1.5px; font-weight:700;">Trainer ID</p>
                          <p style="margin:0; color:#047857; font-size:36px; font-weight:800; letter-spacing:6px; font-family:'Courier New', monospace;">${trainerId || "Assigned Soon"}</p>
                        </td>
                      </tr>
                    </table>
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8faff; border:1px solid #e0e7ff; border-radius:12px; margin-bottom:24px;">
                      <tr>
                        <td style="padding:20px 24px;">
                          <p style="margin:0 0 12px; color:#3730a3; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:1px;">Portal Login Details</p>
                          <table width="100%" cellpadding="0" cellspacing="0">
                            <tr>
                              <td style="padding:6px 0;">
                                <span style="color:#6b7280; font-size:13px; font-weight:600;">Login URL</span><br>
                                <a href="${loginUrl}" style="color:#4f46e5; font-size:13px; text-decoration:none;">${loginUrl}</a>
                              </td>
                            </tr>
                            <tr>
                              <td style="padding:6px 0; border-top:1px solid #e5e7eb;">
                                <span style="color:#6b7280; font-size:13px; font-weight:600;">Login Email</span><br>
                                <span style="color:#1f2937; font-size:13px;">${trainerEmail}</span>
                              </td>
                            </tr>
                            <tr>
                              <td style="padding:6px 0; border-top:1px solid #e5e7eb;">
                                <span style="color:#6b7280; font-size:13px; font-weight:600;">Trainer ID</span><br>
                                <span style="color:#1f2937; font-size:13px; font-family:'Courier New', monospace; font-weight:700;">${trainerId || "Assigned Soon"}</span>
                              </td>
                            </tr>
                            ${loginPasswordRow}
                          </table>
                        </td>
                      </tr>
                    </table>
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:24px;">
                      <tr>
                        <td style="padding:14px 18px;">
                          <p style="margin:0; color:#374151; font-size:13px; line-height:1.7;">
                            Your profile approval is complete. Please use the login email and password above to access the trainer portal.
                          </p>
                        </td>
                      </tr>
                    </table>
                    <div style="text-align:center; margin:28px 0;">
                      <a href="${loginUrl}" style="background:linear-gradient(135deg, #059669 0%, #10b981 100%); color:#ffffff; padding:14px 36px; text-decoration:none; border-radius:10px; font-size:15px; font-weight:700; display:inline-block; box-shadow:0 4px 12px rgba(5,150,105,0.35);">
                        Login to Portal
                      </a>
                    </div>
                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb; border:1px solid #fde68a; border-radius:10px;">
                      <tr>
                        <td style="padding:14px 18px;">
                          <p style="margin:0; color:#92400e; font-size:12px; line-height:1.6;">
                            <strong>Security Reminder:</strong> Please change your password after your first login and keep your Trainer ID and password confidential.
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background:#f8fafc; padding:20px 40px; border-top:1px solid #e2e8f0; text-align:center;">
                    <p style="margin:0 0 4px; color:#94a3b8; font-size:11px;">This is an automated message from <strong>MBK CarrierZ</strong></p>
                    <p style="margin:0; color:#cbd5e1; font-size:11px;">&copy; ${year} MBK Technologies. All rights reserved.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Trainer approval email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending trainer approval email:", error);
    return { success: false, error: error.message };
  }
};

const sendTrainerLogin = async (trainer) => {
  const trainerName = trainer.firstName
    ? `${trainer.firstName} ${trainer.lastName}`
    : trainer.email;
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  const loginUrl = `${frontendUrl}/login`;

  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK BY TSMG" <mbktechnology8@gmail.com>',
    to: trainer.email,
    subject: "Trainer Registration Approved",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Trainer Registration Approved</h2>
        <p>Dear ${trainerName},</p>
        <p>Your trainer account has been approved.</p>
        <div style="background: #f4f4f4; padding: 15px; border-radius: 8px;">
          <p><b>Login URL:</b> <a href="${loginUrl}">${loginUrl}</a></p>
          <p><b>Email:</b> ${trainer.email}</p>
          <p><b>Password:</b> (your chosen password)</p>
        </div>
        <p>Regards,<br/>MBK Technology</p>
      </div>
    `,
  };

  try {
    return await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error("Error sending trainer login details:", error);
    return { success: false, error: error.message };
  }
};

const sendCompanyAdminWelcomeEmail = async ({
  adminEmail,
  companyName,
  adminName,
  phone,
  address,
  logoUrl,
  verificationLink,
}) => {
  const mailOptions = {
    from: process.env.EMAIL_FROM || '"MBK CarrierZ" <mbktechnology8@gmail.com>',
    to: adminEmail,
    subject: `Welcome to MBK, ${adminName || "Company Admin"}!`,
    text: [
      `Welcome to MBK, ${adminName || "Company Admin"}!`,
      "",
      `Thank you for joining MBK.`,
      "",
      `Company: ${companyName || "N/A"}`,
      `Admin Name: ${adminName || "N/A"}`,
      `Phone Number: ${phone || "N/A"}`,
      `Email: ${adminEmail || "N/A"}`,
      `Address: ${address || "N/A"}`,
      "",
      `Verify your email: ${verificationLink}`,
    ].join("\n"),
    html: welcomeEmailTemplate({
      adminName: adminName || "N/A",
      companyName: companyName || "N/A",
      phone: phone || "N/A",
      email: adminEmail || "N/A",
      address: address || "N/A",
      logoUrl: logoUrl || "",
      verifyLink: verificationLink,
    }),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("Company welcome email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending company welcome email:", error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendComplaintNotificationEmail,
  sendComplaintStatusUpdateEmail,
  sendTrainerRegistrationNotificationEmail,
  sendBulkScheduleEmail,
  sendScheduleChangeEmail,
  sendTrainingCompletionEmail,
  sendAccountVerificationSuccessEmail,
  sendDocumentRejectionEmail,
  sendProfileRejectionEmail,
  sendTrainerDocumentReminderEmail,
  sendTrainerRegistrationReminderEmail,
  sendAdminSubmissionNotificationEmail,
  sendRegistrationOTP,
  sendTrainerApprovalEmail,
  sendMail,
  sendOtpEmail,
  sendTrainerLogin,
  sendCompanyAdminWelcomeEmail,
};



