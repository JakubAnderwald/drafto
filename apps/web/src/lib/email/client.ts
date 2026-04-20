import * as Sentry from "@sentry/nextjs";
import { Resend } from "resend";
import { env } from "@/env";

let cached: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!cached) cached = new Resend(env.RESEND_API_KEY);
  return cached;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(input: SendEmailInput): Promise<{ id: string } | null> {
  const client = getClient();
  if (!client) {
    Sentry.captureMessage("sendEmail called without RESEND_API_KEY", { level: "warning" });
    return null;
  }

  try {
    const { data, error } = await client.emails.send({
      from: env.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });

    if (error) {
      Sentry.captureException(error, { extra: { subject: input.subject } });
      return null;
    }

    return data ? { id: data.id } : null;
  } catch (err) {
    Sentry.captureException(err, { extra: { subject: input.subject } });
    return null;
  }
}
