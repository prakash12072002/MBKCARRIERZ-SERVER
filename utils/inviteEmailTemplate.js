function inviteEmailTemplate(link) {
  return `
  <div style="font-family:Arial;background:#f4f6f9;padding:30px;">
    <div style="max-width:600px;margin:auto;background:white;padding:30px;border-radius:12px;">
      
      <h2 style="color:#1e3a8a;">Welcome to MBK 🚀</h2>

      <p>You have been invited to create your company profile on MBK Platform.</p>

      <div style="text-align:center;margin:30px 0;">
        <a href="${link}"
           style="background:#2563eb;color:white;padding:12px 25px;
           text-decoration:none;border-radius:6px;font-weight:bold;">
           Complete Company Setup
        </a>
      </div>

      <p>This link is valid for 24 hours.</p>

      <p>Thanks,<br/>MBK Team</p>
    </div>
  </div>
  `;
}

module.exports = inviteEmailTemplate;
