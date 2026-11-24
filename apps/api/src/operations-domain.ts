import { randomUUID } from "node:crypto";
import type { Identity } from "@soldbench/auth";
import type { PaymentLifecycle } from "@soldbench/billing";
import { CollectorStore } from "@soldbench/collector";
import { type Transaction, transaction } from "@soldbench/db";
import type { QueryService } from "@soldbench/query";
import { AppError, isSourceAllowedForMode, sqlSourceKindClause } from "@soldbench/shared";
import { type AlertSettings, type TelemetryInput, type TelemetryView, telemetry } from "./ops-telemetry.ts";
import { publishContentRevision, requiresPolicyRelease, type SiteContentCommand } from "./site-content.ts";

const fail = (code: string, status: number, message: string): never => {
  throw new AppError(code, status, message);
};
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const safeCode = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : null;
const timeSql = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at`;
type Page = { size: number; cursor?: string };
type CursorRow = { id: string; cursor_at: string };
type SourceCommand = {
  command: "suspend" | "probe" | "revoke";
  reason: string;
  evidence_ref: string;
  version: number;
};
type SupportCommand = { reason: string; version: number } & (
  | { command: "claim" | "reopen" | "take_over"; due_at: string }
  | { command: "resolve"; reply: string }
  | { command: "close" }
);
type ApprovalAction = "suspend" | "restore";
type ApprovalTransition = "approve" | "reject" | "execute" | "cancel";
type IncidentUpdate =
  | { component: string; title: string; reason: string }
  | { state: "open" | "monitoring" | "resolved"; version: number; reason: string };

export class OperationsService {
  readonly collector: CollectorStore;
  constructor(
    readonly service: QueryService,
    readonly payments?: PaymentLifecycle,
  ) {
    this.collector = new CollectorStore(service.db, service.clock, { dataMode: service.dataMode });
  }
  private get crypto() {
    return this.service.auth.crypto;
  }
  private async role(c: Transaction, actor: Identity, admin: boolean, now: Date) {
    if (!actor.sessionId || actor.keyId) fail("forbidden", 403, "An operator session is required.");
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.userId]);
    const role = (await c.query("SELECT role FROM admin_roles WHERE user_id=$1 FOR SHARE", [actor.userId]))
      .rows[0]?.role;
    if ((role !== "admin" && role !== "support") || (admin && role !== "admin"))
      fail("forbidden", 403, "Operator permission is required.");
    await this.service.auth.assertIdentityLocked(c, actor, "usage:read", now, true);
    return role as "admin" | "support";
  }
  private commandKey(key: string | undefined) {
    if (!key || !/^[\x21-\x7e]{16,128}$/.test(key))
      return fail("invalid_parameter", 400, "A valid Idempotency-Key is required.");
    return this.crypto.hash("ops.idempotency", key);
  }
  private async previous(c: Transaction, owner: string, operation: string, key: string, shape: string) {
    const row = (
      await c.query(
        "SELECT request_hash,resource_id FROM idempotency_records WHERE owner_scope=$1 AND operation=$2 AND key_hash=$3",
        [owner, operation, key],
      )
    ).rows[0];
    if (row && row.request_hash !== shape)
      fail("idempotency_conflict", 409, "This key was used for a different operation.");
    return row?.resource_id as string | undefined;
  }
  private async record(
    c: Transaction,
    actor: string,
    operation: string,
    objectType: string,
    id: string,
    key: string,
    shape: string,
    reason: string,
    requestId: string,
    now: Date,
    diff: object = {},
  ) {
    const auditId = randomUUID();
    await c.query(
      "INSERT INTO audit_events(id,actor_id,action,object_type,object_id,reason,request_id,safe_diff,created_at) VALUES($1,$2,$3,$4,$5,'operator_reason_recorded',$6,$7,$8)",
      [
        auditId,
        actor,
        operation,
        objectType,
        id,
        requestId,
        { ...diff, reason_hash: this.crypto.hash("ops.reason", reason) },
        now,
      ],
    );
    await c.query(
      "INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at) VALUES($1,$2,$3,$4,$5,'committed',$6)",
      [actor, operation, key, shape, auditId, new Date(now.getTime() + 7 * 86400000)],
    );
    return auditId;
  }
  private commandView(id: string, probe?: string) {
    const valid = probe === "ready_for_offline_probe" || probe === "blocked";
    return {
      command_id: id,
      status: "completed" as const,
      audit_id: id,
      ...(valid ? { probe_status: probe } : {}),
    };
  }

  async recovery(actor: Identity, paging: Page) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, true, await this.service.now(c));
      const cursor = this.service.readCursor(actor.userId, "ops.recovery", paging.cursor);
      const rows = this.payments
        ? (
            await c.query(
              `SELECT id,provider,fixture_attempts,received_at,${timeSql("received_at")}
               FROM payment_events WHERE fixture_envelope IS NOT NULL AND status='failed'
               AND fixture_error='confirmation_pending' AND fixture_attempts>=12
               AND ($1::timestamptz IS NULL OR (received_at,id)<($1::timestamptz,$2::uuid))
               ORDER BY received_at DESC,id DESC LIMIT $3`,
              [cursor?.time ?? null, cursor?.id ?? null, paging.size + 1],
            )
          ).rows
        : [];
      return {
        payment_fixtures_enabled: Boolean(this.payments),
        ...this.page(rows, actor, "ops.recovery", paging.size, (row) => ({
          id: row.id,
          provider: row.provider,
          attempts: row.fixture_attempts,
          received_at: iso(row.received_at),
        })),
      };
    });
  }

  async replayPayment(
    actor: Identity,
    eventId: string,
    input: { reason: string; case_reference: string },
    rawKey: string | undefined,
    requestId: string,
  ) {
    const payment = this.payments;
    if (!payment) return fail("service_unavailable", 503, "Offline payments are disabled.");
    const key = this.commandKey(rawKey),
      op = "ops.payment_replay";
    const shape = this.crypto.hash("ops.payment_replay_input", JSON.stringify([eventId, input]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      // The payment worker takes the receipt lock before locking its transaction owner.
      await c.query("SELECT id FROM payment_events WHERE id=$1 FOR UPDATE", [eventId]);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) {
        const diff = (await c.query("SELECT safe_diff FROM audit_events WHERE id=$1", [prior])).rows[0]
          .safe_diff;
        return { ...this.commandView(prior), outcome: diff.outcome };
      }
      const result = await payment.replayLateConfirmation(c, eventId, now);
      const audit = await this.record(
        c,
        actor.userId,
        op,
        "payment_event",
        eventId,
        key,
        shape,
        input.reason,
        requestId,
        now,
        {
          ...result,
          prior_status: result.outcome === "already_applied" ? "applied" : "failed",
          prior_error: result.outcome === "already_applied" ? null : "confirmation_pending",
          evidence_type: "offline_fixture_confirmation",
          case_hash: this.crypto.hash("ops.payment_case", input.case_reference),
        },
      );
      return { ...this.commandView(audit), outcome: result.outcome };
    });
  }

  async contentList(actor: Identity) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, true, await this.service.now(c));
      return (
        await c.query(
          `SELECT e.id,e.kind,e.slug,e.version,e.latest_revision,e.published_revision,v.state,v.body,v.metadata,
                CASE WHEN s.entry_id IS NOT NULL THEN jsonb_build_object('revision',s.revision,'execute_at',s.execute_at,
                  'status',s.status,'failure_code',s.failure_code) END AS schedule,
                (SELECT coalesce(jsonb_agg(r.revision ORDER BY r.revision DESC),'[]') FROM site_content_revisions r
                 WHERE r.entry_id=e.id AND r.first_published_at IS NOT NULL) AS publication_history
           FROM site_content_entries e JOIN site_content_revisions v ON (v.entry_id,v.revision)=(e.id,e.latest_revision)
           LEFT JOIN site_content_schedules s ON s.entry_id=e.id
          ORDER BY e.updated_at DESC,e.id LIMIT 100`,
        )
      ).rows;
    });
  }

  async contentCommand(
    actor: Identity,
    input: SiteContentCommand,
    rawKey: string | undefined,
    requestId: string,
  ) {
    const key = this.commandKey(rawKey);
    const op = `ops.content.${input.command}`;
    const shape = this.crypto.hash("ops.content_input", JSON.stringify(input));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) return this.commandView(prior);
      if (input.command === "draft") {
        await c.query(
          "INSERT INTO site_content_entries(kind,slug,updated_at) VALUES($1,$2,$3) ON CONFLICT(kind,slug) DO NOTHING",
          [input.kind, input.slug, now],
        );
      }
      const entry = (
        input.command === "draft"
          ? await c.query("SELECT * FROM site_content_entries WHERE kind=$1 AND slug=$2 FOR UPDATE", [
              input.kind,
              input.slug,
            ])
          : await c.query("SELECT * FROM site_content_entries WHERE id=$1 FOR UPDATE", [input.entry_id])
      ).rows[0];
      if (!entry) fail("not_found", 404, "Content entry not found.");
      if (entry.version !== input.version) fail("state_conflict", 409, "Content version changed.");
      let revision = entry.latest_revision ?? 0;
      let scheduleTime: Date | undefined;
      if (input.command === "draft") {
        revision += 1;
        await c.query(
          "INSERT INTO site_content_revisions(entry_id,revision,body,author_id,created_at,metadata) VALUES($1,$2,$3,$4,$5,$6)",
          [entry.id, revision, input.body, actor.userId, now, input.metadata ?? {}],
        );
        await c.query("UPDATE site_content_entries SET latest_revision=$2 WHERE id=$1", [entry.id, revision]);
      } else {
        revision = input.revision;
        const current = (
          await c.query("SELECT * FROM site_content_revisions WHERE entry_id=$1 AND revision=$2 FOR UPDATE", [
            entry.id,
            revision,
          ])
        ).rows[0];
        if (!current) fail("not_found", 404, "Content revision not found.");
        if (
          ["submit", "approve", "publish", "schedule"].includes(input.command) &&
          revision !== entry.latest_revision
        )
          fail("state_conflict", 409, "Only the latest revision can move through review.");
        if (["publish", "rollback", "schedule"].includes(input.command)) {
          if (requiresPolicyRelease(entry.kind))
            fail("forbidden", 403, "Legal publication requires a separate release approval.");
          if (current.state === "approved" && current.reviewer_id) {
            const reviewer = await c.query(
              `SELECT 1 FROM users u JOIN admin_roles r ON r.user_id=u.id AND r.role='admin'
                JOIN user_mfa m ON m.user_id=u.id AND m.state='enabled' WHERE u.id=$1 AND u.status='active'`,
              [current.reviewer_id],
            );
            if (!reviewer.rowCount) fail("forbidden", 403, "The reviewer's access has changed.");
          }
        }
        switch (input.command) {
          case "submit":
            if (current.state !== "draft") fail("state_conflict", 409, "Submit a draft revision.");
            await c.query(
              "UPDATE site_content_revisions SET state='submitted' WHERE entry_id=$1 AND revision=$2",
              [entry.id, revision],
            );
            break;
          case "approve":
            if (current.state !== "submitted")
              fail("state_conflict", 409, "Submit a revision before review.");
            if (current.author_id === actor.userId)
              fail("forbidden", 403, "A different operator must approve this content.");
            await c.query(
              "UPDATE site_content_revisions SET state='approved',reviewer_id=$3 WHERE entry_id=$1 AND revision=$2",
              [entry.id, revision, actor.userId],
            );
            break;
          case "publish":
          case "rollback":
            if (
              current.state !== "approved" ||
              !current.reviewer_id ||
              (input.command === "rollback" && !current.first_published_at)
            )
              fail("state_conflict", 409, "An approved revision is required.");
            await publishContentRevision(c, entry.id, revision, now);
            break;
          case "schedule": {
            scheduleTime = new Date(input.execute_at);
            if (!Number.isFinite(scheduleTime.getTime()) || scheduleTime <= now)
              fail("invalid_parameter", 400, "Choose a future UTC publication time.");
            if (current.state !== "approved" || !current.reviewer_id || entry.published_revision === revision)
              fail("state_conflict", 409, "Only an approved inactive revision can be scheduled.");
            const queued = await c.query(
              `INSERT INTO site_content_schedules(entry_id,revision,entry_version,scheduled_by,execute_at)
               VALUES($1,$2,$3,$4,$5) ON CONFLICT(entry_id) DO UPDATE SET id=excluded.id,revision=excluded.revision,
               entry_version=excluded.entry_version,scheduled_by=excluded.scheduled_by,execute_at=excluded.execute_at,
               status='pending',finished_at=NULL,failure_code=NULL WHERE site_content_schedules.status<>'pending'`,
              [entry.id, revision, entry.version + 1, actor.userId, scheduleTime],
            );
            if (!queued.rowCount) fail("state_conflict", 409, "Cancel the current schedule first.");
            break;
          }
          case "cancel_schedule": {
            const cancelled = await c.query(
              "UPDATE site_content_schedules SET status='cancelled',finished_at=$3 WHERE entry_id=$1 AND revision=$2 AND status='pending'",
              [entry.id, revision, now],
            );
            if (!cancelled.rowCount) fail("state_conflict", 409, "No matching pending publication schedule.");
            break;
          }
          case "unpublish":
            if (entry.published_revision !== revision)
              fail("state_conflict", 409, "Only the active revision can be unpublished.");
            await c.query(
              "UPDATE site_content_entries SET published_revision=NULL,published_at=NULL WHERE id=$1",
              [entry.id],
            );
            break;
        }
      }
      await c.query("UPDATE site_content_entries SET version=version+1,updated_at=$2 WHERE id=$1", [
        entry.id,
        now,
      ]);
      return this.commandView(
        await this.record(
          c,
          actor.userId,
          op,
          "site_content",
          entry.id,
          key,
          shape,
          input.reason,
          requestId,
          now,
          {
            revision,
            version: entry.version + 1,
            ...(scheduleTime ? { execute_at: scheduleTime.toISOString() } : {}),
          },
        ),
      );
    });
  }

  async support(
    actor: Identity | undefined,
    peer: string,
    input: { category: string; message: string; request_id?: string },
    rawKey?: string,
    receipt?: string,
  ) {
    const key = this.commandKey(rawKey),
      receiptHash = receipt ? this.crypto.hash("ops.support.receipt", receipt) : null,
      fingerprint = this.crypto.hash(
        "ops.support_input",
        JSON.stringify(receiptHash ? [input, receiptHash] : input),
      );
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c),
        start = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
      if (actor) await this.service.auth.assertIdentityLocked(c, actor, "usage:read", now, false, true);
      const scope = actor?.userId ?? this.crypto.hash("ops.support_anon", peer);
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
        "support-idempotency",
        scope,
      ]);
      const existing = await this.previous(c, scope, "support.submit", key, fingerprint);
      if (existing) {
        if (
          !(
            await c.query("SELECT 1 FROM support_requests WHERE id=$1 AND retention_until>$2", [
              existing,
              now,
            ])
          ).rowCount
        )
          fail("not_found", 404, "The prior support request is unavailable.");
        return existing;
      }
      const gated = this.crypto.hash("ops.support_ip", peer);
      // Serializes network intake even when the same address sends distinct keys.
      const allowed = await c.query(
        "INSERT INTO auth_rate_windows(bucket_hash,window_start,used) VALUES($1,$2,1) ON CONFLICT(bucket_hash,window_start) DO UPDATE SET used=auth_rate_windows.used+1 WHERE auth_rate_windows.used<8 RETURNING used",
        [gated, start],
      );
      if (!allowed.rowCount)
        throw new AppError("rate_limited", 429, "Too many support submissions.", {
          retry_after: Math.max(1, Math.ceil((start.getTime() + 3600000 - now.getTime()) / 1000)),
        });
      const id = randomUUID(),
        expires = new Date(now.getTime() + 30 * 86400000);
      const created = await c.query(
        `INSERT INTO support_requests(id,user_id,category,message,request_ref,retention_until,created_at,receipt_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(receipt_hash) WHERE receipt_hash IS NOT NULL DO NOTHING`,
        [
          id,
          actor?.userId ?? null,
          input.category,
          input.message,
          input.request_id ?? null,
          expires,
          now,
          receiptHash,
        ],
      );
      if (!created.rowCount)
        return fail("state_conflict", 409, "This receipt cannot be used for a new request.");
      await c.query(
        "INSERT INTO idempotency_records(owner_scope,operation,key_hash,request_hash,resource_id,status,expires_at) VALUES($1,'support.submit',$2,$3,$4,'committed',$5)",
        [scope, key, fingerprint, id, expires],
      );
      return id;
    });
  }

  async supportReceipt(receipt: string) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      const row = (
        await c.query(
          "SELECT id,status,reply,updated_at,created_at,retention_until FROM support_requests WHERE receipt_hash=$1 AND retention_until>$2",
          [this.crypto.hash("ops.support.receipt", receipt), now],
        )
      ).rows[0];
      if (!row) return fail("not_found", 404, "Support receipt not found.");
      return {
        request_id: row.id,
        status: row.status,
        reply: row.reply,
        updated_at: iso(row.updated_at ?? row.created_at),
        expires_at: iso(row.retention_until),
      };
    });
  }

  async supportQueue(actor: Identity, paging: Page) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, false, now);
      const cursor = this.service.readCursor(actor.userId, "ops.support_queue", paging.cursor);
      const rows = (
        await c.query(
          `SELECT q.id,q.category,q.status,q.version,q.assignee_id,q.due_at,q.created_at,${timeSql("q.created_at")},
                  NOT EXISTS (SELECT 1 FROM users u JOIN admin_roles a ON a.user_id=u.id AND a.role='admin'
                    JOIN user_mfa m ON m.user_id=u.id AND m.state='enabled' WHERE u.id=q.assignee_id AND u.status='active') AS assignee_unavailable
             FROM support_requests q WHERE q.retention_until>$1
              AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
             ORDER BY created_at DESC,id DESC LIMIT $4`,
          [now, cursor?.time ?? null, cursor?.id ?? null, paging.size + 1],
        )
      ).rows;
      return this.page(rows, actor, "ops.support_queue", paging.size, (row) => ({
        id: row.id,
        category: ["data_quality", "takedown", "billing", "account"].includes(row.category)
          ? row.category
          : "other",
        status: row.status,
        version: row.version,
        assigned_to_you: row.assignee_id === actor.userId,
        can_take_over: row.status === "in_progress" && row.assignee_unavailable,
        assignee_ref: row.assignee_id ? this.crypto.hash("ops.owner", row.assignee_id).slice(0, 20) : null,
        due_at: iso(row.due_at),
        created_at: iso(row.created_at),
      }));
    });
  }

  async supportDetail(actor: Identity, id: string, requestId: string) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, true, now);
      const row = (
        await c.query(
          "SELECT message,request_ref,reply FROM support_requests WHERE id=$1 AND assignee_id=$2 AND retention_until>$3 FOR SHARE",
          [id, actor.userId, now],
        )
      ).rows[0];
      if (!row) return fail("not_found", 404, "Assigned support request not found.");
      await c.query(
        `INSERT INTO audit_events(actor_id,action,object_type,object_id,reason,request_id,created_at)
         VALUES($1,'ops.support.read','support_request',$2,'assigned_support_investigation',$3,$4)`,
        [actor.userId, id, requestId, now],
      );
      return { message: row.message, related_request_id: row.request_ref, reply: row.reply };
    });
  }

  async supportCommand(
    actor: Identity,
    id: string,
    input: SupportCommand,
    rawKey: string | undefined,
    requestId: string,
  ) {
    const key = this.commandKey(rawKey),
      op = `ops.support.${input.command}`;
    const shape = this.crypto.hash("ops.support.case", JSON.stringify([id, input]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) return this.commandView(prior);
      const ticket = (
        await c.query("SELECT * FROM support_requests WHERE id=$1 AND retention_until>$2 FOR UPDATE", [
          id,
          now,
        ])
      ).rows[0];
      if (!ticket) return fail("not_found", 404, "Support request not found.");
      if (ticket.version !== input.version)
        return fail("state_conflict", 409, "Support request version changed.");
      if (input.command === "take_over") {
        const current = await c.query(
          `SELECT 1 FROM users u JOIN admin_roles a ON a.user_id=u.id AND a.role='admin'
             JOIN user_mfa m ON m.user_id=u.id AND m.state='enabled' WHERE u.id=$1 AND u.status='active'`,
          [ticket.assignee_id],
        );
        if (current.rowCount) return fail("state_conflict", 409, "The assigned operator is still active.");
      } else if (input.command !== "claim" && ticket.assignee_id !== actor.userId)
        return fail("forbidden", 403, "Use the assigned operator session.");
      const expected = {
        claim: "received",
        resolve: "in_progress",
        close: "resolved",
        reopen: "closed",
        take_over: "in_progress",
      };
      const next = {
        claim: "in_progress",
        resolve: "resolved",
        close: "closed",
        reopen: "in_progress",
        take_over: "in_progress",
      };
      if (ticket.status !== expected[input.command])
        return fail("state_conflict", 409, "This support transition is unavailable.");
      const due = "due_at" in input ? new Date(input.due_at) : ticket.due_at;
      if (
        "due_at" in input &&
        (!Number.isFinite(due.getTime()) || due <= now || due >= ticket.retention_until)
      )
        return fail("invalid_parameter", 400, "Use a future deadline within the request retention window.");
      const reply = input.command === "resolve" ? input.reply : ticket.reply;
      await c.query(
        `UPDATE support_requests SET status=$2,assignee_id=$3,due_at=$4,reply=$5,version=version+1,updated_at=$6
         WHERE id=$1`,
        [id, next[input.command], actor.userId, due, reply, now],
      );
      return this.commandView(
        await this.record(
          c,
          actor.userId,
          op,
          "support_request",
          id,
          key,
          shape,
          input.reason,
          requestId,
          now,
          { state: next[input.command], version: ticket.version + 1 },
        ),
      );
    });
  }

  async status() {
    const row = (
      await this.service.db.query(
        "SELECT EXISTS(SELECT 1 FROM collector_circuits WHERE status<>'closed') AS collector_paused",
      )
    ).rows[0];
    return {
      service: "available",
      data_mode: this.service.dataMode,
      collector: row.collector_paused
        ? "paused"
        : this.service.dataMode === "approved_network"
          ? "approved_network"
          : "offline_only",
      payments: this.payments?.liveOptions ? this.payments.liveOptions.environment : "offline",
    };
  }
  async sources(actor: Identity) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, true, now);
      const rows = (
        await c.query(
          `SELECT s.id,s.marketplace,s.source_clearance_id,CASE WHEN s.status='revoked' THEN 'revoked' ELSE x.status END status,x.expires_at,s.permission_epoch,s.ops_version,coalesce(k.status,'closed') circuit_status,(SELECT max(j.min_page_as_of) FROM collector_jobs j WHERE j.source_id=s.id AND j.status='completed') last_data_as_of FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id LEFT JOIN collector_circuits k ON k.source_id=s.id AND k.category_key='*' WHERE ${sqlSourceKindClause(this.service.dataMode)} ORDER BY s.id LIMIT 100`,
        )
      ).rows;
      return rows.map((r) => ({
        source_id: r.id,
        marketplace: r.marketplace,
        clearance_status: r.status,
        clearance_ref: this.crypto.hash("ops.clearance", r.source_clearance_id).slice(0, 20),
        expires_at: iso(r.expires_at),
        permission_epoch: Number(r.permission_epoch),
        circuit_status: r.circuit_status,
        last_data_as_of: iso(r.last_data_as_of),
        version: r.ops_version,
      }));
    });
  }
  async sourceCommand(
    actor: Identity,
    id: string,
    input: SourceCommand,
    rawKey: string | undefined,
    requestId: string,
  ) {
    const key = this.commandKey(rawKey),
      op = "ops.source",
      shape = this.crypto.hash("ops.command", JSON.stringify([id, input]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) {
        const original = (
          await c.query("SELECT safe_diff->>'probe_status' probe_status FROM audit_events WHERE id=$1", [
            prior,
          ])
        ).rows[0];
        return this.commandView(prior, original?.probe_status);
      }
      const source = (
        await c.query(
          `SELECT s.id,s.status,s.access_method,s.ops_version,x.provider,x.status clearance_status,x.effective_at,x.expires_at FROM sources s JOIN source_clearances x ON x.id=s.source_clearance_id WHERE s.id=$1 AND ${sqlSourceKindClause(this.service.dataMode)} FOR UPDATE OF s FOR SHARE OF x`,
          [id],
        )
      ).rows[0];
      if (!source) return fail("not_found", 404, "Source not found.");
      if (source.ops_version !== input.version || source.status === "revoked")
        fail("state_conflict", 409, "Refresh the source before issuing another operation.");
      let probeStatus: string | undefined;
      if (input.command === "probe") {
        const allowed =
          source.status === "active" &&
          isSourceAllowedForMode(this.service.dataMode, source) &&
          (!source.effective_at || source.effective_at <= now) &&
          (!source.expires_at || source.expires_at > now);
        const configAccessFilter =
          this.service.dataMode === "offline_fixture"
            ? "access_method='offline_fixture'"
            : "access_method IN ('approved_http','approved_browser')";
        const policy = (
          await c.query(
            `SELECT EXISTS(SELECT 1 FROM collector_daily_budget_policies p JOIN sources s ON s.id=p.source_id AND s.daily_budget_policy_hash=p.policy_hash WHERE s.id=$1 AND p.valid_from<=$2 AND p.valid_until>$2) AS budget, EXISTS(SELECT 1 FROM collector_configs WHERE source_id=$1 AND enabled AND ${configAccessFilter}) AS configured, EXISTS(SELECT 1 FROM collector_jobs j JOIN source_observations o ON o.collector_run_id=j.collector_run_id WHERE j.source_id=$1 AND j.status='completed' AND o.retention_until>$2) AS evidence`,
            [id, now],
          )
        ).rows[0];
        probeStatus =
          allowed && policy?.budget && policy?.configured && policy?.evidence
            ? "ready_for_offline_probe"
            : "blocked";
      } else {
        const revoke = input.command === "revoke";
        await this.collector.stopLocked(
          c,
          id,
          revoke ? "operator_source_revoked" : "operator_source_suspended",
          revoke,
        );
      }
      if (input.command === "probe")
        await c.query("UPDATE sources SET ops_version=ops_version+1 WHERE id=$1", [id]);
      const audit = await this.record(
        c,
        actor.userId,
        op,
        "source",
        id,
        key,
        shape,
        input.reason,
        requestId,
        now,
        {
          command: input.command,
          evidence_hash: this.crypto.hash("ops.evidence_ref", input.evidence_ref),
          version: input.version + 1,
          probe_status: probeStatus,
        },
      );
      return this.commandView(audit, probeStatus);
    });
  }
  private page<T extends CursorRow, V>(
    rows: T[],
    actor: Identity,
    kind: string,
    size: number,
    project: (r: T) => V,
  ) {
    const last = rows[size - 1];
    return {
      items: rows.slice(0, size).map(project),
      next_cursor: last && rows.length > size ? this.service.makeCursor(actor.userId, kind, last) : null,
    };
  }
  async jobs(actor: Identity, paging: Page) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, false, now);
      const cursor = this.service.readCursor(actor.userId, "ops.jobs", paging.cursor);
      const rows = (
        await c.query(
          `WITH query_page AS (
         SELECT j.id,'query' kind,j.status,qj.source_id,j.error_code,j.attempt_count attempts,j.version,j.updated_at FROM query_jobs j JOIN queries q ON q.id=j.query_id AND q.result_state<>'forbidden' LEFT JOIN collector_jobs qj ON qj.id=q.collector_job_id
          WHERE ($1::timestamptz IS NULL OR (j.updated_at,j.id)<($1::timestamptz,$2::uuid)) ORDER BY j.updated_at DESC,j.id DESC LIMIT $3
        ), collector_page AS (
         SELECT j.id,'collector' kind,j.status,j.source_id,j.error_code,j.attempts,j.version,coalesce(j.finished_at,j.started_at,j.available_at) updated_at FROM collector_jobs j JOIN sources s ON s.id=j.source_id AND ${this.service.dataMode === "offline_fixture" ? "s.access_method='offline_fixture'" : "s.access_method IN ('approved_http','approved_browser')"}
          WHERE ($1::timestamptz IS NULL OR (coalesce(j.finished_at,j.started_at,j.available_at),j.id)<($1::timestamptz,$2::uuid)) ORDER BY updated_at DESC,j.id DESC LIMIT $3
        ) SELECT *,${timeSql("updated_at")} FROM (SELECT * FROM query_page UNION ALL SELECT * FROM collector_page) u ORDER BY updated_at DESC,id DESC LIMIT $3`,
          [cursor?.time ?? null, cursor?.id ?? null, paging.size + 1],
        )
      ).rows;
      return this.page(rows, actor, "ops.jobs", paging.size, (r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        source_id: r.source_id,
        error_code: safeCode(r.error_code),
        attempts: r.attempts,
        version: r.version,
        updated_at: iso(r.updated_at),
      }));
    });
  }
  async retry(
    actor: Identity,
    id: string,
    input: { reason: string; version: number },
    rawKey: string | undefined,
    requestId: string,
  ) {
    const key = this.commandKey(rawKey),
      op = "ops.query_retry",
      shape = this.crypto.hash("ops.command", JSON.stringify([id, input]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      const target = (
        await c.query(
          "SELECT q.user_id,q.id FROM query_jobs j JOIN queries q ON q.id=j.query_id WHERE j.id=$1",
          [id],
        )
      ).rows[0];
      const ids = target ? [...new Set([actor.userId, target.user_id])] : [actor.userId];
      const users = (
        await c.query("SELECT id,status FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids])
      ).rows;
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) return this.commandView(prior);
      if (!target || !users.some((u) => u.id === target.user_id && u.status === "active"))
        return fail("not_found", 404, "Eligible query job not found.");
      const q = (
          await c.query(
            "SELECT compute_status,settlement_status,result_state,expires_at FROM queries WHERE id=$1 FOR UPDATE",
            [target.id],
          )
        ).rows[0],
        j = (
          await c.query(
            "SELECT status,version,attempt_count,error_code,retryable,expires_at,dedupe_key FROM query_jobs WHERE id=$1 AND query_id=$2 FOR UPDATE",
            [id, target.id],
          )
        ).rows[0];
      if (
        !q ||
        !j ||
        j.version !== input.version ||
        j.status !== "failed" ||
        q.compute_status !== "failed" ||
        q.settlement_status !== "pending" ||
        q.result_state !== "absent" ||
        q.expires_at <= now ||
        j.expires_at <= now ||
        j.attempt_count >= 3 ||
        (!j.retryable && j.error_code !== "service_unavailable")
      )
        fail("state_conflict", 409, "This job cannot be retried.");
      await this.service.assertSnapshotRights(c, target.id, now);
      if (
        (
          await c.query("SELECT 1 FROM query_jobs WHERE dedupe_key=$1 AND status IN ('queued','running')", [
            j.dedupe_key,
          ])
        ).rowCount
      )
        fail("state_conflict", 409, "A matching job is already active.");
      const exists = (await c.query("SELECT 1 FROM billing_charges WHERE query_id=$1", [target.id])).rowCount;
      if (exists) fail("state_conflict", 409, "A committed charge cannot be retried.");
      await c.query(
        "UPDATE query_jobs SET status='queued',available_at=$2,lease_owner=NULL,lease_until=NULL,error_code=NULL,retryable=false,updated_at=$2,version=version+1 WHERE id=$1",
        [id, now],
      );
      await c.query("UPDATE queries SET compute_status='queued',version=version+1 WHERE id=$1", [target.id]);
      return this.commandView(
        await this.record(c, actor.userId, op, "query_job", id, key, shape, input.reason, requestId, now, {
          previous_version: input.version,
        }),
      );
    });
  }
  async billing(actor: Identity, paging: Page) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, false, await this.service.now(c));
      const cursor = this.service.readCursor(actor.userId, "ops.billing", paging.cursor);
      const rows = (
        await c.query(
          `WITH requested AS (SELECT id,user_id,query_id,charged_credits,state,created_at FROM billing_charges WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT $3)
        SELECT r.*,${timeSql("r.created_at")},CASE WHEN w.id IS NULL THEN 'unknown' WHEN w.balance=(SELECT coalesce(sum(l.delta),0) FROM credit_ledger l WHERE l.wallet_id=w.id) THEN 'balanced' ELSE 'mismatch' END AS reconciliation
        FROM requested r LEFT JOIN credit_ledger x ON x.charge_id=r.id AND x.kind='consume' LEFT JOIN credit_wallets w ON w.id=x.wallet_id ORDER BY r.created_at DESC,r.id DESC`,
          [cursor?.time ?? null, cursor?.id ?? null, paging.size + 1],
        )
      ).rows;
      return this.page(rows, actor, "ops.billing", paging.size, (r) => ({
        charge_id: r.id,
        query_id: r.query_id,
        user_ref: this.crypto.hash("ops.owner", r.user_id).slice(0, 20),
        credits: r.charged_credits,
        state: r.state,
        reconciliation_status: r.reconciliation,
        created_at: iso(r.created_at),
      }));
    });
  }
  async refund(actor: Identity, id: string, reason: string, rawKey: string | undefined, requestId: string) {
    const key = this.commandKey(rawKey),
      op = "ops.credit_refund",
      shape = this.crypto.hash("ops.command", JSON.stringify([id, reason]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c),
        charge = (await c.query("SELECT user_id,query_id FROM billing_charges WHERE id=$1", [id])).rows[0];
      await c.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
        charge ? [...new Set([actor.userId, charge.user_id])] : [actor.userId],
      ]);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) return this.commandView(prior);
      if (!charge) return fail("not_found", 404, "Charge not found.");
      const reasonRef = this.crypto.hash("ops.reason", reason).slice(0, 20);
      const changed = await this.service.billing.refundCreditLocked(
        c,
        charge.user_id,
        charge.query_id,
        actor.userId,
        `operator_compensation:${reasonRef}`,
      );
      return this.commandView(
        await this.record(c, actor.userId, op, "charge", id, key, shape, reason, requestId, now, {
          credit_refunded: changed,
        }),
      );
    });
  }
  async overview(actor: Identity) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      const role = await this.role(c, actor, false, now);
      const row = (
        await c.query(
          `SELECT (SELECT count(*)::int FROM query_jobs WHERE status IN ('queued','running')) AS active_jobs,
          (SELECT count(*)::int FROM support_requests WHERE status IN ('received','in_progress') AND retention_until>$1) AS open_support,
          (SELECT count(*)::int FROM operator_incidents WHERE state<>'resolved') AS open_incidents,
          (SELECT count(*)::int FROM operator_account_approvals WHERE state IN ('requested','approved')) AS pending_approvals`,
          [now],
        )
      ).rows[0];
      return {
        role,
        as_of: now.toISOString(),
        active_jobs: row.active_jobs,
        open_support: row.open_support,
        open_incidents: row.open_incidents,
        pending_approvals: role === "admin" ? row.pending_approvals : null,
      };
    });
  }
  async report(actor: Identity, view: TelemetryView, filters: TelemetryInput) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, true, now);
      return telemetry(c, now, view, filters, this.service.dataMode);
    });
  }
  async alertSettings(
    actor: Identity,
    input: AlertSettings & { reason: string },
    rawKey: string | undefined,
    requestId: string,
  ) {
    const op = "ops.alert_settings.update",
      key = this.commandKey(rawKey);
    const shape = this.crypto.hash("ops.command", JSON.stringify(input));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, true, now);
      const replay = await this.previous(c, actor.userId, op, key, shape);
      if (replay) return this.commandView(replay);
      const result = await c.query(
        `UPDATE operator_alert_settings SET heartbeat_stale_seconds=$2,query_delay_seconds=$3,
         collector_failure_percent=$4,updated_at=$5,version=version+1 WHERE singleton AND version=$1`,
        [
          input.version,
          input.heartbeat_stale_seconds,
          input.query_delay_seconds,
          input.collector_failure_percent,
          now,
        ],
      );
      if (!result.rowCount) return fail("state_conflict", 409, "Alert settings changed.");
      const { reason, ...thresholds } = input;
      return this.commandView(
        await this.record(
          c,
          actor.userId,
          op,
          "operator_settings",
          "alerts",
          key,
          shape,
          reason,
          requestId,
          now,
          { ...thresholds, new_version: input.version + 1 },
        ),
      );
    });
  }
  private userSummary(row: {
    id: string;
    status: string;
    email: string | null;
    created_at: Date;
    credential_version: number;
  }) {
    const email = row.email?.split("@");
    return {
      id: row.id,
      status: row.status,
      email_hint: email?.length === 2 ? `${email[0]?.slice(0, 1)}***@${email[1]}` : null,
      created_at: iso(row.created_at),
      credential_version: row.credential_version,
    };
  }
  async users(actor: Identity, paging: Page) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, true, await this.service.now(c));
      const cursor = this.service.readCursor(actor.userId, "ops.users", paging.cursor);
      const rows = (
        await c.query(
          `SELECT u.id,u.status,u.email,u.created_at,u.credential_version,${timeSql("u.created_at")}
         FROM users u WHERE ($1::timestamptz IS NULL OR (u.created_at,u.id)<($1::timestamptz,$2::uuid))
         ORDER BY u.created_at DESC,u.id DESC LIMIT $3`,
          [cursor?.time ?? null, cursor?.id ?? null, paging.size + 1],
        )
      ).rows;
      return this.page(rows, actor, "ops.users", paging.size, (row) => this.userSummary(row));
    });
  }
  async userCase(actor: Identity, subject: string, requestId: string) {
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await c.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
        [actor.userId, subject],
      ]);
      await this.role(c, actor, true, now);
      const user = (
        await c.query(
          `SELECT id,status,email,created_at,credential_version,EXISTS(SELECT 1 FROM admin_roles WHERE user_id=users.id) operator
           FROM users WHERE id=$1 FOR SHARE`,
          [subject],
        )
      ).rows[0];
      if (!user) return fail("not_found", 404, "Account not found.");
      const projection = (
        await c.query(
          `SELECT
          (SELECT count(*)::int FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>$2) AS sessions,
          (SELECT count(*)::int FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL) AS api_keys,
          (SELECT count(*)::int FROM queries WHERE user_id=$1) AS query_count,
          (SELECT count(*)::int FROM payments WHERE user_id=$1) AS payment_count,
          (SELECT coalesce(jsonb_agg(c ORDER BY c.created_at DESC,c.id),'[]') FROM
            (SELECT id,query_id,charged_credits,state,created_at FROM billing_charges
              WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 10) c) AS charges,
          (SELECT coalesce(jsonb_agg(r ORDER BY r.created_at DESC,r.id),'[]') FROM
            (SELECT id,category,status,created_at FROM support_requests
              WHERE user_id=$1 AND retention_until>$2 ORDER BY created_at DESC,id LIMIT 10) r) AS tickets,
          (SELECT coalesce(jsonb_agg(n ORDER BY n.created_at DESC,n.id),'[]') FROM
            (SELECT id,content,created_at FROM operator_account_notes
              WHERE subject_user_id=$1 ORDER BY created_at DESC,id LIMIT 20) n) AS notes,
          (SELECT coalesce(jsonb_agg(p ORDER BY p.created_at DESC,p.id),'[]') FROM
            (SELECT id,provider,state,amount_cents::text,currency,created_at FROM payments
              WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 10) p) AS payments`,
          [subject, now],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO audit_events(actor_id,action,object_type,object_id,request_id,created_at) VALUES($1,'ops.user.view','account',$2,$3,$4)",
        [actor.userId, subject, requestId, now],
      );
      return {
        account: this.userSummary(user),
        operator: user.operator,
        ...projection,
        as_of: now.toISOString(),
      };
    });
  }
  async addUserNote(
    actor: Identity,
    subject: string,
    content: string,
    rawKey: string | undefined,
    requestId: string,
  ) {
    const op = "ops.user.note",
      key = this.commandKey(rawKey),
      shape = this.crypto.hash("ops.command", JSON.stringify([subject, content]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await c.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
        [actor.userId, subject],
      ]);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) return this.commandView(prior);
      const note = (
        await c.query(
          `INSERT INTO operator_account_notes(subject_user_id,author_id,content,created_at)
          SELECT id,$2,$3,$4 FROM users WHERE id=$1 AND status<>'deleted' RETURNING id`,
          [subject, actor.userId, content, now],
        )
      ).rows[0];
      if (!note) return fail("not_found", 404, "Active account reference not found.");
      return this.commandView(
        await this.record(c, actor.userId, op, "account", subject, key, shape, content, requestId, now, {
          note_id: note.id,
        }),
      );
    });
  }
  async chargeDetail(actor: Identity, id: string) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, true, await this.service.now(c));
      const charge = (
        await c.query(
          "SELECT id,user_id,query_id,charged_credits,state,created_at FROM billing_charges WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!charge) return fail("not_found", 404, "Charge not found.");
      const ledger = (
        await c.query(
          "SELECT id,wallet_id,kind,delta,balance_after,created_at FROM credit_ledger WHERE charge_id=$1 ORDER BY created_at,id",
          [id],
        )
      ).rows;
      return { charge, ledger };
    });
  }
  async approvals(actor: Identity, paging: Page) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, true, await this.service.now(c));
      const cursor = this.service.readCursor(actor.userId, "ops.approvals", paging.cursor);
      const rows = (
        await c.query(
          `SELECT *,${timeSql("updated_at")} FROM operator_account_approvals
         WHERE ($1::timestamptz IS NULL OR (updated_at,id)<($1::timestamptz,$2::uuid))
         ORDER BY updated_at DESC,id DESC LIMIT $3`,
          [cursor?.time ?? null, cursor?.id ?? null, paging.size + 1],
        )
      ).rows;
      return this.page(rows, actor, "ops.approvals", paging.size, (row) => ({
        id: row.id,
        subject_user_id: row.subject_user_id,
        action: row.action,
        state: row.state,
        reason: row.request_reason,
        requested_by: row.requested_by,
        requested_at: iso(row.requested_at),
        reviewed_by: row.reviewed_by,
        reviewed_at: iso(row.reviewed_at),
        executed_by: row.executed_by,
        executed_at: iso(row.executed_at),
        version: row.version,
        can_review: actor.userId !== row.requested_by && row.state === "requested",
      }));
    });
  }
  async requestApproval(
    actor: Identity,
    subject: string,
    input: { action: ApprovalAction; credential_version: number; reason: string },
    rawKey: string | undefined,
    requestId: string,
  ) {
    const op = "ops.approval.request",
      key = this.commandKey(rawKey),
      shape = this.crypto.hash("ops.command", JSON.stringify([subject, input]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await c.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
        [actor.userId, subject],
      ]);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) return this.commandView(prior);
      await this.accountTarget(c, subject, input.action, input.credential_version);
      const row = (
        await c.query(
          `INSERT INTO operator_account_approvals(subject_user_id,action,subject_credential_version,request_reason,requested_by,requested_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING RETURNING id`,
          [subject, input.action, input.credential_version, input.reason, actor.userId, now],
        )
      ).rows[0];
      if (!row) return fail("state_conflict", 409, "Open approval already exists for this account.");
      return this.commandView(
        await this.record(c, actor.userId, op, "approval", row.id, key, shape, input.reason, requestId, now, {
          subject_user_id: subject,
        }),
      );
    });
  }
  private async accountTarget(c: Transaction, subject: string, action: ApprovalAction, version: number) {
    const row = (
      await c.query(
        `SELECT status,credential_version,EXISTS(SELECT 1 FROM admin_roles WHERE user_id=users.id) operator
       FROM users WHERE id=$1`,
        [subject],
      )
    ).rows[0];
    if (!row || row.status === "deleted") return fail("not_found", 404, "Account not found.");
    if (row.operator) fail("forbidden", 403, "This command is limited to customer accounts.");
    if (row.credential_version !== version || row.status !== (action === "suspend" ? "active" : "suspended"))
      fail("state_conflict", 409, "Account identity or state changed.");
  }
  async approvalCommand(
    actor: Identity,
    id: string,
    input: { command: ApprovalTransition; version: number; reason: string },
    rawKey: string | undefined,
    requestId: string,
  ) {
    const op = `ops.approval.${input.command}`,
      key = this.commandKey(rawKey),
      shape = this.crypto.hash("ops.command", JSON.stringify([id, input]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      const initial = (
        await c.query(
          "SELECT subject_user_id,requested_by,reviewed_by FROM operator_account_approvals WHERE id=$1",
          [id],
        )
      ).rows[0];
      await c.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
        [actor.userId, initial?.subject_user_id, initial?.requested_by, initial?.reviewed_by].filter(Boolean),
      ]);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) return this.commandView(prior);
      const row = (await c.query("SELECT * FROM operator_account_approvals WHERE id=$1 FOR UPDATE", [id]))
        .rows[0];
      if (!row) return fail("not_found", 404, "Approval not found.");
      if (row.version !== input.version) fail("state_conflict", 409, "Approval version changed.");
      if (input.command === "execute") {
        if (row.state !== "approved") fail("state_conflict", 409, "Approve before executing.");
        const staff = await c.query(
          `SELECT u.id FROM users u JOIN admin_roles r ON r.user_id=u.id AND r.role='admin'
           JOIN user_mfa m ON m.user_id=u.id AND m.state='enabled' WHERE u.id=ANY($1::uuid[]) AND u.status='active'
           ORDER BY u.id FOR SHARE OF r,m`,
          [[row.requested_by, row.reviewed_by]],
        );
        if (staff.rowCount !== 2) fail("forbidden", 403, "Approval access is no longer valid.");
        await this.accountTarget(c, row.subject_user_id, row.action, row.subject_credential_version);
        const status = row.action === "suspend" ? "suspended" : "active";
        await c.query(
          "UPDATE users SET status=$2,credential_version=credential_version+1,updated_at=$3 WHERE id=$1",
          [row.subject_user_id, status, now],
        );
        if (status === "suspended") {
          for (const table of ["sessions", "api_keys"]) {
            await c.query(`UPDATE ${table} SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL`, [
              row.subject_user_id,
              now,
            ]);
          }
        }
        await c.query(
          "UPDATE operator_account_approvals SET state='executed',executed_by=$2,executed_at=$3,updated_at=$3,version=version+1 WHERE id=$1",
          [id, actor.userId, now],
        );
      } else if (input.command === "cancel") {
        if (!["requested", "approved"].includes(row.state))
          fail("state_conflict", 409, "Only open approvals can be cancelled.");
        await c.query(
          "UPDATE operator_account_approvals SET state='cancelled',updated_at=$2,version=version+1 WHERE id=$1",
          [id, now],
        );
      } else {
        if (row.state !== "requested") fail("state_conflict", 409, "Approval is no longer in review.");
        if (row.requested_by === actor.userId)
          fail("forbidden", 403, "A different administrator must review.");
        if (input.command === "approve")
          await this.accountTarget(c, row.subject_user_id, row.action, row.subject_credential_version);
        await c.query(
          "UPDATE operator_account_approvals SET state=$2,reviewed_by=$3,reviewed_at=$4,updated_at=$4,version=version+1 WHERE id=$1",
          [id, input.command === "approve" ? "approved" : "rejected", actor.userId, now],
        );
      }
      return this.commandView(
        await this.record(c, actor.userId, op, "approval", id, key, shape, input.reason, requestId, now, {
          subject_user_id: row.subject_user_id,
          action: row.action,
          previous_version: row.version,
        }),
      );
    });
  }
  async incidents(actor: Identity, paging: Page) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, true, await this.service.now(c));
      const cursor = this.service.readCursor(actor.userId, "ops.incidents", paging.cursor);
      const rows = (
        await c.query(
          `SELECT *,${timeSql("updated_at")} FROM operator_incidents
         WHERE ($1::timestamptz IS NULL OR (updated_at,id)<($1::timestamptz,$2::uuid))
         ORDER BY updated_at DESC,id DESC LIMIT $3`,
          [cursor?.time ?? null, cursor?.id ?? null, paging.size + 1],
        )
      ).rows;
      return this.page(rows, actor, "ops.incidents", paging.size, ({ cursor_at: _cursor, ...row }) => row);
    });
  }
  async incidentDetail(actor: Identity, id: string) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, true, await this.service.now(c));
      const incident = (await c.query("SELECT * FROM operator_incidents WHERE id=$1", [id])).rows[0];
      if (!incident) return fail("not_found", 404, "Incident not found.");
      const timeline = (
        await c.query(
          `SELECT action,request_id,created_at,safe_diff->>'state' AS state FROM audit_events
          WHERE object_type='incident' AND object_id=$1 AND action LIKE 'ops.incident.%' ORDER BY created_at DESC,id LIMIT 50`,
          [id],
        )
      ).rows;
      return { incident, timeline };
    });
  }
  async incidentCommand(
    actor: Identity,
    id: string | null,
    input: IncidentUpdate,
    rawKey: string | undefined,
    requestId: string,
  ) {
    const op = id ? "ops.incident.update" : "ops.incident.open";
    const key = this.commandKey(rawKey),
      shape = this.crypto.hash("ops.command", JSON.stringify([id, input]));
    return transaction(this.service.db, async (c) => {
      const now = await this.service.now(c);
      await this.role(c, actor, true, now);
      const prior = await this.previous(c, actor.userId, op, key, shape);
      if (prior) return this.commandView(prior);
      const row =
        "component" in input
          ? (
              await c.query(
                "INSERT INTO operator_incidents(component,title,opened_at,updated_at) VALUES($1,$2,$3,$3) RETURNING id,state,version",
                [input.component, input.title, now],
              )
            ).rows[0]
          : (
              await c.query(
                `UPDATE operator_incidents SET state=$3,updated_at=$4::timestamptz,resolved_at=CASE WHEN $3='resolved' THEN $4::timestamptz ELSE NULL END,version=version+1
          WHERE id=$1 AND version=$2 AND state<>$3 RETURNING id,state,version`,
                [id, input.version, input.state, now],
              )
            ).rows[0];
      if (!row) return fail("state_conflict", 409, "Refresh the incident before updating its state.");
      return this.commandView(
        await this.record(c, actor.userId, op, "incident", row.id, key, shape, input.reason, requestId, now, {
          state: row.state,
          version: row.version,
        }),
      );
    });
  }
  async audits(actor: Identity, paging: Page) {
    return transaction(this.service.db, async (c) => {
      await this.role(c, actor, false, await this.service.now(c));
      const cursor = this.service.readCursor(actor.userId, "ops.audit", paging.cursor);
      const rows = (
        await c.query(
          `SELECT id,actor_id,action,object_type,object_id,request_id,created_at,${timeSql("created_at")} FROM audit_events WHERE (action LIKE 'ops.%' OR action IN ('credit.refund','account.deletion_requested','account.deletion_completed')) AND ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT $3`,
          [cursor?.time ?? null, cursor?.id ?? null, paging.size + 1],
        )
      ).rows;
      return this.page(rows, actor, "ops.audit", paging.size, (r) => ({
        id: r.id,
        actor_ref: r.actor_id ? this.crypto.hash("ops.owner", r.actor_id).slice(0, 20) : null,
        action: r.action,
        object_type: r.object_type,
        object_id: r.object_id,
        reason: null,
        request_id: safeCode(r.request_id) ?? r.id,
        created_at: iso(r.created_at),
      }));
    });
  }
}
