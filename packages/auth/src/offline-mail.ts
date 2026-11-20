import { type Transaction, transaction } from "@soldbench/db";
import type { Locale } from "@soldbench/shared";
import type { AuthService } from "./service.ts";

type MailPurpose = "verify_email" | "reset_password";
type MailStatus = "queued_offline" | "ready_offline" | "cancelled";
type MailRow = {
  id: string;
  user_id: string;
  purpose: MailPurpose;
  locale: Locale;
  status: MailStatus;
  encrypted_payload: Buffer;
  consumed_at: Date | null;
  expires_at: Date;
  token_user_id: string;
  token_purpose: string;
};
type Recipient = { email: string | null; status: string; email_verified_at: Date | null };
type LocalMessage = { to: string; subject: string; text: string; link: string; expires_at: string };
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function eligible(row: MailRow, user: Recipient, now: Date) {
  return (
    !!user.email &&
    row.token_user_id === row.user_id &&
    row.token_purpose === row.purpose &&
    !row.consumed_at &&
    row.expires_at > now &&
    ["pending", "active"].includes(user.status) &&
    (row.purpose !== "verify_email" || !user.email_verified_at)
  );
}

async function lockedMail(c: Transaction, id: string) {
  const { rows } = await c.query<MailRow>(
    `SELECT m.*,t.consumed_at,t.expires_at,t.user_id AS token_user_id,t.purpose AS token_purpose
     FROM auth_mail_outbox m JOIN auth_tokens t ON t.id=m.token_id WHERE m.id=$1 FOR SHARE OF t FOR UPDATE OF m`,
    [id],
  );
  return rows[0];
}

/** Database-backed delivery rehearsal. This class has no network transport. */
export class OfflineMailQueue {
  constructor(readonly auth: AuthService) {}

  async workOnce() {
    return transaction(this.auth.db, async (c) => {
      const now = await this.auth.now(c);
      const { rows } = await c.query<Recipient & { message_id: string }>(
        `SELECT m.id AS message_id,u.email,u.status,u.email_verified_at
         FROM auth_mail_outbox m JOIN users u ON u.id=m.user_id JOIN auth_tokens t ON t.id=m.token_id
         WHERE m.status='queued_offline' OR (m.status='ready_offline' AND
           (t.expires_at<=$1 OR t.consumed_at IS NOT NULL OR t.user_id<>m.user_id OR t.purpose<>m.purpose
             OR u.email IS NULL OR u.status NOT IN ('pending','active')
             OR (m.purpose='verify_email' AND u.email_verified_at IS NOT NULL)))
         ORDER BY m.created_at,m.id LIMIT 1 FOR UPDATE OF u SKIP LOCKED`,
        [now],
      );
      const user = rows[0];
      if (!user) return null;
      const row = await lockedMail(c, user.message_id);
      if (!row || row.status === "cancelled") return null;
      const usable = eligible(row, user, now);
      if (usable && row.status === "ready_offline") return null;
      if (usable) {
        await c.query("UPDATE auth_mail_outbox SET status='ready_offline',offline_ready_at=$2 WHERE id=$1", [
          row.id,
          now,
        ]);
      } else {
        await c.query(
          "UPDATE auth_mail_outbox SET status='cancelled',offline_closed_at=$2,encrypted_payload=''::bytea WHERE id=$1",
          [row.id, now],
        );
      }
      await c.query(
        "UPDATE outbox SET processed_at=coalesce(processed_at,$2) WHERE event_key=$1 AND kind='auth.mail_queued'",
        [`auth-mail:${row.id}`, now],
      );
      return {
        id: row.id,
        purpose: row.purpose,
        locale: row.locale,
        state: usable ? "ready_offline" : "cancelled",
      };
    });
  }

  async list() {
    const now = await this.auth.now();
    return (
      await this.auth.db.query(
        `SELECT m.id,m.purpose,m.locale,m.offline_ready_at FROM auth_mail_outbox m
       JOIN auth_tokens t ON (t.id,t.user_id,t.purpose)=(m.token_id,m.user_id,m.purpose) JOIN users u ON u.id=m.user_id
       WHERE m.status='ready_offline' AND t.consumed_at IS NULL AND t.expires_at>$1 AND u.email IS NOT NULL
         AND u.status IN ('pending','active') AND (m.purpose<>'verify_email' OR u.email_verified_at IS NULL)
       ORDER BY m.offline_ready_at DESC,m.id LIMIT 20`,
        [now],
      )
    ).rows;
  }

  async preview(id: string) {
    if (!idPattern.test(id)) throw new Error("invalid_offline_mail_id");
    return transaction(this.auth.db, async (c) => {
      const { rows } = await c.query<Recipient>(
        `SELECT u.email,u.status,u.email_verified_at FROM users u JOIN auth_mail_outbox m ON m.user_id=u.id
         WHERE m.id=$1 AND m.status='ready_offline' FOR SHARE OF u`,
        [id],
      );
      const user = rows[0];
      if (!user) throw new Error("offline_mail_unavailable");
      const row = await lockedMail(c, id);
      if (row?.status !== "ready_offline" || !eligible(row, user, await this.auth.now(c)))
        throw new Error("offline_mail_unavailable");
      const message = this.auth.crypto.open<LocalMessage>(row.encrypted_payload, `auth.mail:${id}`);
      if (message.to !== user.email || message.expires_at !== row.expires_at.toISOString())
        throw new Error("offline_mail_metadata_changed");
      return { ...message, purpose: row.purpose, locale: row.locale, offline: true as const };
    });
  }
}
