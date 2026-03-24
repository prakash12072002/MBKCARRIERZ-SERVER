function companyActivatedEmail({ companyName, adminName, coNDActEmail }) {
  return `
  <div style="font-family:Arial, sans-serif; background:#f4f6f9; padding:30px;">
    <div style="max-width:650px; margin:auto; background:#ffffff; border-radius:12px; padding:30px; box-shadow:0 10px 25px rgba(0,0,0,0.05);">

      <h2 style="color:#1e3a8a; text-align:center;">
        MBK Company Admin Account Activated
      </h2>

      <p>Hello <strong>${adminName}</strong>,</p>

      <p>
        Thank you for joining <strong>MBK Carriez</strong>.
        Your company <strong>${companyName}</strong> has been successfully activated.
      </p>

      <p>
        From now onwards, all trainer activities, schedules, and daily updates
        related to your company will be shared directly to your registered mailbox.
      </p>

      <div style="background:#f1f5f9; padding:15px; border-radius:8px; margin:20px 0;">
        <p><strong>Company CoNDAct Email:</strong> ${coNDActEmail}</p>
      </div>

      <p>
        Please monitor your mailbox regularly to stay updated with
        trainer performance, attendance reports, and company activities.
      </p>

      <p>
        We are excited to grow together with you.
      </p>

      <p>
        Thanks & Regards,<br/>
        <strong>MBK Carriez Team</strong>
      </p>

      <hr style="margin-top:30px;" />

      <p style="font-size:12px; color:#888; text-align:center;">
        © ${new Date().getFullYear()} MBK Carriez. All rights reserved.
      </p>

    </div>
  </div>
  `;
}

module.exports = companyActivatedEmail;
