import nodemailer, { type Transporter } from "nodemailer";
import { getSystemSettingSecret, getSystemSetting } from "../routes/settings.routes.js";
import { recordSystemLog } from "./system-logger.service.js";

let transporter: Transporter | null = null;
let cachedConfigHash = "";

async function getTransporter(): Promise<Transporter | null> {
  const host = await getSystemSetting<string>("smtp.host", "");
  const port = await getSystemSetting<number>("smtp.port", 0);
  const user = await getSystemSetting<string>("smtp.user", "");
  const password = await getSystemSettingSecret("smtp.password");
  const from = await getSystemSetting<string>("smtp.from", "");
  if (!host || !port) return null;
  const configHash = `${host}:${port}:${user}:${from}`;
  if (transporter && configHash === cachedConfigHash) return transporter;
  transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: user && password ? { user, pass: password } : undefined });
  (transporter as any).__from = from || user || "wiki@localhost";
  cachedConfigHash = configHash;
  return transporter;
}

export function resetMailer(): void { transporter = null; cachedConfigHash = ""; }

export async function sendMail(opts: { to: string; subject: string; text: string }): Promise<boolean> {
  const t = await getTransporter().catch(() => null);
  if (!t) { void recordSystemLog({ level: "warn", source: "mailer", message: "SMTP not configured", meta: { to: opts.to, subject: opts.subject } }).catch(() => {}); return false; }
  try { await t.sendMail({ from: (t as any).__from, to: opts.to, subject: opts.subject, text: opts.text }); void recordSystemLog({ level: "info", source: "mailer", message: `Email sent to ${opts.to}`, meta: {} }).catch(() => {}); return true; }
  catch (err) { void recordSystemLog({ level: "error", source: "mailer", message: `Failed to send to ${opts.to}`, meta: { error: String(err) } }).catch(() => {}); return false; }
}

export async function sendShareLinkWarning(toEmail: string, tokenName: string, warningCount: number, tokenId: string): Promise<boolean> {
  const subject = `[Wiki] Share link "${tokenName}" inactive — warning ${warningCount}/3`;
  const text = `The share link "${tokenName}" (ID: ${tokenId}) has not been accessed in 30 days.\n\nThis is warning ${warningCount} of 3. After 3 warnings, the link will be automatically revoked.`;
  return sendMail({ to: toEmail, subject, text });
}

export async function sendMentionNotification(toEmail: string, mentionerName: string, pageSlug: string, branchId: string): Promise<boolean> {
  const subject = `[Wiki] ${mentionerName} mentioned you in "${pageSlug}"`;
  const text = `${mentionerName} mentioned you in "${pageSlug}".\n\nOpen: ${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/w/${branchId}`;
  return sendMail({ to: toEmail, subject, text });
}
