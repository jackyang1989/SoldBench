import assert from "node:assert/strict";
import { availableParallelism } from "node:os";

const profile = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  latencyMs: 75,
  downloadBytesPerSecond: 200_000,
  uploadBytesPerSecond: 93_750,
  cpuSlowdown: 4,
};
const routes = ["/", "/search", "/zh-CN/search", "/docs/en/quickstart"];
const targetLcpMs = 2500;
const repetitions = 3;

async function sample(browser, origin, path) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    serviceWorkers: "block",
  });
  try {
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const protocol = await context.newCDPSession(page);
    await protocol.send("Network.enable");
    await protocol.send("Network.setCacheDisabled", { cacheDisabled: true });
    await protocol.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.latencyMs,
      downloadThroughput: profile.downloadBytesPerSecond,
      uploadThroughput: profile.uploadBytesPerSecond,
      connectionType: "cellular4g",
    });
    await protocol.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdown });
    await page.addInitScript(() => {
      const records = { time: null, tag: null };
      window.soldbenchMobileLab = records;
      new PerformanceObserver((list) => {
        const candidate = list.getEntries().at(-1);
        if (candidate) {
          records.time = candidate.startTime;
          records.tag = candidate.element?.tagName ?? null;
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
    const result = await page.goto(origin + path, { waitUntil: "load", timeout: 15000 });
    assert.equal(result.status(), 200);
    assert.equal(new URL(page.url()).origin, origin);
    await page.waitForFunction(() => window.soldbenchMobileLab.time !== null, undefined, { timeout: 5000 });
    return await page.evaluate(async () => {
      // Observe late paint candidates after the page and its initial resources have loaded.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const navigation = performance.getEntriesByType("navigation")[0];
      const transferBytes = performance
        .getEntriesByType("resource")
        .reduce((total, entry) => total + entry.transferSize, navigation.transferSize);
      const lcp = window.soldbenchMobileLab;
      return { lcpMs: lcp.time, lcpElement: lcp.tag, ttfbMs: navigation.responseStart, transferBytes };
    });
  } finally {
    await context.close();
  }
}

export async function measureMobileWeb(browser, origin) {
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  const timings = [];
  for (const path of routes) {
    const samples = [];
    for (let i = 0; i < repetitions; i++) samples.push(await sample(browser, origin, path));
    const sorted = samples.map((item) => item.lcpMs).sort((a, b) => a - b);
    timings.push({
      path,
      samples,
      medianLcpMs: sorted[1],
      maxLcpMs: sorted.at(-1),
      samplesBelowTarget: sorted.filter((time) => time <= targetLcpMs).length,
    });
  }
  return {
    kind: "soldbench_mobile_lab",
    clock: "Chrome navigation relative monotonic time",
    scope: "cold local anonymous navigation under a synthetic mobile network profile",
    platform: process.platform,
    arch: process.arch,
    logicalParallelism: availableParallelism(),
    chrome: browser.version(),
    profile,
    targetLcpMs,
    timings,
    productionSloVerified: false,
  };
}
