import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "@soldbench/api";
import { database, migrate } from "@soldbench/db";
import { sanitizeLookupImage } from "@soldbench/media";
import { LookupInputService, validateBarcode } from "@soldbench/query";
import { loadConfig } from "@soldbench/shared";
import sharp from "sharp";
import { createProductFixture } from "./helpers/product.mjs";

const db = database(process.env.DATABASE_URL);
const roots = [];

before(() => migrate(db));
after(async () => {
  await db.end();
  await Promise.all(roots.map((p) => rm(p, { recursive: true, force: true })));
});

test("AT-067 barcode validator rejects bad check digits/lengths and accepts valid GS1 formats", () => {
  assert.deepEqual(validateBarcode("045496-730017"), { value: "045496730017", format: "upc_a" });
  assert.deepEqual(validateBarcode("978-0-306-40615-7"), { value: "9780306406157", format: "isbn_13" });
  assert.deepEqual(validateBarcode("4006381333931"), { value: "4006381333931", format: "ean_13" });
  for (const bad of ["045496730018", "12345", "12345678901", "ABCDEFGHIJKL"]) {
    assert.throws(
      () => validateBarcode(bad),
      (err) => err?.code === "invalid_parameter",
      bad,
    );
  }
  assert.throws(
    () => validateBarcode("4006381333931", "isbn_13"),
    (err) => err?.code === "invalid_parameter",
  );
});

