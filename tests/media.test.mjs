import assert from "node:assert/strict";
import test from "node:test";
import {
  approvedImageUrl,
  collectPrimaryImage,
  disabledNetworkImageTransport,
  imageIsReadable,
  isPublicImageAddress,
  selectPrimaryImage,
} from "@soldbench/media";
import sharp from "sharp";

const now = "2026-11-16T00:00:00Z";
const rights = {
  sourceId: "fixture",
  permissionEpoch: 1,
  mayCopy: true,
  mayDisplay: true,
  expiresAt: "2026-11-17T00:00:00Z",
};
const input = {
  listingId: "1",
  observationId: "observation-1",
  saleEventId: "sale-1",
  candidates: [
    {
      listingId: "1",
      observationId: "observation-1",
      saleEventId: "sale-1",
      role: "primary",
      url: "https://images.example.test/item.png",
    },
  ],
  sourceId: "fixture",
  hosts: ["images.example.test"],
};
test("primary image belongs to the target listing and excludes gallery/ad/other listing images", () => {
  assert.equal(
    selectPrimaryImage(
      "1",
      "observation-1",
      "sale-1",
      [
        {
          listingId: "2",
          observationId: "observation-1",
          saleEventId: "sale-1",
          role: "primary",
          url: input.candidates[0].url,
        },
        {
          listingId: "1",
          observationId: "observation-1",
          saleEventId: "sale-1",
          role: "advertisement",
          url: input.candidates[0].url,
        },
      ],
      input.hosts,
    ),
    null,
  );
  assert.equal(
    selectPrimaryImage("1", "observation-1", "sale-1", input.candidates, input.hosts),
    input.candidates[0].url,
  );
  assert.equal(selectPrimaryImage("1", "other-observation", "sale-1", input.candidates, input.hosts), null);
  assert.equal(selectPrimaryImage("1", "observation-1", "other-sale", input.candidates, input.hosts), null);
  for (const url of [
    "http://images.example.test/x",
    "https://127.0.0.1/x",
    "https://images.example.test:444/x",
    "https://user:pass@images.example.test/x",
    "https://other.test/x",
    "file:///tmp/x",
  ])
    assert.throws(() => approvedImageUrl(url, input.hosts));
});
test("source URL ciphertext is authenticated, versioned and bound to its database row", async () => {
  const { decryptImageSourceUrl, encryptImageSourceUrl } = await import("@soldbench/media");
  const key = Buffer.alloc(32, 11).toString("base64");
  const ciphertext = encryptImageSourceUrl(input.candidates[0].url, "row-1", key);
  assert.equal(decryptImageSourceUrl(ciphertext, "row-1", key), input.candidates[0].url);
  assert.throws(() => decryptImageSourceUrl(ciphertext, "row-2", key));
  assert.throws(() => decryptImageSourceUrl(ciphertext, "row-1", Buffer.alloc(32, 12).toString("base64")));
});
test("network image transport address policy rejects private, reserved and documentation ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.10.2",
    "172.20.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "203.0.113.4",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicImageAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1"]) assert.equal(isPublicImageAddress(address), true, address);
  for (const address of ["2001:2::1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
    assert.equal(isPublicImageAddress(address), false, address);
  assert.equal(isPublicImageAddress("not-an-ip"), false);
});
test("real image bytes decode, metadata is removed and a private WebP derivative is returned", async () => {
  const bytes = await sharp({ create: { width: 16, height: 8, channels: 3, background: "#724bea" } })
    .withMetadata({ exif: { IFD0: { Artist: "fixture private metadata" } } })
    .png()
    .toBuffer();
  const image = await collectPrimaryImage(input, {
    transport: async () => ({ status: 200, contentType: "image/png", bytes }),
    currentRights: () => rights,
    now: () => now,
    tripSourceCircuit: async () => {},
  });
  const decoded = await sharp(image.bytes).metadata();
  assert.equal(decoded.format, "webp");
  assert.equal(decoded.width, 16);
  assert.equal(decoded.height, 8);
  assert.equal(decoded.exif, undefined);
  assert.equal(image.listingId, "1");
  assert.equal(image.observationId, "observation-1");
  assert.equal(image.saleEventId, "sale-1");
  assert.equal(image.hash.length, 64);
  assert.equal(imageIsReadable(image, rights, now), true);
  assert.equal(imageIsReadable(image, { ...rights, permissionEpoch: 2 }, now), false);
  assert.equal(imageIsReadable(image, null, now), false);
  assert.equal(imageIsReadable(image, rights, rights.expiresAt), false);
});
test("denied copy, revoked/expired permissions and malformed/oversized images fail closed", async () => {
  let calls = 0;
  const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const transport = async () => {
    calls++;
    return { status: 200, contentType: "image/png", bytes };
  };
  await assert.rejects(collectPrimaryImage(input, { transport, currentRights: () => null, now: () => now }));
  assert.equal(calls, 0);
  let checks = 0;
  await assert.rejects(
    collectPrimaryImage(input, {
      transport,
      currentRights: () => (++checks === 1 ? rights : null),
      now: () => now,
      tripSourceCircuit: async () => {},
    }),
  );
  let ticks = 0;
  await assert.rejects(
    collectPrimaryImage(input, {
      transport,
      currentRights: () => rights,
      now: () => (++ticks === 1 ? now : rights.expiresAt),
      tripSourceCircuit: async () => {},
    }),
  );
  for (const response of [
    { status: 403, contentType: "text/html", bytes },
    { status: 200, contentType: "image/svg+xml", bytes },
    { status: 200, contentType: "image/png", bytes: Buffer.from("not an image") },
    { status: 200, contentType: "image/png", bytes: Buffer.alloc(5 * 1024 * 1024 + 1) },
  ]) {
    await assert.rejects(
      collectPrimaryImage(input, {
        transport: async () => response,
        currentRights: () => rights,
        now: () => now,
        tripSourceCircuit: async () => {},
      }),
    );
  }
  await assert.rejects(disabledNetworkImageTransport()(input.candidates[0].url, AbortSignal.timeout(1), 100));
});
test("upstream refusal and recognizable challenge trip the persistent source circuit hook", async () => {
  const reasons = [];
  for (const response of [
    { status: 401, contentType: "text/html", bytes: Buffer.from("sign in") },
    { status: 403, contentType: "text/html", bytes: Buffer.from("blocked") },
    {
      status: 200,
      contentType: "text/html",
      bytes: Buffer.from("<html>Verify you are human</html>"),
    },
  ]) {
    await assert.rejects(
      collectPrimaryImage(input, {
        transport: async () => response,
        currentRights: () => rights,
        now: () => now,
        tripSourceCircuit: async (reason) => reasons.push(reason),
      }),
    );
  }
  assert.deepEqual(reasons, ["access_refused", "access_refused", "challenge"]);
});
