import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { getSettingValue } from "./settings.service.js";
import { log } from "./log.service.js";

let transporter: Transporter | null = null;

async function getTransporter(): Promise<Transporter | null> {
  if (transporter) return transporter;

  const host = await getSettingValue("smtp_host") as string | null;
  const port = await getSettingValue("smtp_port") as number | null;
  const user = await getSettingValue("smtp_user") as string | null;
  const pass = await getSettingValue("smtp_pass") as string | null;
  const from = await getSettingValue("smtp_from") as string | null;

  if (!host || !port) return null;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  });

  // Store from for later use
  (transporter as any).__from = from || user || "wiki@localhost";

  return transporter;
}

/** Reset the transporter (e.g. when SMTP settings change at runtime). */
export function resetMailer() {
  transporter = null;
}

export async function sendMail(opts: { to: string; subject: string; text: string }): Promise<boolean> {
  const t = await getTransporter();
  if (!t) {
    log("warn", "mailer", "SMTP not configured, cannot send email", { to: opts.to, subject: opts.subject });
    return false;
  }

  try {
    await t.sendMail({
      from: (t as any).__from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    });
    log("info", "mailer", `Email sent to ${opts.to}: ${opts.subject}`);
    return true;
  } catch (err) {
    log("error", "mailer", `Failed to send email to ${opts.to}`, { error: String(err) });
    return false;
  }
}

/** Send share-link warning notification to the token creator. */
export async function sendShareLinkWarning(
  toEmail: string,
  tokenName: string,
  warningCount: number,
  tokenId: string,
): Promise<boolean> {
  const subject = `[Wiki] Share link "${tokenName}" inactive — warning ${warningCount}/3`;
  const text = [
    `The share link "${tokenName}" (ID: ${tokenId}) has not been accessed in 30 days.`,
    ``,
    `This is warning ${warningCount} of 3. After 3 warnings, the link will be automatically revoked.`,
    ``,
    `You can view and manage your share links from your Wiki settings.`,
  ].join("\n");

  return sendMail({ to: toEmail, subject, text });
}