test("AT-067 image sanitizer enforces magic bytes, blocks pixel bombs/MIME spoofing/SVG, and strips EXIF", async () => {
  const withExif = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 24, g: 48, b: 96 } },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Software: "EXIF-Camera-GPS-Marker" } } })
    .toBuffer();
  assert.ok((await sharp(withExif).metadata()).exif?.byteLength);

  const sanitized = await sanitizeLookupImage(withExif, "image/jpeg");
  assert.equal(sanitized.mimeType, "image/webp");
  assert.equal(sanitized.detectedInputMime, "image/jpeg");
  assert.equal(sanitized.originalHadExif, true);
  assert.equal(sanitized.exifStripped, true);
  assert.equal((await sharp(sanitized.bytes).metadata()).exif, undefined);

  await assert.rejects(
    () => sanitizeLookupImage(withExif, "image/png"),
    (err) => err?.code === "invalid_parameter",
  );
  await assert.rejects(
    () => sanitizeLookupImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml"),
    (err) => err?.code === "invalid_parameter",
  );
  await assert.rejects(
    () => sanitizeLookupImage(Buffer.from("<html><script>alert(1)</script></html>"), "image/png"),
    (err) => err?.code === "invalid_parameter",
  );
  await assert.rejects(
    () => sanitizeLookupImage(Buffer.from("%PDF-1.7\n"), "image/jpeg"),
    (err) => err?.code === "invalid_parameter",
  );

  const pixelBomb = await sharp({
    create: { width: 5001, height: 5001, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await assert.rejects(
    () => sanitizeLookupImage(pixelBomb, "image/png"),
    (err) => err?.code === "invalid_parameter",
  );

  const animatedFrames = await sharp(Buffer.alloc(16 * 32 * 4, 180), {
    raw: { width: 16, height: 32, channels: 4 },
  })
    .webp()
    .toBuffer();
  assert.equal((await sanitizeLookupImage(animatedFrames, "image/webp")).exifStripped, true);

  const oversizedHeader = Buffer.alloc(5 * 1024 * 1024 + 10);
  oversizedHeader[0] = 0x89;
  oversizedHeader[1] = 0x50;
  oversizedHeader[2] = 0x4e;
  oversizedHeader[3] = 0x47;
  await assert.rejects(
    () => sanitizeLookupImage(oversizedHeader, "image/png"),
    (err) => err?.code === "invalid_parameter",
  );
});

test("AT-067 end-to-end image/barcode confirmation, text fallback, owner isolation, fee separation, delete & retention expiry", async () => {
  const x = await createProductFixture(db, roots, {
    keyword: "Nintendo Game Boy DMG-01",
    count: 12,
    limit: 10,
    claimed: true,
  });

  const otherSecret = x.auth.crypto.token("sb_k_");
  const otherId = (
    await db.query(
      "INSERT INTO users(email,password_hash,status,email_verified_at,free_anchor_at) VALUES($1,'fixture','active',$2,$2) RETURNING id",
      [`other-lookup-${randomUUID()}@example.test`, x.now()],
    )
  ).rows[0].id;
  await db.query(
    "INSERT INTO api_keys(user_id,name,key_hash,key_prefix,scopes) VALUES($1,'other',$2,'sb_k_lkp',$3)",
    [otherId, x.auth.crypto.hash("auth.api-key", otherSecret), ["sold:read", "jobs:read", "usage:read"]],
  );
  const otherHeaders = { Authorization: `Bearer ${otherSecret}`, "Content-Type": "application/json" };

  const lookupService = new LookupInputService(x.query);
  const app = createApp(loadConfig({}), db, { auth: x.auth, query: x.query, lookup: lookupService });
  const jsonHeaders = { ...x.headers, "Content-Type": "application/json" };

  const beforeBalance = (await (await app.request("/v1/usage", { headers: x.headers })).json()).data
    .total_available;

  // 1. Valid image with EXIF -> strips EXIF, 0 identification credits
  const exifJpeg = await sharp({
    create: { width: 80, height: 80, channels: 3, background: { r: 30, g: 90, b: 140 } },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "Private Upload EXIF" } } })
    .toBuffer();

  const imgRes = await app.request("/v1/lookup/image", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      image_base64: exifJpeg.toString("base64"),
      mime_type: "image/jpeg",
      filename: "nintendo-gameboy.jpg",
      retention_hours: 1,
    }),
  });
  assert.equal(imgRes.status, 201);
  const imgBody = await imgRes.json();
  assert.equal(imgBody.meta.credits_charged, 0);
  assert.equal(imgBody.data.status, "candidates_ready");
  assert.equal(imgBody.data.original_had_exif, true);
  assert.equal(imgBody.data.exif_stripped, true);
  assert.equal(imgBody.data.identification_credits_charged, 0);
  assert.equal(imgBody.data.sold_lookup_credit_policy, "up_to_1_credit_on_explicit_claim");

  const storedRow = (await db.query("SELECT storage_key FROM lookup_sessions WHERE id=$1", [imgBody.data.id]))
    .rows[0];
  assert.ok(storedRow.storage_key);
  const diskBytes = await lookupService.mediaStore.get(storedRow.storage_key);
  assert.equal((await sharp(diskBytes).metadata()).exif, undefined);

  // 2. Ambiguous barcode returns multiple candidates requiring confirmation
  const multiBarcodeRes = await app.request("/v1/lookup/barcode", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ barcode: "045496730017" }),
  });
  assert.equal(multiBarcodeRes.status, 201);
  const multiBarcode = (await multiBarcodeRes.json()).data;
  assert.equal(multiBarcode.ambiguity_reason, "multiple_versions");
  assert.equal(multiBarcode.candidates.length, 2);

  // Wrong-model/keyword override confirms & submits standard sold query cleanly with idempotency
  const confirmKey = randomUUID();
  const confirmRes = await app.request(`/v1/lookup/sessions/${multiBarcode.id}/confirm`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": confirmKey },
    body: JSON.stringify({
      candidate_id: multiBarcode.candidates[0].id,
      override_q: "Nintendo Game Boy DMG-01",
      window_days: 90,
      limit: 10,
    }),
  });
  assert.ok([200, 202].includes(confirmRes.status));
  const confirmedBody = await confirmRes.json();
  assert.equal(confirmedBody.meta.credits_charged, 0);
  assert.equal(confirmedBody.data.replayed, false);
  assert.equal(confirmedBody.data.submission.query_id, x.queryId);

  const replayRes = await app.request(`/v1/lookup/sessions/${multiBarcode.id}/confirm`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": confirmKey },
    body: JSON.stringify({
      candidate_id: multiBarcode.candidates[0].id,
      override_q: "Nintendo Game Boy DMG-01",
      window_days: 90,
      limit: 10,
    }),
  });
  assert.ok([200, 202].includes(replayRes.status));
  assert.equal((await replayRes.json()).data.replayed, true);

  const conflictRes = await app.request(`/v1/lookup/sessions/${multiBarcode.id}/confirm`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": confirmKey },
    body: JSON.stringify({
      candidate_id: multiBarcode.candidates[1].id,
      override_q: "Game Boy Alternate",
    }),
  });
  assert.equal(conflictRes.status, 409);

  // 3. Low-confidence and failed recognition require text fallback before submission
  const blurryRes = await app.request("/v1/lookup/image", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      image_base64: exifJpeg.toString("base64"),
      mime_type: "image/jpeg",
      filename: "blurry-handheld.jpg",
    }),
  });
  assert.equal(blurryRes.status, 201);
  const blurry = (await blurryRes.json()).data;
  assert.equal(blurry.status, "fallback_text_required");
  assert.equal(blurry.fallback_to_text, true);

  const blindConfirm = await app.request(`/v1/lookup/sessions/${blurry.id}/confirm`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ candidate_id: blurry.candidates[0].id }),
  });
  assert.equal(blindConfirm.status, 400);

  const failRes = await app.request("/v1/lookup/image", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      image_base64: exifJpeg.toString("base64"),
      mime_type: "image/jpeg",
      filename: "fail-provider.jpg",
    }),
  });
  assert.equal(failRes.status, 201);
  const failed = (await failRes.json()).data;
  assert.equal(failed.status, "recognition_failed");
  assert.equal(failed.failure_code, "provider_error");
  assert.equal(failed.fallback_to_text, true);

  const fallbackConfirm = await app.request(`/v1/lookup/sessions/${failed.id}/confirm`, {
    method: "POST",
    headers: { ...jsonHeaders, "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ override_q: "Nintendo Game Boy DMG-01", limit: 10 }),
  });
  assert.ok([200, 202].includes(fallbackConfirm.status));
  const fallbackBody = await fallbackConfirm.json();
  assert.equal(fallbackBody.meta.credits_charged, 0);
  assert.equal(fallbackBody.data.submission.query_id, x.queryId);

  // 4. Owner isolation across GET, confirm, and DELETE
  assert.equal(
    (await app.request(`/v1/lookup/sessions/${imgBody.data.id}`, { headers: otherHeaders })).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/v1/lookup/sessions/${imgBody.data.id}/confirm`, {
        method: "POST",
        headers: { ...otherHeaders, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ override_q: "Nintendo Game Boy" }),
      })
    ).status,
    404,
  );
  assert.equal(
    (await app.request(`/v1/lookup/sessions/${imgBody.data.id}`, { method: "DELETE", headers: otherHeaders }))
      .status,
    404,
  );

  // 5. Explicit DELETE removes physical upload immediately & blocks later confirmation
  const delRes = await app.request(`/v1/lookup/sessions/${blurry.id}`, {
    method: "DELETE",
    headers: x.headers,
  });
  assert.equal(delRes.status, 204);
  const deletedFilePath = join(lookupService.mediaStore.root, storedRow.storage_key);
  // blurry reused content-addressed key if same bytes; make unique JPEG to verify unlink cleanly
  const uniqueJpeg = await sharp({
    create: { width: 96, height: 96, channels: 3, background: { r: 210, g: 75, b: 30 } },
  })
    .jpeg()
    .toBuffer();
  const uniqueUpload = (
    await (
      await app.request("/v1/lookup/image", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          image_base64: uniqueJpeg.toString("base64"),
          mime_type: "image/jpeg",
          filename: "unique-delete.jpg",
          retention_hours: 1,
        }),
      })
    ).json()
  ).data;
  const uniqueKey = (await db.query("SELECT storage_key FROM lookup_sessions WHERE id=$1", [uniqueUpload.id]))
    .rows[0].storage_key;
  const uniquePath = join(lookupService.mediaStore.root, uniqueKey);
  await access(uniquePath);

  assert.equal(
    (await app.request(`/v1/lookup/sessions/${uniqueUpload.id}`, { method: "DELETE", headers: x.headers }))
      .status,
    204,
  );
  await assert.rejects(() => access(uniquePath));
  assert.equal(
    (
      await app.request(`/v1/lookup/sessions/${uniqueUpload.id}/confirm`, {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ override_q: "Nintendo Game Boy" }),
      })
    ).status,
    410,
  );

  // 6. Retention expiry sweep respects active shared references and removes files once all refs expire
  const imgFilePath = deletedFilePath;
  await access(imgFilePath);
  x.clock.value = new Date(Date.parse(x.now()) + 2 * 3600000).toISOString();
  const partialSweep = await lookupService.sweepExpiredUploads();
  assert.ok(partialSweep.expiredCount >= 1);
  await access(imgFilePath);
  x.clock.value = new Date(Date.parse(x.now()) + 24 * 3600000).toISOString();
  const fullSweep = await lookupService.sweepExpiredUploads();
  assert.ok(fullSweep.filesRemoved >= 1);
  await assert.rejects(() => access(imgFilePath));
  assert.equal(
    (
      await app.request(`/v1/lookup/sessions/${imgBody.data.id}/confirm`, {
        method: "POST",
        headers: { ...jsonHeaders, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ override_q: "Nintendo Game Boy" }),
      })
    ).status,
    410,
  );

  // 7. Disabled recognizer mode fails closed (503) with 0 files and 0 credits
  const disabledApp = createApp(loadConfig({}), db, {
    auth: x.auth,
    query: x.query,
    lookup: new LookupInputService(x.query, { mode: "disabled" }),
  });
  const blocked = await disabledApp.request("/v1/lookup/barcode", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ barcode: "045496710118" }),
  });
  assert.equal(blocked.status, 503);

  const afterBalance = (await (await app.request("/v1/usage", { headers: x.headers })).json()).data
    .total_available;
  assert.equal(afterBalance, beforeBalance);
  assert.deepEqual(await x.billing.reconcile(x.user), []);
});
