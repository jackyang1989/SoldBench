import { connect } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import type { Transaction } from "@soldbench/db";
import { transaction } from "@soldbench/db";
import type { Locale } from "@soldbench/shared";
import type { AuthService } from "./service.ts";

export type OutboundMail = {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  locale: Locale;
  purpose: "verify_email" | "reset_password";
};

export interface MailTransport {
  readonly provider: "resend" | "smtp";
  send(mail: OutboundMail): Promise<{ providerMessageId: string }>;
}

export class MailDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Genuine Resend HTTPS API transport (`POST /emails`) with idempotency binding per outbox mail ID.
 */
export class ResendMailTransport implements MailTransport {
  readonly provider = "resend" as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: {
      apiKey: string;
      from: string;
      apiBaseUrl?: string;
      timeoutMs?: number;
    },
  ) {
    if (!config.apiKey || !config.from) throw new Error("resend_transport_credentials_required");
    this.baseUrl = (config.apiBaseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async send(mail: OutboundMail): Promise<{ providerMessageId: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": mail.id,
        },
        body: JSON.stringify({
          from: mail.from || this.config.from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MailDeliveryError("mail_network_error", true, "Failed to reach Resend API.");
    }
    const text = await res.text();
    let parsed: { id?: string } = {};
    try {
      parsed = text ? (JSON.parse(text) as { id?: string }) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new MailDeliveryError(
        `resend_http_${res.status}`,
        retryable,
        `Resend API rejected email (${res.status}).`,
      );
    }
    if (!parsed.id) {
      throw new MailDeliveryError("resend_missing_id", true, "Resend API omitted message id.");
    }
    return { providerMessageId: parsed.id };
  }
}

function readSmtpReply(socket: NodeJS.ReadWriteStream): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines: string[] = [];
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\r\n")) {
        const idx = buffer.indexOf("\r\n");
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        lines.push(line);
        if (/^\d{3} /.test(line)) {
          cleanup();
          resolve({ code: Number(line.slice(0, 3)), lines });
          return;
        }
      }
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(new MailDeliveryError("smtp_socket_error", true, err.message));
    };
    const onClose = () => {
      cleanup();
      reject(new MailDeliveryError("smtp_connection_closed", true, "SMTP socket closed unexpectedly."));
    };
    function cleanup() {
      socket.off("data", onData);
      socket.off("error", onErr);
      socket.off("close", onClose);
    }
    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("close", onClose);
  });
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function dotStuffBody(text: string): string {
  return text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

/**
 * Zero-dependency RFC 5321/4954 SMTP transactional mail client over `node:net`/`node:tls`.
 */
export class SmtpMailTransport implements MailTransport {
  readonly provider = "smtp" as const;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: {
      host: string;
      port: number;
      from: string;
      secure?: boolean;
      ehloDomain?: string;
      auth?: { user: string; pass: string };
      timeoutMs?: number;
    },
  ) {
    if (!config.host || !config.port || !config.from) {
      throw new Error("smtp_transport_config_required");
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async send(mail: OutboundMail): Promise<{ providerMessageId: string }> {
    const socket: TLSSocket | ReturnType<typeof connect> = this.config.secure
      ? connectTls({ host: this.config.host, port: this.config.port })
      : connect({ host: this.config.host, port: this.config.port });

    socket.setTimeout(this.timeoutMs, () => {
      socket.destroy(new Error("smtp_timeout"));
    });

    await new Promise<void>((resolve, reject) => {
      const event = this.config.secure ? "secureConnect" : "connect";
      const onOk = () => {
        socket.off("error", onErr);
        resolve();
      };
      const onErr = (err: Error) => {
        socket.off(event, onOk);
        reject(new MailDeliveryError("smtp_connect_failed", true, err.message));
      };
      socket.once(event, onOk);
      socket.once("error", onErr);
    });

    const sendCmd = async (cmd: string, expectedCodes: number[]) => {
      socket.write(`${cmd}\r\n`);
      const reply = await readSmtpReply(socket);
      if (!expectedCodes.includes(reply.code)) {
        const retryable = reply.code >= 400 && reply.code < 500;
        throw new MailDeliveryError(
          `smtp_${reply.code}`,
          retryable,
          `SMTP command failed (${reply.code}): ${reply.lines.at(-1) ?? ""}`,
        );
      }
      return reply;
    };

    try {
      const greeting = await readSmtpReply(socket);
      if (greeting.code !== 220) {
        throw new MailDeliveryError(
          `smtp_${greeting.code}`,
          greeting.code >= 400 && greeting.code < 500,
          "SMTP greeting rejected.",
        );
      }
      const ehloDomain = sanitizeHeaderValue(this.config.ehloDomain ?? "soldbench.com");
      await sendCmd(`EHLO ${ehloDomain}`, [250]);
      if (this.config.auth) {
        const plain = Buffer.from(
          `\u0000${this.config.auth.user}\u0000${this.config.auth.pass}`,
          "utf8",
        ).toString("base64");
        await sendCmd(`AUTH PLAIN ${plain}`, [235]);
      }
      const envelopeFrom = sanitizeHeaderValue(mail.from || this.config.from);
      const envelopeTo = sanitizeHeaderValue(mail.to);
      await sendCmd(`MAIL FROM:<${envelopeFrom}>`, [250]);
      await sendCmd(`RCPT TO:<${envelopeTo}>`, [250, 251]);
      await sendCmd("DATA", [354]);
      const dataPayload = [
        `From: ${envelopeFrom}`,
        `To: ${envelopeTo}`,
        `Subject: ${sanitizeHeaderValue(mail.subject)}`,
        `Message-ID: <${mail.id}@${ehloDomain}>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        dotStuffBody(mail.text),
        ".",
      ].join("\r\n");
      const dataReply = await sendCmd(dataPayload, [250]);
      try {
        await sendCmd("QUIT", [221]);
      } catch {
        // Ignore QUIT close errors after 250 DATA acceptance
      }
      const idToken = dataReply.lines.at(-1)?.split(/\s+/).at(-1) || mail.id;
      return { providerMessageId: idToken.slice(0, 128) };
    } finally {
      if (!socket.destroyed) socket.end();
    }
  }
}

type OutboxWorkRow = {
  id: string;
  user_id: string;
  purpose: "verify_email" | "reset_password";
  locale: Locale;
  encrypted_payload: Buffer;
  attempts_used: number;
  email: string | null;
  user_status: string;
  email_verified_at: Date | null;
  token_user_id: string;
  token_purpose: string;
  consumed_at: Date | null;
  expires_at: Date;
};

function isStillEligible(row: OutboxWorkRow, now: Date): boolean {
  return (
    Boolean(row.email) &&
    row.token_user_id === row.user_id &&
    row.token_purpose === row.purpose &&
    !row.consumed_at &&
    row.expires_at > now &&
    ["pending", "active"].includes(row.user_status) &&
    (row.purpose !== "verify_email" || !row.email_verified_at)
  );
}

/**
 * Coordinates transactional delivery of queued `auth_mail_outbox` verification/reset messages via
 * real `MailTransport` providers (Resend or SMTP), recording immutable attempts and scrubbing payloads
 * immediately on terminal sent/failed/cancelled state so single-use URLs never linger.
 */
export class TransactionalMailWorker {
  private readonly from: string;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;

  constructor(
    readonly auth: AuthService,
    readonly transport: MailTransport,
    options: { from: string; maxAttempts?: number; baseBackoffMs?: number },
  ) {
    if (!options.from) throw new Error("mail_worker_from_required");
    this.from = options.from;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
  }

  private async markOutboxCancelled(c: Transaction, mailId: string, now: Date) {
    await c.query(
      "UPDATE auth_mail_outbox SET status='cancelled',offline_closed_at=$2,encrypted_payload=''::bytea WHERE id=$1",
      [mailId, now],
    );
    await c.query(
      "UPDATE outbox SET processed_at=coalesce(processed_at,$2) WHERE event_key=$1 AND kind='auth.mail_queued'",
      [`auth-mail:${mailId}`, now],
    );
  }

  async deliverNext(): Promise<{
    id: string;
    status: "sent" | "retryable" | "failed" | "cancelled";
    provider?: string;
    attemptNumber?: number;
    errorCode?: string;
  } | null> {
    const claimed = await transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      const candidate = (
        await c.query<OutboxWorkRow>(
          `SELECT m.id, m.user_id, m.purpose, m.locale, m.encrypted_payload,
                  u.email, u.status AS user_status, u.email_verified_at,
                  t.user_id AS token_user_id, t.purpose AS token_purpose, t.consumed_at, t.expires_at,
                  (SELECT count(*)::int FROM auth_mail_delivery_attempts a WHERE a.mail_id = m.id) AS attempts_used
           FROM auth_mail_outbox m
           JOIN users u ON u.id = m.user_id
           JOIN auth_tokens t ON t.id = m.token_id
           WHERE m.status IN ('queued_offline','ready_offline')
             AND NOT EXISTS (
               SELECT 1 FROM auth_mail_delivery_attempts s
               WHERE s.mail_id = m.id AND s.status IN ('sent','failed')
             )
             AND coalesce((
               SELECT a.next_retry_at FROM auth_mail_delivery_attempts a
               WHERE a.mail_id = m.id ORDER BY a.attempt_number DESC LIMIT 1
             ), m.created_at) <= $1
           ORDER BY m.created_at ASC, m.id ASC
           LIMIT 1 FOR UPDATE OF m SKIP LOCKED`,
          [now],
        )
      ).rows[0];

      if (!candidate) return null;
      if (
        !isStillEligible(candidate, now) ||
        candidate.attempts_used >= this.maxAttempts ||
        !candidate.encrypted_payload.length
      ) {
        await this.markOutboxCancelled(c, candidate.id, now);
        return { kind: "cancelled" as const, id: candidate.id };
      }

      const payload = this.auth.crypto.open<{
        to: string;
        subject: string;
        text: string;
        link: string;
        expires_at: string;
      }>(candidate.encrypted_payload, `auth.mail:${candidate.id}`);

      if (payload.to !== candidate.email || payload.expires_at !== candidate.expires_at.toISOString()) {
        await this.markOutboxCancelled(c, candidate.id, now);
        return { kind: "cancelled" as const, id: candidate.id };
      }

      return {
        kind: "send" as const,
        mail: {
          id: candidate.id,
          to: payload.to,
          from: this.from,
          subject: payload.subject,
          text: payload.text,
          locale: candidate.locale,
          purpose: candidate.purpose,
        } satisfies OutboundMail,
        attemptNumber: candidate.attempts_used + 1,
      };
    });

    if (!claimed) return null;
    if (claimed.kind === "cancelled") {
      return { id: claimed.id, status: "cancelled" };
    }

    try {
      const sent = await this.transport.send(claimed.mail);
      await transaction(this.auth.db, async (c) => {
        const now = await this.auth.now(c);
        await c.query(
          `INSERT INTO auth_mail_delivery_attempts(
             mail_id, provider, status, attempt_number, provider_message_id, created_at
           ) VALUES($1,$2,'sent',$3,$4,$5)`,
          [claimed.mail.id, this.transport.provider, claimed.attemptNumber, sent.providerMessageId, now],
        );
        await c.query(
          "UPDATE auth_mail_outbox SET status='ready_offline',offline_ready_at=coalesce(offline_ready_at,$2),encrypted_payload=''::bytea WHERE id=$1",
          [claimed.mail.id, now],
        );
        await c.query(
          "UPDATE outbox SET processed_at=coalesce(processed_at,$2) WHERE event_key=$1 AND kind='auth.mail_queued'",
          [`auth-mail:${claimed.mail.id}`, now],
        );
      });
      return {
        id: claimed.mail.id,
        status: "sent",
        provider: this.transport.provider,
        attemptNumber: claimed.attemptNumber,
      };
    } catch (error) {
      const deliveryErr =
        error instanceof MailDeliveryError
          ? error
          : new MailDeliveryError("mail_unknown_error", true, "Unexpected mail transport error.");
      const retryable = deliveryErr.retryable && claimed.attemptNumber < this.maxAttempts;
      await transaction(this.auth.db, async (c) => {
        const now = await this.auth.now(c);
        const backoffMs = this.baseBackoffMs * 2 ** (claimed.attemptNumber - 1);
        const nextRetryAt = retryable ? new Date(now.getTime() + backoffMs) : null;
        await c.query(
          `INSERT INTO auth_mail_delivery_attempts(
             mail_id, provider, status, attempt_number, error_code, next_retry_at, created_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            claimed.mail.id,
            this.transport.provider,
            retryable ? "retryable" : "failed",
            claimed.attemptNumber,
            deliveryErr.code,
            nextRetryAt,
            now,
          ],
        );
        if (!retryable) {
          await this.markOutboxCancelled(c, claimed.mail.id, now);
        }
      });
      return {
        id: claimed.mail.id,
        status: retryable ? "retryable" : "failed",
        provider: this.transport.provider,
        attemptNumber: claimed.attemptNumber,
        errorCode: deliveryErr.code,
      };
    }
  }
}
