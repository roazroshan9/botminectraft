import nodemailer from "nodemailer";
import { logger } from "./logger.js";

function createTransport() {
  const host = process.env["SMTP_HOST"];
  const port = Number(process.env["SMTP_PORT"] ?? 587);
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];

  if (!host || !user || !pass) {
    logger.warn("SMTP not configured — emails will be logged only");
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

export async function sendPasswordResetEmail(to: string, username: string, otp: string): Promise<boolean> {
  const from = process.env["SMTP_FROM"] || process.env["SMTP_USER"] || "noreply@craftbot.app";
  const transport = createTransport();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0c14;font-family:'Segoe UI',system-ui,sans-serif">
  <div style="max-width:480px;margin:40px auto;background:#12151f;border:1px solid #2a3050;border-radius:14px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#5c7cfa,#7950f2);padding:28px 32px;text-align:center">
      <div style="font-size:32px">⛏</div>
      <div style="font-size:20px;font-weight:800;color:#fff;margin-top:8px">CraftBot SaaS</div>
    </div>
    <div style="padding:32px">
      <p style="color:#c9d1d9;margin:0 0 8px">Hi <strong style="color:#fff">${username}</strong>,</p>
      <p style="color:#6e7691;margin:0 0 24px;line-height:1.6">We received a request to reset your password. Use the code below — it expires in <strong style="color:#f59f00">15 minutes</strong>.</p>
      <div style="background:#1a1e2e;border:2px dashed #5c7cfa;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <div style="font-size:36px;font-weight:900;letter-spacing:10px;color:#fff;font-family:monospace">${otp}</div>
        <div style="font-size:12px;color:#6e7691;margin-top:8px">One-time reset code</div>
      </div>
      <p style="color:#6e7691;font-size:12px;margin:0;line-height:1.6">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
    </div>
    <div style="background:#0a0c14;padding:16px 32px;text-align:center;border-top:1px solid #2a3050">
      <p style="color:#4c5578;font-size:11px;margin:0">© CraftBot SaaS — This is an automated message, do not reply.</p>
    </div>
  </div>
</body>
</html>`;

  if (!transport) {
    logger.info({ to, otp }, "📧 [SMTP not configured] Password reset OTP (dev mode)");
    return true;
  }

  try {
    await transport.sendMail({
      from: `"CraftBot SaaS" <${from}>`,
      to,
      subject: "Your CraftBot password reset code",
      html,
      text: `Hi ${username},\n\nYour password reset code is: ${otp}\n\nThis code expires in 15 minutes.\n\nIf you didn't request this, ignore this email.`,
    });
    logger.info({ to }, "Password reset email sent");
    return true;
  } catch (err) {
    logger.error({ err, to }, "Failed to send password reset email");
    return false;
  }
}
