const page = document.body.dataset.page;
const prefix = document.body.dataset.prefix;
const zh = document.documentElement.lang === "zh-CN";
const t = (en, cn) => (zh ? cn : en);
const status = document.querySelector("[data-status]");
const actions = document.querySelector("[data-actions]");
const output = document.querySelector("[data-results]");
const search = document.querySelector("[data-search]");
const trace = document.querySelector("[data-api-trace]");
const current = () => new URL(location.href);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safeId = (value) => (uuid.test(value ?? "") ? value : null);
const queryNames = [
  "q",
  "condition",
  "sale_format",
  "window_days",
  "price_basis",
  "allow_stale",
  "min_price_cents",
  "max_price_cents",
  "category",
];
const draftNames = [...queryNames, "job", "result"];

function queryDraft(form) {
  const fields = new FormData(form);
  const draft = new URLSearchParams();
  for (const name of queryNames) {
    if (name.endsWith("_cents")) continue;
    const value = fields.get(name)?.trim();
    if (value) draft.set(name, name === "allow_stale" ? "true" : value);
  }
  for (const name of ["min_price", "max_price"]) {
    const value = fields.get(name)?.trim() ?? "";
    if (!value || !/^\d+(\.\d{1,2})?$/.test(value)) continue;
    const [dollars, fraction = ""] = value.split(".");
    draft.set(`${name}_cents`, (BigInt(dollars) * 100n + BigInt(fraction.padEnd(2, "0"))).toString());
  }
  return draft;
}

function resume(path, draft = current().searchParams, keepResult = true) {
  const filtered = new URLSearchParams();
  for (const key of draftNames) {
    if (!keepResult && (key === "job" || key === "result")) continue;
    const value = draft.get(key);
    if (value && value.length <= 120 && (!["job", "result"].includes(key) || safeId(value))) {
      filtered.set(key, value);
    }
  }
  if (keepResult && !filtered.has("result") && safeId(document.body.dataset.resultId)) {
    filtered.set("result", document.body.dataset.resultId);
  }
  return prefix + path + (filtered.size ? `?${filtered}` : "");
}

function message(text, kind = "") {
  if (!status) return;
  status.textContent = text;
  status.dataset.kind = kind;
  status.hidden = !text;
}

function link(text, href) {
  const a = document.createElement("a");
  a.className = "btn ghost";
  a.textContent = text;
  a.href = href;
  return a;
}

function button(text, onClick) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "btn brand";
  control.textContent = text;
  control.addEventListener("click", onClick);
  return control;
}

async function api(path, options, downloadFile = false) {
  const response = await fetch(path, { ...options, cache: "no-store", redirect: "error" });
  if (response.ok && downloadFile) return response.blob();
  const body = response.status === 204 ? {} : await response.json();
  if (
    trace &&
    (path === "/web/search" || /^\/v1\/(sold\/[^/]+(?:\/claim)?|jobs\/[^/]+(?:\/cancel)?)$/.test(path))
  ) {
    showTrace(path, response, body);
  }
  if (!response.ok) {
    throw Object.assign(new Error(body.error?.code ?? "service_unavailable"), {
      status: response.status,
      reference: response.headers.get("X-Request-ID"),
      retryAfter: response.headers.get("Retry-After"),
    });
  }
  return body;
}

function showTrace(path, response, body) {
  const list = trace.querySelector("[data-trace-list]");
  const headers = ["X-Request-ID", "Content-Type", "Retry-After", "Cache-Control"]
    .filter((name) => response.headers.has(name))
    .map((name) => `${name}: ${response.headers.get(name)}`)
    .join("\n");
  const display = () => {
    trace.querySelector("[data-trace-body]").textContent = JSON.stringify(body, null, 2);
    trace.querySelector("[data-trace-headers]").textContent = headers;
  };
  const control = button(`${response.status} ${path.split("?")[0]}`, display);
  control.className = "btn ghost";
  list.append(control);
  if (list.childElementCount > 12) list.firstElementChild.remove();
  const params = queryDraft(search);
  trace.querySelector("[data-trace-code]").textContent =
    `curl -H "Authorization: Bearer $SOLDBENCH_API_KEY" '${location.origin}/v1/sold?${params}'`;
  display();
}

const post = (path, data, csrf, idempotency, downloadFile) =>
  api(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": document.documentElement.lang,
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
      },
      body: JSON.stringify(data),
    },
    downloadFile,
  );

async function session() {
  try {
    return (await api("/auth/me")).data;
  } catch (error) {
    if (error.status === 401) return null;
    throw error;
  }
}

function report(error) {
  const localized = {
    insufficient_credits: t(
      "Not enough credits. This result can be claimed after you add credits.",
      "余额不足。补足额度后可继续领取原结果。",
    ),
    invalid_parameter: t("Check the values and try again.", "请检查输入后重试。"),
    unauthenticated: t("Sign in to continue.", "请登录后继续。"),
    email_unverified: t("Verify your email to continue.", "请先验证邮箱。"),
    email_not_verified: t("Verify your email to continue.", "请先验证邮箱。"),
    email_verification_required: t("Verify your email to continue.", "请先验证邮箱。"),
    mfa_required: t("Complete multi-factor authentication.", "请完成双重验证。"),
    source_unavailable: t(
      "No result is cached for these filters. Edit the search or try again later.",
      "这些条件暂无缓存结果。请调整条件或稍后重试。",
    ),
    data_expired: t("The data is too old for a current search.", "数据已经超出当前查价窗口。"),
    result_expired: t("This result has expired.", "此结果已过期。"),
    forbidden: t("Access to this result is unavailable.", "当前无权访问此结果。"),
    not_found: t("This result is unavailable.", "此结果不可用。"),
    token_invalid: t(
      "The code is invalid, expired, or already used. Request another code and try again.",
      "验证码无效、已过期或已使用。请请求新验证码后重试。",
    ),
    reauthentication_required: t("Sign in again to continue this action.", "请重新登录后继续此操作。"),
    state_conflict: t(
      "An active batch or state conflict prevents this action. Refresh and try again.",
      "存在进行中的批量任务或状态冲突。请刷新后重试。",
    ),
    idempotency_conflict: t(
      "This request key was already used for different parameters.",
      "此幂等键已被用于不同的请求参数。",
    ),
    unsupported_window: t(
      "The requested window exceeds continuous approved historical coverage. Inspect retained spans or allow partial coverage.",
      "所选窗口超出连续获准历史覆盖范围。请先核对实际留存跨度或勾选允许部分覆盖。",
    ),
  };
  const retry = Number(error.retryAfter);
  const text =
    error.status === 429
      ? t(
          `Rate limit reached. ${retry > 0 ? `Retry in ${retry} seconds.` : "Try again later."}`,
          `达到请求上限。${retry > 0 ? `请在 ${retry} 秒后重试。` : "请稍后再试。"}`,
        )
      : (localized[error.message] ??
        t("The request failed. Check your inputs or try again.", "请求失败。请核对输入或稍后重试。"));
  message(text + (error.reference ? ` · ${t("Request", "请求")} ${error.reference}` : ""), "warning");
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const usd = new Intl.NumberFormat(document.documentElement.lang, {
  style: "currency",
  currency: "USD",
  currencyDisplay: "code",
});
const amount = (cents) => (Number.isSafeInteger(cents) ? usd.format(cents / 100) : "—");
const conditions = {
  new_with_tags: t("New with tags", "全新带标签"),
  new_without_tags: t("New without tags", "全新无标签"),
  like_new: t("Like new", "近新"),
  good: t("Good", "良好"),
  fair: t("Fair", "一般"),
  defective: t("For parts", "故障或零件"),
};

async function exportResult(id, format, excluded) {
  return post(
    `/v1/sold/${id}/export`,
    {
      format,
      view: excluded.length ? "adjusted" : "authoritative",
      ...(excluded.length ? { excluded_sale_event_ids: excluded } : {}),
    },
    (await session())?.csrf_token,
    undefined,
    format === "csv",
  );
}

function download(body, name) {
  const url = URL.createObjectURL(body);
  const a = element("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function shareControls(queryId) {
  const details = element("details", undefined, "share-controls");
  const result = element("div");
  const message = element("p", "", "small");
  message.setAttribute("aria-live", "polite");
  let key;
  const create = button(t("Create 24-hour link", "创建有效期 24 小时的链接"), () =>
    run(async () => {
      key ??= crypto.randomUUID();
      create.disabled = true;
      let created;
      try {
        created = (
          await post(
            "/v1/shares",
            { query_id: queryId, expires_in: 86400 },
            (
              await session()
            )?.csrf_token,
            key,
          )
        ).data;
      } catch (error) {
        if (error.message === "reauthentication_required")
          result.replaceChildren(link(t("Sign in again", "重新登录"), resume("/login")));
        create.disabled = false;
        throw error;
      }
      const id = safeId(created.share_id);
      const token = /^sb_sh_[A-Za-z0-9_-]{43}$/.test(created.token ?? "") ? created.token : null;
      result.replaceChildren();
      if (token) {
        const output = element("input");
        output.readOnly = true;
        output.setAttribute("aria-label", t("Share link", "分享链接"));
        output.value = new URL(`/share/${token}${zh ? "?lang=zh-CN" : ""}`, location.origin).href;
        output.addEventListener("focus", () => output.select());
        result.append(output);
        message.textContent = t(
          "Copy this link before leaving. Its expiry can be earlier if source access changes.",
          "离开前请复制链接。来源权利变化时，链接可能提早失效。",
        );
      } else {
        message.textContent = t(
          "The link already exists. Revoke it to create a replacement.",
          "链接已创建。撤销原链接后可重新创建。",
        );
      }
      if (id) {
        const revoke = button(t("Revoke link", "撤销链接"), () =>
          run(async () => {
            await api(`/v1/shares/${id}`, {
              method: "DELETE",
              headers: { "X-CSRF-Token": (await session())?.csrf_token ?? "" },
            });
            result.replaceChildren();
            message.textContent = t("Link revoked.", "链接已撤销。");
            key = undefined;
            create.disabled = false;
            create.focus();
          }),
        );
        revoke.className = "btn ghost";
        result.append(revoke);
      }
    }),
  );
  details.append(
    element("summary", t("Share price summary", "分享价格摘要")),
    element(
      "p",
      t(
        "Anyone with the link can see the original price summary and sample count.",
        "持链接者可查看原价格摘要和样本量。",
      ),
    ),
    create,
    message,
    result,
  );
  return details;
}

function supplementalResearch(stats) {
  const details = element("details", undefined, "research-distribution");
  const locale = document.documentElement.lang;
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  details.append(element("summary", t("Sale formats, shipping and sellers", "成交形式、运费与卖家")));

  const formats = stats.by_format;
  if (formats) {
    const rows = [
      ["fixed_price", t("Fixed price", "一口价")],
      ["auction", t("Auction", "拍卖")],
      ["best_offer", t("Best Offer", "议价成交")],
    ].map(([key, label]) => [label, formats[key].sample_count, amount(formats[key].median_cents)]);
    details.append(
      accountTable(
        t("Verified sales by format", "各形式的核验成交"),
        [t("Format", "成交形式"), t("Verified prices", "核验价格"), t("Median", "中位价")],
        rows,
      ),
      element(
        "p",
        t(
          "Each format needs eight verified prices for a median.",
          "每种成交形式至少需要 8 条核验价格才显示中位价。",
        ),
        "summary-note",
      ),
    );
  }

  const shipping = stats.shipping_summary;
  if (shipping?.groups.length)
    details.append(
      accountTable(
        t("Observed shipping by context", "按统一口径观察的运费"),
        [
          t("Context", "运费口径"),
          t("Known shipping", "已知运费笔数"),
          t("Mean shipping", "平均运费"),
          t("Free shipping", "免运费"),
        ],
        shipping.groups.map((group) => [
          group.context_ref,
          group.known_count,
          amount(group.mean_shipping_cents),
          `${percent.format(group.free_share)} (${group.free_count}/${group.known_count})`,
        ]),
      ),
    );
  if (shipping)
    details.append(
      element(
        "p",
        t(
          `Shipping unavailable for ${shipping.unknown_or_withheld_count} of ${stats.sample_count} verified prices.`,
          `${stats.sample_count} 条核验价格中，${shipping.unknown_or_withheld_count} 条暂无可用运费口径。`,
        ),
        "summary-note",
      ),
    );

  const sellers = stats.seller_summary;
  if (sellers)
    details.append(
      element(
        "p",
        sellers.distinct_count == null
          ? t(
              `Seller count unavailable for this sample (${sellers.unknown_or_withheld_count} records without seller evidence).`,
              `此样本暂无卖家数量（${sellers.unknown_or_withheld_count} 条缺少可用卖家证据）。`,
            )
          : t(
              `${sellers.distinct_count} distinct sellers in ${sellers.identified_count} of ${stats.sample_count} verified sales.`,
              `${stats.sample_count} 条核验成交中，${sellers.identified_count} 条可识别，涉及 ${sellers.distinct_count} 位不同卖家。`,
            ),
        "summary-note",
      ),
    );

  const reported = stats.source_reported_match_count;
  if (reported) {
    const units = {
      listings: t("listings", "条刊登"),
      items: t("items", "件商品"),
      events: t("events", "条事件"),
      unknown: t("matches", "条匹配"),
    };
    const count = new Intl.NumberFormat(locale).format(reported.count);
    const date = `${reported.as_of.slice(0, 16).replace("T", " ")} UTC`;
    details.append(
      element(
        "p",
        t(
          `Source-reported matches on the first page · ${reported.estimated ? "about " : ""}${count} ${units[reported.unit]} · ${date}. Verified price sample: ${stats.sample_count}.`,
          `来源报告的首屏匹配量 · ${reported.estimated ? "约 " : ""}${count} ${units[reported.unit]} · ${date}。核验价格样本为 ${stats.sample_count} 条。`,
        ),
        "summary-note",
      ),
    );
  }
  return details;
}

function researchDistribution(result, meta) {
  const id = result.query_id;
  const section = element("details", undefined, "research-distribution");
  const body = element("div");
  let generation = 0;
  section.append(element("summary", t("Price distribution and trends", "价格分布与趋势")), body);
  section.addEventListener("toggle", async () => {
    const attempt = ++generation;
    if (!section.open) {
      body.replaceChildren();
      return;
    }
    body.replaceChildren(element("p", t("Loading complete sample…", "正在加载完整样本…"), "small"));
    try {
      const { data } = await api(`/v1/sold/${id}/calculation-inputs`);
      if (!section.open || attempt !== generation) return;
      if (!data.is_complete || data.candidate_set_hash !== meta.candidate_set_hash)
        throw new Error("state_conflict");
      const cents = data.items.map((item) => item.price_usd_cents);
      body.replaceChildren(element("h3", t("Verified sample distribution", "核验价格分布")));
      if (!cents.length) {
        body.append(element("p", t("No verified prices in this sample.", "此样本没有核验价格。"), "small"));
        return;
      }
      body.append(
        element(
          "p",
          t(
            `${cents.length} prices from the complete permitted snapshot`,
            `完整获准快照中的 ${cents.length} 个核验价格`,
          ),
          "small",
        ),
      );
      const low = BigInt(Math.min(...cents)),
        high = BigInt(Math.max(...cents));
      const size = (high - low) / 5n + 1n;
      const bins = Array.from({ length: Number((high - low) / size + 1n) }, () => 0);
      for (const value of cents) bins[Number((BigInt(value) - low) / size)] += 1;
      const bars = element("ul", undefined, "distribution-bars");
      bins.forEach((count, index) => {
        const from = low + BigInt(index) * size;
        const to = from + size - 1n;
        const range = `${amount(Number(from))} – ${amount(Number(to > high ? high : to))}`;
        const row = element("li");
        const meter = element("meter");
        meter.max = Math.max(...bins);
        meter.value = count;
        meter.setAttribute("aria-label", range);
        row.append(element("span", range), meter, element("strong", String(count)));
        bars.append(row);
      });
      body.append(bars);
      const periods = result.supplemental_stats?.time_series;
      if (!periods?.buckets.length) return;
      const buckets = periods.buckets.map((bucket) => [
        `${bucket.start.slice(0, 10)} – ${bucket.end.slice(0, 10)}`,
        bucket.sample_count || (bucket.observation_coverage === "complete" ? 0 : "—"),
        bucket.observation_coverage === "complete"
          ? amount(bucket.median_cents)
          : t("Coverage unknown", "覆盖范围未知"),
      ]);
      body.append(
        accountTable(
          t("Price observations by period (UTC)", "分期价格观测（UTC）"),
          [t("Period", "时间段"), t("Verified prices", "核验价格"), t("Median", "中位价")],
          buckets,
        ),
      );
      if (periods.unassigned_count)
        body.append(
          element(
            "p",
            t(
              `${periods.unassigned_count} prices could not be placed in one UTC bucket.`,
              `${periods.unassigned_count} 笔价格无法归入单个 UTC 时间段。`,
            ),
            "small",
          ),
        );
    } catch (error) {
      if (!section.open || attempt !== generation) return;
      body.replaceChildren(
        element(
          "p",
          t(
            "The full sample is unavailable. Close and reopen to retry.",
            "完整样本暂不可用。收起后可重新打开。",
          ),
          "small",
        ),
      );
      report(error);
    }
  });
  return section;
}

function researchDiagnostics(id, expectedHash) {
  const panel = element("details", undefined, "research-distribution");
  const body = element("div");
  const reasons = {
    unverified_actual_price: t("Actual sale price unverified", "实际成交价未核验"),
    missing_shipping_evidence: t("Shipping evidence missing", "缺少运费证据"),
    hard_attribute_mismatch: t("Product attributes differ", "商品强属性不匹配"),
    missing_strong_attribute_evidence: t("Product attributes could not be confirmed", "无法核实商品强属性"),
    uncertain_identity: t("Sale identity uncertain", "成交事件身份不确定"),
    event_identity_conflict: t("Conflicting evidence for the same sale", "同一成交存在冲突证据"),
    outside_window: t("Outside the selected window", "超出查询窗口"),
    query_filter: t("Filtered out by the query", "未满足查询筛选条件"),
  };
  let generation = 0;
  async function load(cursor) {
    const attempt = ++generation;
    const params = new URLSearchParams({ page_size: "50" });
    if (cursor) params.set("cursor", cursor);
    const { data } = await api(`/v1/sold/${id}/diagnostics?${params}`);
    if (!panel.open || attempt !== generation) return;
    if (data.candidate_set_hash !== expectedHash) throw new Error("state_conflict");
    if (!cursor) {
      body.replaceChildren();
      if (data.withheld_count)
        body.append(
          element(
            "p",
            t(
              `${data.withheld_count} entries withheld by source rights`,
              `依据来源权限隐藏 ${data.withheld_count} 条记录`,
            ),
            "small",
          ),
        );
    }
    const rows = data.items.map((row) => [
      row.title ?? row.sale_event_id,
      row.include_in_price_stats ? t("Included", "计入") : t("Excluded", "未计入"),
      reasons[row.primary_exclusion_reason] ?? row.primary_exclusion_reason,
      amount(row.displayed_price_cents),
    ]);
    const card = accountTable(
      t("Snapshot decisions", "快照纳排明细"),
      [t("Item", "商品"), t("Price sample", "价格样本"), t("Reason", "原因"), t("Displayed price", "展示价")],
      rows,
    );
    if (data.next_cursor) {
      const more = button(t("Load more", "加载更多"), () =>
        run(async () => {
          more.disabled = true;
          try {
            await load(data.next_cursor);
            more.remove();
          } finally {
            more.disabled = false;
          }
        }),
      );
      card.append(more);
    }
    body.append(card);
  }
  panel.append(element("summary", t("Why sales were included or excluded", "查看成交纳入和排除原因")), body);
  panel.addEventListener("toggle", () => {
    if (!panel.open) {
      generation += 1;
      body.replaceChildren();
      return;
    }
    run(async () => {
      body.replaceChildren(element("p", t("Loading evidence…", "正在加载证据…"), "small"));
      try {
        await load();
      } catch (error) {
        body.replaceChildren(
          element(
            "p",
            t("Evidence unavailable. Close and reopen to retry.", "证据暂不可用。收起后可重新打开。"),
            "small",
          ),
        );
        throw error;
      }
    });
  });
  return panel;
}

function bestOfferVerificationPanel(id) {
  const panel = element("details", undefined, "research-panel");
  const body = element("div", undefined, "small");
  let generation = 0;

  function renderPanel(data) {
    body.replaceChildren();
    body.append(
      element(
        "p",
        t(
          `${data.summary.displayed_only_count} Best Offer listings show asking prices only and stay excluded from baseline stats. Post-lookup verification charges 0 extra credits and never overwrites Revision 1.`,
          `当前有 ${data.summary.displayed_only_count} 条 Best Offer 仅展示挂牌价且未计入默认统计。实价核验额外扣费 0 个额度，且不会重写原快照第 1 版。`,
        ),
        "small",
      ),
      element(
        "p",
        t(
          `Pending: ${data.summary.pending_count} · Verified: ${data.summary.verified_count} · Not available: ${data.summary.not_available_count} · Expired: ${data.summary.expired_count} · Blocked: ${data.summary.source_blocked_count}`,
          `待核验: ${data.summary.pending_count} · 已核验: ${data.summary.verified_count} · 不可得: ${data.summary.not_available_count} · 已过期: ${data.summary.expired_count} · 已熔断: ${data.summary.source_blocked_count}`,
        ),
        "summary-note",
      ),
    );
    const controls = element("div", undefined, "actions");
    const requestBtn = button(t("Request Best Offer verification", "发起 Best Offer 实价核验"), () =>
      run(async () => {
        requestBtn.disabled = true;
        try {
          const updated = await post(`/v1/sold/${id}/best-offers/verify`, {}, (await session())?.csrf_token);
          renderPanel(updated.data);
          message(t("Best Offer verification queued (0 credits).", "Best Offer 实价核验已入队（0 额度）。"));
        } finally {
          requestBtn.disabled = Boolean(data.eligibility.source_circuit_open);
        }
      }),
    );
    requestBtn.disabled = Boolean(data.eligibility.source_circuit_open);
    const reviseBtn = button(t("Generate revised snapshot", "生成修订版快照"), () =>
      run(async () => {
        reviseBtn.disabled = true;
        try {
          await post(
            `/v1/sold/${id}/revisions`,
            { trigger_kind: "best_offer_verification" },
            (await session())?.csrf_token,
          );
          const refreshed = await api(`/v1/sold/${id}/best-offers`);
          renderPanel(refreshed.data);
          message(
            t(
              "Revised snapshot recorded alongside preserved Revision 1.",
              "已在保留第 1 版原快照的前提下生成修订版。",
            ),
          );
        } finally {
          reviseBtn.disabled = data.summary.verified_count === 0;
        }
      }),
    );
    reviseBtn.className = "btn ghost";
    reviseBtn.disabled = data.summary.verified_count === 0;
    controls.append(requestBtn, reviseBtn);
    body.append(controls);

    const statusLabels = {
      pending: t("Pending", "待核验"),
      verified: t("Verified actual", "已核验实价"),
      not_available: t("Not available", "不可得"),
      expired: t("Expired", "已过期"),
      source_blocked: t("Circuit blocked", "已熔断"),
    };
    const itemRows = data.items.map((item) => [
      item.title ?? item.external_listing_id,
      amount(item.displayed_price_cents),
      item.verification
        ? (statusLabels[item.verification.status] ?? item.verification.status)
        : t("Unrequested", "未请求"),
      item.verification?.verified_price_usd_cents != null
        ? amount(item.verification.verified_price_usd_cents)
        : "—",
      item.verification
        ? `${item.verification.attempts} / ${item.verification.max_attempts}`
        : `0 / ${data.eligibility.max_attempts_per_item}`,
    ]);
    body.append(
      accountTable(
        t("Best Offer items", "Best Offer 记录"),
        [
          t("Item", "商品"),
          t("Displayed price", "展示价"),
          t("Verification", "核验状态"),
          t("Verified price", "实付核验价"),
          t("Attempts", "尝试次数"),
        ],
        itemRows,
      ),
    );
    const revisionRows = data.revisions.map((rev) => [
      `#${rev.revision_number}`,
      rev.trigger_kind === "delivered_baseline"
        ? t("Delivered baseline", "原交付基线")
        : t("Best Offer revision", "Best Offer 修订版"),
      String(rev.stats?.n_price_verified ?? 0),
      amount(rev.stats?.median_cents),
      `${rev.credits_charged}`,
    ]);
    body.append(
      accountTable(
        t("Snapshot revisions", "快照版本对照"),
        [
          t("Revision", "版本"),
          t("Trigger", "来源"),
          t("Verified prices", "核验样本"),
          t("Median", "中位价"),
          t("Extra credits", "额外额度"),
        ],
        revisionRows,
      ),
    );
  }

  panel.append(element("summary", t("Best Offer price verification", "Best Offer 实价后置核验")), body);
  panel.addEventListener("toggle", () => {
    if (!panel.open) {
      generation += 1;
      body.replaceChildren();
      return;
    }
    const attempt = ++generation;
    run(async () => {
      body.replaceChildren(
        element("p", t("Loading Best Offer status…", "正在加载 Best Offer 核验状态…"), "small"),
      );
      try {
        const { data } = await api(`/v1/sold/${id}/best-offers`);
        if (!panel.open || attempt !== generation) return;
        renderPanel(data);
      } catch (error) {
        body.replaceChildren(
          element(
            "p",
            t(
              "Best Offer status unavailable. Close and reopen to retry.",
              "Best Offer 状态暂不可用，收起后可重新打开。",
            ),
            "small",
          ),
        );
        throw error;
      }
    });
  });
  return panel;
}

function addResearchTools(card, id, research) {
  const toolbar = element("div", undefined, "result-toolbar");
  const adjusted = element("p", research.summary, "summary-note");
  adjusted.setAttribute("aria-live", "polite");
  const sort = element("select");
  sort.setAttribute("aria-label", t("Sort results", "结果排序"));
  for (const [value, label] of [
    ["", t("Latest sale", "最近成交")],
    ["price_asc", t("Lowest price first", "价格从低到高")],
    ["price_desc", t("Highest price first", "价格从高到低")],
    ["date_asc", t("Earliest sale", "最早成交")],
  ]) {
    const option = element("option", label);
    option.value = value;
    sort.append(option);
  }
  sort.value = research.sort;
  sort.addEventListener("change", () =>
    run(async () => {
      sort.disabled = true;
      try {
        const next = sort.value;
        const updated = await api(`/v1/sold/${id}${next ? `?sort=${next}` : ""}`);
        if (!card.isConnected) return;
        research.sort = next;
        resultView(updated, research);
        output.querySelector("select")?.focus();
      } finally {
        sort.value = research.sort;
        sort.disabled = false;
      }
    }),
  );
  const recalculate = button(t("Recalculate", "重算"), () =>
    run(async () => {
      const ids = [...research.excluded];
      recalculate.disabled = true;
      try {
        const result = await exportResult(id, "json", ids);
        if (ids.length !== research.excluded.size || ids.some((value) => !research.excluded.has(value)))
          return;
        const stats = result.price_summary;
        research.summary = t(
          `Adjusted median ${amount(stats.median_cents)} · ${stats.n_price_verified} verified · ${ids.length} excluded`,
          `调整后中位价 ${amount(stats.median_cents)} · 已核验 ${stats.n_price_verified} 条 · 已排除 ${ids.length} 条`,
        );
        adjusted.textContent = research.summary;
      } finally {
        recalculate.disabled = research.excluded.size === 0;
      }
    }),
  );
  recalculate.disabled = research.excluded.size === 0;
  toolbar.append(sort, recalculate);
  for (const [format, label] of [
    ["csv", t("Export CSV", "导出 CSV")],
    ["json", t("Export JSON", "导出 JSON")],
  ]) {
    const control = button(label, () =>
      run(async () => {
        control.disabled = true;
        const excluded = [...research.excluded];
        try {
          const result = await exportResult(id, format, excluded);
          const blob =
            format === "csv"
              ? result
              : new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
          download(blob, `soldbench-${excluded.length ? "adjusted" : "authoritative"}.${format}`);
        } finally {
          control.disabled = false;
        }
      }),
    );
    control.className = "btn ghost";
    toolbar.append(control);
  }
  const restore = button(t("Restore all", "恢复全部"), () => {
    research.excluded.clear();
    research.summary = "";
    adjusted.textContent = "";
    recalculate.disabled = true;
    for (const input of card.querySelectorAll(".exclusion input")) input.checked = false;
  });
  restore.className = "btn ghost";
  const excludeAll = button(t("Exclude complete sample", "排除完整样本"), () =>
    run(async () => {
      excludeAll.disabled = true;
      try {
        const { data } = await api(`/v1/sold/${id}/calculation-inputs`);
        if (!card.isConnected) return;
        if (!data.is_complete) throw new Error("forbidden");
        research.excluded = new Set(data.items.map((row) => row.sale_event_id));
        for (const input of card.querySelectorAll(".exclusion input")) input.checked = true;
        research.summary = t(
          `${research.excluded.size} marked for exclusion`,
          `已标记排除 ${research.excluded.size} 条`,
        );
        adjusted.textContent = research.summary;
        recalculate.disabled = research.excluded.size === 0;
      } finally {
        excludeAll.disabled = false;
      }
    }),
  );
  excludeAll.className = "btn ghost";
  toolbar.append(excludeAll, restore);
  card.append(toolbar, adjusted);
  return (eventId) => {
    const label = element("label", undefined, "exclusion");
    const input = element("input");
    input.type = "checkbox";
    input.checked = research.excluded.has(eventId);
    input.addEventListener("change", () => {
      if (input.checked) research.excluded.add(eventId);
      else research.excluded.delete(eventId);
      recalculate.disabled = research.excluded.size === 0;
      research.summary = research.excluded.size
        ? t(`${research.excluded.size} marked for exclusion`, `已标记排除 ${research.excluded.size} 条`)
        : "";
      adjusted.textContent = research.summary;
    });
    label.append(input, t("Exclude", "排除"));
    return label;
  };
}

function comparablePhoto(image) {
  const frame = element("span", undefined, "comp-photo");
  const url = image?.url;
  if (image?.state !== "available" || !/^\/v1\/media\/[0-9a-f-]{36}$/.test(url ?? "")) {
    const state = {
      pending: t("Photo pending", "主图待处理"),
      expired: t("Photo expired", "主图已过期"),
      revoked: t("Photo withdrawn", "主图已撤回"),
      not_permitted: t("Photo withheld", "主图无权显示"),
      missing: t("No photo", "暂无主图"),
    };
    frame.append(element("span", state[image?.state] ?? t("Photo unavailable", "主图不可用"), "small"));
    return frame;
  }
  const status = element("span", "", "small");
  status.setAttribute("aria-live", "polite");
  const retry = button(t("Retry photo", "重试主图"), () => load(true));
  retry.className = "btn ghost photo-retry";
  retry.hidden = true;
  function load(explicitRetry = false) {
    const photo = element("img", undefined, "comp-image");
    photo.alt = t("Sale photo", "成交主图");
    photo.loading = explicitRetry ? "eager" : "lazy";
    photo.decoding = "async";
    retry.hidden = true;
    status.textContent = explicitRetry ? t("Loading photo…", "正在加载主图…") : "";
    photo.addEventListener(
      "load",
      () => {
        status.textContent = "";
        if (explicitRetry && document.activeElement === status) {
          photo.tabIndex = -1;
          photo.focus();
        }
      },
      { once: true },
    );
    photo.addEventListener(
      "error",
      () => {
        photo.remove();
        status.textContent = t("Photo unavailable", "主图不可用");
        retry.hidden = false;
        if (explicitRetry && document.activeElement === status) retry.focus();
      },
      { once: true },
    );
    frame.prepend(photo);
    if (explicitRetry) {
      status.tabIndex = -1;
      status.focus();
    }
    photo.src = url;
  }
  frame.append(status, retry);
  load();
  return frame;
}

function resultView({ data, meta }, research = { sort: "", excluded: new Set(), summary: "" }) {
  actions.replaceChildren();
  output.replaceChildren();
  const placeholder = document.querySelector("[data-hero-empty]");
  if (placeholder) placeholder.hidden = true;
  if (page === "/results" && search && !search.elements.q.value && data.query?.q) {
    for (const field of ["q", "condition", "sale_format", "window_days", "price_basis"]) {
      if (data.query[field] !== undefined && search.elements[field])
        search.elements[field].value = String(data.query[field]);
    }
  }
  const stats = data.stats;
  const card = element("section", undefined, "live-card result-card");
  card.append(element("h2", t("Sold-price summary", "成交价格摘要"), "live-head"));
  const summary = element("div", undefined, "result-metrics");
  for (const [label, value] of [
    [t("Median", "中位价"), amount(stats.median_cents)],
    [
      t("Typical range", "典型区间"),
      stats.p25_cents == null ? "—" : `${amount(stats.p25_cents)} – ${amount(stats.p75_cents)}`,
    ],
    [t("Verified prices", "已核验价格"), String(stats.n_price_verified)],
    [t("Mean", "平均价"), amount(data.supplemental_stats?.mean_cents)],
    [t("Trimmed mean", "截尾均价"), amount(stats.trimmed_mean_cents)],
    [
      t("Low / high", "最低／最高"),
      `${amount(stats.observed_min_cents)} / ${amount(stats.observed_max_cents)}`,
    ],
  ]) {
    const metric = element("div");
    metric.append(element("b", label), element("strong", value));
    summary.append(metric);
  }
  card.append(summary);
  const supplemental = data.supplemental_stats;
  if (supplemental) {
    const recent = supplemental.recent_30d;
    if (recent) {
      const change = supplemental.change_ratio;
      let text;
      if (recent.observation_coverage !== "complete") {
        text = t(
          `Recent 30 days · ${recent.sample_count} verified observations, coverage unknown`,
          `近 30 天 · ${recent.sample_count} 条核验观测，覆盖范围未知`,
        );
      } else {
        text = t(
          `Recent 30 days · ${amount(recent.median_cents)} median · ${recent.sample_count} verified prices`,
          `近 30 天 · 中位价 ${amount(recent.median_cents)} · ${recent.sample_count} 条核验价格`,
        );
        if (change) {
          const percent = new Intl.NumberFormat(document.documentElement.lang, {
            style: "percent",
            signDisplay: "exceptZero",
            maximumFractionDigits: 1,
          }).format(change.numerator_cents / change.denominator_cents);
          text += t(` · ${percent} from the prior 30 days`, ` · 较前 30 天 ${percent}`);
        }
      }
      card.append(element("p", text, "summary-note"));
    }
    card.append(supplementalResearch(supplemental));
  }
  const asOf = meta.data_as_of ?? data.data_as_of;
  const counts = t(
    `Observed ${stats.n_observed} · Comparable ${stats.n_comparable}`,
    `已观察 ${stats.n_observed} 条 · 可比 ${stats.n_comparable} 条`,
  );
  const recorded = asOf ? ` · ${asOf.slice(0, 16).replace("T", " ")} UTC` : "";
  card.append(element("p", counts + recorded, "summary-note"));
  const basis = data.query?.price_basis ?? data.price_basis;
  if (basis)
    card.append(
      element(
        "p",
        basis === "item"
          ? t("Basis: item price", "口径为商品价")
          : t("Basis: item price and observed shipping", "口径为商品价和已观察运费"),
        "summary-note",
      ),
    );
  const method = element("p", undefined, "summary-note");
  const methodology = element("a", t("How these prices are calculated", "查看价格计算方法"));
  methodology.href = `${prefix}/methodology`;
  method.append(methodology);
  card.append(method);
  if (data.quality?.warnings?.some((warning) => warning.code === "mixed_models")) {
    card.append(
      element("p", t("The sample includes multiple models.", "样本包含多个型号。"), "summary-note"),
    );
  }
  if (stats.n_price_verified < 8)
    card.append(
      element(
        "p",
        t("Fewer than eight verified prices. Median unavailable.", "核验价格不足八条，暂无中位价。"),
        "summary-note",
      ),
    );
  if (safeId(data.query_id) && meta.anonymous_remaining === undefined) {
    const saveForm = element("form", undefined, "actions");
    const label = element("label", t("Name this research", "为研究命名"));
    const name = element("input");
    name.required = true;
    name.maxLength = 120;
    label.append(name);
    const save = element("button", t("Save research", "保存研究"), "btn ghost");
    save.type = "submit";
    saveForm.append(label, save, link(t("Saved research", "已保存的研究"), `${prefix}/account/saved`));
    saveForm.addEventListener("submit", (event) => {
      event.preventDefault();
      run(async () => {
        save.disabled = true;
        try {
          await post(
            "/v1/saved-research",
            {
              query_id: data.query_id,
              name: name.value,
              excluded_sale_event_ids: [...research.excluded],
            },
            (await session())?.csrf_token,
          );
          message(t("Research saved.", "研究已保存。"));
          name.value = "";
        } finally {
          save.disabled = false;
        }
      });
    });
    card.append(saveForm);
  }
  if (data.comps?.length && safeId(data.query_id)) {
    const exclusion = addResearchTools(card, data.query_id, research);
    const viewport = element("div", undefined, "table-scroll");
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "region");
    viewport.setAttribute("aria-label", t("Comparable sales", "可比成交"));
    const table = element("table");
    const row = table.createTHead().insertRow();
    for (const label of [
      t("Item", "商品"),
      t("Condition", "成色"),
      t("Sold price", "成交价"),
      t("Shipping", "运费"),
      t("Item + shipping", "商品价＋运费"),
      t("Date", "成交日期"),
      t("Evidence", "证据"),
    ])
      row.append(element("th", label));
    const body = table.createTBody();
    for (const comp of data.comps) {
      const line = body.insertRow();
      const item = line.insertCell();
      item.append(comparablePhoto(comp.primary_image));
      item.append(element("span", comp.title ?? t("Title unavailable", "标题不可用")));
      line.insertCell().textContent = conditions[comp.condition_std] ?? "—";
      line.insertCell().textContent = amount(comp.item_price_cents);
      line.insertCell().textContent = amount(comp.observed_shipping_cents);
      line.insertCell().textContent =
        Number.isSafeInteger(comp.item_price_cents) && Number.isSafeInteger(comp.observed_shipping_cents)
          ? amount(comp.item_price_cents + comp.observed_shipping_cents)
          : "—";
      const soldDate = comp.sold_date;
      line.insertCell().textContent =
        soldDate?.precision === "day"
          ? `${soldDate.value}${soldDate.timeZone ? ` · ${soldDate.timeZone}` : ""}`
          : soldDate?.precision === "instant"
            ? `${soldDate.value.slice(0, 10)} UTC`
            : "—";
      const evidenceCell = line.insertCell();
      const event = safeId(comp.sale_event_id);
      if (!event) continue;
      const detail = element("details");
      const toggle = element("summary", t("View evidence", "查看证据"));
      const panel = element("div", "", "small");
      detail.append(toggle, panel);
      detail.addEventListener("toggle", async () => {
        if (!detail.open) return;
        panel.textContent = t("Loading…", "正在加载…");
        try {
          const result = await api(`/v1/sold/${data.query_id}/comps/${event}`);
          panel.replaceChildren();
          for (const [key, label] of [
            ["description", t("Description", "描述")],
            ["defects", t("Condition notes", "成色备注")],
            ["attributes", t("Attributes", "商品属性")],
          ]) {
            const field = result.data.fields[key];
            const value =
              key === "attributes" && field.state === "present"
                ? Object.entries(field.value)
                    .map(([name, value]) => `${name} ${value}`)
                    .join(" · ")
                : field.value;
            panel.append(
              element(
                "p",
                `${label} · ${field.state === "present" ? value : field.state === "withheld" ? t("Withheld", "无权限") : t("Unavailable", "暂无")}`,
              ),
            );
          }
        } catch (error) {
          panel.textContent = t(
            "Evidence unavailable. Close and reopen to retry.",
            "证据暂不可用。收起后可重新打开。",
          );
          report(error);
        }
      });
      evidenceCell.append(detail, exclusion(event));
    }
    viewport.append(table);
    research.share ??= shareControls(data.query_id);
    card.append(
      viewport,
      researchDistribution(data, meta),
      researchDiagnostics(data.query_id, meta.candidate_set_hash),
      ...(meta.anonymous_remaining === undefined && stats.best_offer_displayed_only_count > 0
        ? [bestOfferVerificationPanel(data.query_id)]
        : []),
      research.share,
    );
  } else if (
    safeId(data.query_id) &&
    meta.anonymous_remaining === undefined &&
    stats.best_offer_displayed_only_count > 0
  ) {
    card.append(bestOfferVerificationPanel(data.query_id));
  }
  output.append(card);
  if (meta.anonymous_remaining !== undefined) {
    message(
      t(
        `Cached result · ${meta.anonymous_remaining} lookups left today`,
        `缓存结果 · 今日剩余 ${meta.anonymous_remaining} 次查价`,
      ),
    );
  } else {
    message(
      t(
        `Result delivered · ${meta.credits_charged} ${meta.credits_charged === 1 ? "credit" : "credits"} charged for this request`,
        `已交付 · 本次扣费 ${meta.credits_charged} 个额度`,
      ) +
        (meta.credits_charged === 0 && meta.query_total_credits_charged === 1
          ? t(" · This research originally used 1 credit", " · 原查询已扣 1 个额度")
          : ""),
    );
  }
}

async function readResult(id) {
  const path = `/v1/sold/${id}`;
  const saved = safeId(current().searchParams.get("saved"));
  if (saved) {
    const { data } = await api(`/v1/saved-research/${saved}`);
    if (data.query_id !== id) throw new Error("not_found");
    const excluded = new Set(data.excluded_sale_event_ids);
    resultView(await api(path), {
      sort: "",
      excluded,
      summary: excluded.size
        ? t(`${excluded.size} saved exclusions restored`, `已恢复 ${excluded.size} 个保存的排除项`)
        : "",
    });
    return;
  }
  try {
    resultView(await api(path));
  } catch (error) {
    if (error.message !== "result_not_claimed") throw error;
    message(t("Result ready. Claiming may use one credit.", "结果已就绪，领取最多使用 1 个额度。"));
    const claim = button(t("Claim result", "领取结果"), async () => {
      claim.disabled = true;
      try {
        const user = await session();
        resultView(await post(`${path}/claim`, {}, user?.csrf_token, `web-claim-${id}`));
      } catch (failed) {
        // Resolve an uncertain response from the original result before permitting another claim.
        if (!failed.status || failed.status >= 500) {
          try {
            resultView(await api(path));
            return;
          } catch {
            /* Retain the same claim identity for an explicit retry. */
          }
        }
        report(failed);
        claim.disabled = false;
      }
    });
    actions.replaceChildren(claim);
  }
}

async function follow(job, id) {
  actions.replaceChildren();
  let version;
  let finished = false;
  const cancel = button(t("Cancel search", "取消查询"), () =>
    run(async () => {
      cancel.disabled = true;
      const expected = version;
      try {
        const receipt = await post(
          `/v1/jobs/${job}/cancel`,
          { version: expected },
          (await session())?.csrf_token,
          `web-cancel-${job}-${expected}`,
        );
        if (receipt.data.status === "cancelled") {
          finished = true;
          actions.replaceChildren();
          message(t("Search canceled. No credits charged.", "查询已取消，未扣费。"));
        }
      } catch (error) {
        if (error.status === 409) {
          const latest = (await api(`/v1/jobs/${job}`)).data;
          if (latest.status === "cancelled") {
            finished = true;
            actions.replaceChildren();
            message(t("Search canceled. No credits charged.", "查询已取消，未扣费。"));
            return;
          }
        }
        throw error;
      } finally {
        cancel.disabled = false;
      }
    }),
  );
  cancel.className = "btn ghost";
  try {
    message(
      t(
        "Checking the submitted search. Progress checks are free.",
        "正在查看已提交的查询进度，查询进度免费。",
      ),
    );
    for (let i = 0; i < 10; i++) {
      if (finished) return;
      const view = (await api(`/v1/jobs/${job}`)).data;
      if (finished) return;
      if (view.status === "completed") return readResult(id);
      if (!["queued", "running"].includes(view.status)) {
        actions.replaceChildren();
        message(
          t(
            `Search status · ${view.status === "cancelled" ? "Canceled" : view.status === "expired" ? "Expired" : "Failed"}`,
            `查询状态 · ${view.status === "cancelled" ? "已取消" : view.status === "expired" ? "已过期" : "失败"}`,
          ),
          "warning",
        );
        return;
      }
      if (!cancel.isConnected) actions.append(cancel);
      version = view.version;
      await new Promise((done) => setTimeout(done, 1500));
    }
    message(t("The search is still processing.", "查询仍在处理。"));
  } catch (error) {
    report(error);
    if (error.status === 401) {
      actions.replaceChildren(link(t("Sign in", "登录"), resume("/login")));
      return;
    }
    if (error.status && error.status !== 429 && error.status < 500) return;
  }
  actions.replaceChildren(button(t("Check progress", "查看进度"), () => run(() => follow(job, id))));
}

async function run(work) {
  try {
    await work();
  } catch (error) {
    report(error);
  }
}

if (search) {
  let busy = false;
  const submit = search.querySelector("button[type=submit]");
  const perform = async (work) => {
    if (busy) return;
    busy = true;
    submit.disabled = true;
    try {
      await run(work);
    } finally {
      busy = false;
      submit.disabled = false;
    }
  };
  const searchPath = ["/", "/playground", "/worth"].includes(page) ? page : "/search";
  const updateLinks = (draft, keepResult) => {
    for (const a of document.querySelectorAll("[data-resume]")) {
      a.href = resume(a.dataset.resume, draft, keepResult);
    }
    const alternate = document.querySelector("[data-language]");
    alternate.href = (zh ? "" : "/zh-CN") + resume(searchPath, draft, keepResult).slice(prefix.length);
  };
  const save = (draft, replace = false) => {
    const next = resume(searchPath, draft, false);
    const canonical = new URL(next, location.origin);
    for (const key of ["job", "result"]) {
      const value = safeId(draft.get(key));
      if (value) canonical.searchParams.set(key, value);
    }
    if (replace) history.replaceState(null, "", canonical);
    else history.pushState(null, "", canonical);
    updateLinks(draft, draft.has("result"));
  };
  search.addEventListener("input", () => {
    updateLinks(queryDraft(search), false);
  });
  search.addEventListener("submit", (event) => {
    event.preventDefault();
    perform(async () => {
      const draft = queryDraft(search);
      const input = {};
      for (const [name, value] of draft) {
        input[name] =
          name === "window_days" || name.endsWith("_cents")
            ? Number(value)
            : name === "allow_stale"
              ? true
              : value;
      }
      save(draft);
      if (trace) trace.querySelector("[data-trace-list]").replaceChildren();
      output.replaceChildren();
      const placeholder = document.querySelector("[data-hero-empty]");
      if (placeholder) placeholder.hidden = false;
      actions.replaceChildren();
      message(t("Submitting search…", "正在提交搜索…"));
      const user = await session();
      if (user?.mfa_required || (user && !user.email_verified)) {
        message(t("Finish account verification to continue.", "请先完成账户验证。"), "warning");
        actions.append(
          link(
            t("Continue verification", "继续验证"),
            resume(user.mfa_required ? "/login" : "/verify-email"),
          ),
        );
        return;
      }
      try {
        const result = await post("/web/search", input, user?.csrf_token);
        const job = safeId(result.data.job_id);
        const id = safeId(result.data.query_id);
        if (job && id) {
          draft.set("job", job);
          draft.set("result", id);
          save(draft, true);
          await follow(job, id);
        } else resultView(result);
      } catch (error) {
        if (!user && error.message === "source_unavailable") {
          actions.append(link(t("Create an account", "创建账户"), resume("/register")));
        }
        throw error;
      }
    });
  });
  addEventListener("popstate", () => location.reload());
  const id = safeId(document.body.dataset.resultId ?? current().searchParams.get("result"));
  const job = safeId(current().searchParams.get("job"));
  if (id)
    perform(async () => {
      try {
        if (job) await follow(job, id);
        else await readResult(id);
      } catch (error) {
        if (error.status === 401) actions.replaceChildren(link(t("Sign in", "登录"), resume("/login")));
        else if (!job && (!error.status || error.status === 429 || error.status >= 500)) {
          actions.replaceChildren(button(t("Retry result", "重试读取"), () => location.reload()));
        }
        throw error;
      }
    });
}

function authTarget() {
  return current().searchParams.has("q") || current().searchParams.has("result")
    ? resume("/search")
    : resume("/account");
}

for (const form of document.querySelectorAll("[data-auth]")) {
  if (form.elements.token && location.hash) {
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    if (/^[A-Za-z0-9_-]{32,128}$/.test(token ?? "")) form.elements.token.value = token;
    history.replaceState(null, "", location.pathname + location.search);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = form.querySelector("button");
    if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      const action = form.dataset.auth;
      const input = Object.fromEntries(new FormData(form));
      message(t("Submitting…", "正在提交…"));
      try {
        if (action === "login") {
          const { data } = await post("/auth/login", input);
          if (data.mfa_required) return showMfa();
          location.assign(data.email_verified ? authTarget() : resume("/verify-email"));
          return;
        }
        if (action === "register") {
          if (input.consent !== "on") return;
          const { email, password } = input;
          await post("/auth/register", { email, password, terms_version: "offline-testing-v1" });
          location.assign(resume("/verify-email"));
          return;
        }
        if (action === "verify-email") {
          await post("/auth/verify-email", input);
          const user = await session();
          location.assign(user?.email_verified && !user.mfa_required ? authTarget() : resume("/login"));
          return;
        }
        if (action === "resend" || action === "forgot-password") {
          await post(
            action === "resend" ? "/auth/verification/resend" : "/auth/password-reset/request",
            input,
          );
          message(
            t(
              "If eligible, a message was queued in the local test outbox.",
              "如符合条件，消息已加入本机测试发件箱。",
            ),
          );
          if (action === "forgot-password" && !actions.querySelector("[data-reset]")) {
            const reset = link(t("Enter reset code", "输入重置验证码"), resume("/reset-password"));
            reset.dataset.reset = "";
            actions.append(reset);
          }
          return;
        }
        if (action === "reset-password") {
          await post("/auth/password-reset/confirm", { token: input.token, new_password: input.password });
          location.assign(resume("/login"));
        }
      } finally {
        if (action !== "resend" && form.elements.password) form.elements.password.value = "";
        submit.disabled = false;
      }
    });
  });
}

function showMfa() {
  const form = document.querySelector('[data-auth="login"]');
  if (!form) return;
  form.hidden = true;
  message(t("Complete multi-factor authentication.", "请完成双重验证。"));
  const verify = element("form");
  const label = element("label", t("Authenticator or recovery code", "验证器或恢复码"));
  const input = element("input");
  input.required = true;
  input.autocomplete = "one-time-code";
  label.append(input);
  const control = element("button", t("Verify", "验证"), "btn brand");
  control.type = "submit";
  verify.append(label, control);
  verify.addEventListener("submit", (event) => {
    event.preventDefault();
    if (control.disabled) return;
    control.disabled = true;
    run(async () => {
      try {
        const user = await session();
        const code = input.value.trim();
        const result = await post(
          "/auth/mfa/verify",
          /^\d{6}$/.test(code) ? { totp_code: code } : { recovery_code: code },
          user?.csrf_token,
        );
        location.assign(result.data.email_verified ? authTarget() : resume("/verify-email"));
      } finally {
        input.value = "";
        control.disabled = false;
      }
    });
  });
  actions.replaceChildren(verify);
  input.focus();
}

if (page === "/login")
  run(async () => {
    if ((await session())?.mfa_required) showMfa();
  });

if (page === "/categories" || page === "/data-availability") {
  const labels = {
    cards_graded: t("Graded cards", "评级卡牌"),
    sneakers: t("Sneakers", "运动鞋"),
    watches: t("Watches", "腕表"),
    video_games: t("Video games", "电子游戏"),
    gpu_hardware: t("Graphics hardware", "显卡硬件"),
    collectibles: t("Collectibles", "收藏品"),
  };
  const freshness = {
    fresh: t("Recent approved observation", "近期获准观测"),
    stale_acceptable: t("Data delayed", "数据延迟"),
    expired: t("Observation window expired", "已超出可用时间窗口"),
    never_observed: t("Availability unknown", "可用性未知"),
    forbidden: t("Data unavailable", "数据不可用"),
  };
  const categories = page === "/categories";
  run(async () => {
    message(t("Loading…", "正在加载…"));
    const { data } = await api(`/v1/${categories ? "categories" : "data-status"}`);
    if (!data.length) {
      message(t("No categories have a public availability record yet.", "暂时没有可公开的类目可用性记录。"));
      return;
    }
    message("");
    for (const row of data) {
      const category = row.id ?? row.category;
      const card = element("section", undefined, "card");
      card.append(element("h2", labels[category] ?? row.name ?? category));
      card.append(element("p", freshness[row.availability ?? row.freshness_state]));
      if (row.data_as_of)
        card.append(element("p", `${t("Last observation", "最近有效观测")} · ${row.data_as_of}`, "small"));
      if (row.collector_status === "paused")
        card.append(element("p", t("Collection paused", "采集暂停"), "small"));
      if (categories)
        card.append(
          link(t("Category details", "类目详情"), `${prefix}/categories/${encodeURIComponent(category)}`),
        );
      if (categories && row.supported_windows.length) {
        card.append(
          element(
            "p",
            `${t("Supported windows", "可选查询窗口")} · ${row.supported_windows.join(" / ")} ${t("days", "天")}`,
            "small",
          ),
        );
        const params = new URLSearchParams({ category });
        card.append(link(t("Search this category", "查询本类目"), `${prefix}/search?${params}`));
      }
      output.append(card);
    }
  });
}

const docsSearch = document.querySelector("[data-docs-search]");
if (docsSearch) {
  const results = document.querySelector("[data-docs-results]");
  const submit = docsSearch.querySelector("button");
  docsSearch.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    results.hidden = false;
    results.replaceChildren(element("li", t("Searching…", "正在搜索…")));
    try {
      const params = new URLSearchParams(new FormData(docsSearch));
      const { data } = await api(`/docs/search?${params}`);
      results.replaceChildren();
      for (const item of data.items) {
        if (!/^\/docs\/(en|zh-CN)\/[a-z-]+$/.test(item.path)) continue;
        const row = element("li");
        row.append(link(item.title, item.path), element("p", item.excerpt, "small"));
        results.append(row);
      }
      if (!results.childElementCount)
        results.append(element("li", t("No matching documents.", "没有匹配的文档。")));
    } catch {
      results.replaceChildren(
        element("li", t("Search is unavailable. Try again.", "文档搜索暂不可用，请重试。")),
      );
    } finally {
      submit.disabled = false;
    }
  });
}

function privateReceipt() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function supportState(value) {
  return (
    {
      received: t("Received", "已受理"),
      in_progress: t("In progress", "处理中"),
      resolved: t("Resolved", "已处置"),
      closed: t("Closed", "已关闭"),
    }[value] ?? "—"
  );
}

const support = document.querySelector("[data-support]");
if (support) {
  let previous;
  const lookup = document.querySelector("[data-support-receipt]");
  const result = document.querySelector("[data-support-result]");
  support.addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = support.querySelector("button");
    if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      try {
        const values = new FormData(support);
        const ticket = { category: values.get("category"), message: values.get("message").trim() };
        const requestId = values.get("request_id").trim();
        if (requestId) ticket.request_id = requestId;
        const serialized = JSON.stringify(ticket);
        if (previous?.serialized !== serialized)
          previous = { serialized, key: crypto.randomUUID(), receipt: privateReceipt() };
        const csrf = (await session())?.csrf_token;
        const { data } = await api("/support/requests", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept-Language": document.documentElement.lang,
            "Idempotency-Key": previous.key,
            "X-Support-Receipt": previous.receipt,
            ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          },
          body: JSON.stringify(ticket),
        });
        message(t(`Request received · ${data.request_id}`, `已受理 · 工单编号 ${data.request_id}`));
        lookup.elements.receipt.value = previous.receipt;
        const label = element("label", t("Save this private receipt", "请保存此私密回执"));
        const receipt = element("input");
        receipt.readOnly = true;
        receipt.value = previous.receipt;
        label.append(receipt);
        result.replaceChildren(label);
      } finally {
        submit.disabled = false;
      }
    });
  });
  lookup.addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = lookup.querySelector("button");
    if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      try {
        const { data } = await api("/support/receipt", {
          headers: { "X-Support-Receipt": lookup.elements.receipt.value.trim() },
        });
        message(`${supportState(data.status)} · ${data.request_id}`);
        result.replaceChildren(
          element("h2", t("Request update", "工单进展")),
          element("p", data.reply ?? t("No reply yet.", "暂无回复。")),
          element("p", `${t("Receipt expires", "回执到期")} · ${data.expires_at}`, "small"),
        );
      } catch (error) {
        result.replaceChildren();
        if (error.status !== 404) throw error;
        message(t("This support receipt is unavailable.", "此工单回执不可用。"), "warning");
      } finally {
        submit.disabled = false;
      }
    });
  });
}

const contentForm = document.querySelector("[data-content-draft]");
if (contentForm) {
  let selected;
  let draftAttempt;
  const extras = [...contentForm.querySelectorAll("[data-content-extra]")];
  function syncContentFields(metadata = {}) {
    const option = contentForm.elements.kind.selectedOptions[0];
    const visible = option.dataset.fields?.split(" ") ?? [];
    const required = option.dataset.required?.split(" ") ?? [];
    for (const label of extras) {
      const name = label.dataset.contentExtra;
      const field = contentForm.elements[name];
      label.hidden = !visible.includes(name);
      field.disabled = label.hidden;
      field.required = required.includes(name);
      field.value = Array.isArray(metadata[name]) ? metadata[name].join(", ") : (metadata[name] ?? "");
    }
  }
  contentForm.elements.kind.addEventListener("change", () => syncContentFields());
  const labels = {
    submit: t("Submit for review", "送审"),
    approve: t("Approve", "批准"),
    publish: t("Publish", "发布"),
    schedule: t("Schedule publication", "安排发布"),
    cancel_schedule: t("Cancel schedule", "取消排程"),
    rollback: t("Restore version", "回滚版本"),
    unpublish: t("Unpublish", "撤下"),
  };
  const command = async (input, key) => {
    const { data } = await post("/admin/content/commands", input, (await session())?.csrf_token, key);
    message(t(`Change recorded · ${data.audit_id}`, `变更已记录 · ${data.audit_id}`));
    await loadContent();
  };
  async function loadContent() {
    const { data } = await api("/admin/content");
    output.replaceChildren();
    for (const row of data) {
      const card = element("article", undefined, "card result-card published-section");
      card.append(element("h2", row.body[document.documentElement.lang].title));
      const states = {
        draft: t("Draft", "草稿"),
        submitted: t("In review", "待审核"),
        approved: t("Approved", "已批准"),
      };
      card.append(
        element(
          "p",
          t(
            `${row.slug} · ${states[row.state]} · Active revision ${row.published_revision ?? "—"}`,
            `${row.slug} · ${states[row.state]} · 生效版本 ${row.published_revision ?? "—"}`,
          ),
          "small",
        ),
      );
      const preview = element("details");
      preview.append(element("summary", t("Preview both languages", "预览两个语言")));
      for (const locale of ["en", "zh-CN"]) {
        const section = element("div", undefined, "summary-note");
        section.lang = locale;
        section.append(element("h3", row.body[locale].title), element("p", row.body[locale].body));
        preview.append(section);
      }
      if (Object.keys(row.metadata).length)
        preview.append(element("pre", JSON.stringify(row.metadata, null, 2)));
      card.append(preview);
      const tools = element("div", undefined, "actions");
      tools.append(
        button(t("Edit latest", "编辑最新版本"), () => {
          selected = row;
          contentForm.elements.kind.value = row.kind;
          syncContentFields(row.metadata);
          contentForm.elements.slug.value = row.slug;
          for (const [field, locale] of [
            ["en", "en"],
            ["zh", "zh-CN"],
          ]) {
            contentForm.elements[`${field}_title`].value = row.body[locale].title;
            contentForm.elements[`${field}_body`].value = row.body[locale].body;
          }
          contentForm.elements.en_title.focus();
        }),
      );
      const action = (operation, revision, label = labels[operation], scheduleInput) => {
        const control = button(label, () =>
          run(async () => {
            const reason = contentForm.elements.reason.value.trim();
            if (!reason) {
              contentForm.elements.reason.reportValidity();
              contentForm.elements.reason.focus();
              return;
            }
            control.disabled = true;
            try {
              const schedule = scheduleInput?.value ? new Date(`${scheduleInput.value}Z`) : null;
              if (scheduleInput && (!schedule || !Number.isFinite(schedule.getTime()))) {
                scheduleInput.reportValidity();
                scheduleInput.focus();
                return;
              }
              await command(
                {
                  command: operation,
                  entry_id: row.id,
                  version: row.version,
                  revision,
                  reason,
                  ...(schedule ? { execute_at: schedule.toISOString() } : {}),
                },
                `content-${operation}-${row.id}-${row.version}-${revision}`,
              );
            } finally {
              control.disabled = false;
            }
          }),
        );
        control.className = "btn ghost";
        return control;
      };
      if (row.state === "draft") tools.append(action("submit", row.latest_revision));
      if (row.state === "submitted") tools.append(action("approve", row.latest_revision));
      const schedule = row.schedule;
      if (schedule) {
        const publicationStates = {
          pending: t("Scheduled", "已排程"),
          cancelled: t("Schedule cancelled", "排程已取消"),
          blocked: t("Scheduled publication blocked", "定时发布被阻断"),
          published: t("Published on schedule", "已按排程发布"),
        };
        const failure = {
          entry_changed: t("The entry or revision has changed.", "条目或修订已变更。"),
          operator_access_changed: t("An operator’s access has changed.", "运营人员的权限已变更。"),
        }[schedule.failure_code];
        const scheduledAt = new Date(schedule.execute_at).toISOString().slice(0, 16).replace("T", " ");
        card.append(
          element(
            "p",
            `${publicationStates[schedule.status]} · ${scheduledAt} UTC${failure ? ` · ${failure}` : ""}`,
            "summary-note",
          ),
        );
      }
      const releaseApproval = row.kind === "terms" || row.kind === "privacy";
      if (row.state === "approved" && releaseApproval)
        card.append(
          element("p", t("Awaiting separate legal release approval.", "等待独立政策发布批准。"), "notice"),
        );
      if (row.state === "approved" && !releaseApproval && row.latest_revision !== row.published_revision) {
        tools.append(action("publish", row.latest_revision));
        if (schedule?.status !== "pending") {
          const when = element("label", t("Publication time (UTC)", "发布时间（UTC）"));
          const datetime = element("input");
          datetime.type = "datetime-local";
          datetime.required = true;
          when.append(datetime);
          const fields = element("div", undefined, "key-form security-form");
          fields.append(when, action("schedule", row.latest_revision, labels.schedule, datetime));
          card.append(fields);
        }
      }
      if (schedule?.status === "pending") tools.append(action("cancel_schedule", schedule.revision));
      if (row.published_revision) tools.append(action("unpublish", row.published_revision));
      for (const revision of row.publication_history.slice(0, 8)) {
        if (!releaseApproval && revision !== row.published_revision)
          tools.append(action("rollback", revision, `${labels.rollback} ${revision}`));
      }
      card.append(tools);
      output.append(card);
    }
    if (!data.length) output.append(element("p", t("No content entries yet.", "暂无内容记录。"), "notice"));
  }
  contentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = contentForm.querySelector("button");
    if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      try {
        const fields = new FormData(contentForm);
        const kind = fields.get("kind"),
          slug = fields.get("slug").trim();
        const metadata = {};
        for (const label of extras) {
          const name = label.dataset.contentExtra;
          const value = fields.get(name)?.trim();
          if (!value) continue;
          if (name === "related")
            metadata.related = value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
          else if (name === "position") metadata.position = Number(value);
          else metadata[name] = value;
        }
        const input = {
          command: "draft",
          kind,
          slug,
          version: selected?.slug === slug && selected?.kind === kind ? selected.version : 0,
          body: {
            en: { title: fields.get("en_title"), body: fields.get("en_body") },
            "zh-CN": { title: fields.get("zh_title"), body: fields.get("zh_body") },
          },
          ...(Object.keys(metadata).length ? { metadata } : {}),
          reason: fields.get("reason"),
        };
        const shape = JSON.stringify(input);
        if (draftAttempt?.shape !== shape) draftAttempt = { shape, key: crypto.randomUUID() };
        await command(input, draftAttempt.key);
        draftAttempt = undefined;
        selected = undefined;
        contentForm.reset();
        syncContentFields();
      } finally {
        submit.disabled = false;
      }
    });
  });
  run(loadContent);
}

function accountTable(heading, columns, rows) {
  const card = element("section", undefined, "card result-card");
  card.append(element("h2", heading));
  if (!rows.length) {
    card.append(element("p", t("No records yet.", "暂无记录。"), "small"));
    return card;
  }
  const viewport = element("div", undefined, "table-scroll");
  viewport.tabIndex = 0;
  viewport.setAttribute("aria-label", heading);
  viewport.setAttribute("role", "region");
  const table = element("table");
  const head = table.createTHead().insertRow();
  for (const label of columns) head.append(element("th", label));
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) {
      const td = tr.insertCell();
      if (value instanceof HTMLElement) td.append(value);
      else td.textContent = value ?? "—";
    }
  }
  viewport.append(table);
  card.append(viewport);
  return card;
}

if (page === "/operations") {
  const operatorTabs = [...document.querySelectorAll("[data-ops-view]")];
  const reports = [
    "monitoring",
    "api",
    "collector",
    "records",
    "rules",
    "coverage",
    "quality",
    "growth",
    "costs",
  ];
  const recoveryTab = operatorTabs.find((item) => item.dataset.opsView === "recovery");
  const recoveryAccess = api("/admin/recovery", { method: "GET" })
    .then(({ data }) => {
      recoveryTab.hidden = !data.payment_fixtures_enabled;
      for (const tab of operatorTabs.filter((item) =>
        ["users", "approvals", "incidents", "settings", ...reports].includes(item.dataset.opsView),
      ))
        tab.hidden = false;
      return true;
    })
    .catch(() => false);
  let generation = 0;
  const operatorLink = (view, key, value) =>
    `${prefix}/operations/${view}?${new URLSearchParams({ [key]: value })}`;
  const stateLabel = (state) =>
    ({
      pending: t("Pending verification", "待核验"),
      active: t("Active", "正常"),
      suspended: t("Suspended", "已暂停"),
      deleted: t("Deleted", "已删除"),
      requested: t("Requested", "已申请"),
      approved: t("Approved", "已批准"),
      rejected: t("Rejected", "已拒绝"),
      executed: t("Executed", "已执行"),
      cancelled: t("Cancelled", "已取消"),
      open: t("Open", "未恢复"),
      monitoring: t("Monitoring", "观察中"),
      resolved: t("Resolved", "已解决"),
    })[state] ?? state;
  const approvalAction = (action) =>
    action === "suspend" ? t("Suspend account", "暂停账户") : t("Restore account", "恢复账户");
  const views = {
    users: {
      heading: t("Users", "用户"),
      columns: [
        t("Account", "账户"),
        t("Email hint", "邮箱提示"),
        t("State", "状态"),
        t("Created", "创建时间"),
      ],
      row: (user) => [
        link(user.id, operatorLink("users", "account", user.id)),
        user.email_hint,
        stateLabel(user.status),
        user.created_at,
      ],
    },
    approvals: {
      heading: t("Account approvals", "账户审批"),
      columns: [
        t("Account", "账户"),
        t("Action", "操作"),
        t("State", "状态"),
        t("Request and review", "申请与审校"),
        t("Reason", "原因"),
        t("Controls", "处理"),
      ],
      row: (entry) => {
        const history = element("div");
        history.append(element("p", entry.requested_at), element("p", entry.requested_by, "small"));
        if (entry.reviewed_at)
          history.append(element("p", entry.reviewed_at), element("p", entry.reviewed_by, "small"));
        if (entry.executed_at)
          history.append(element("p", entry.executed_at), element("p", entry.executed_by, "small"));
        const tools = element("div");
        const choices = [
          ...(entry.can_review
            ? [
                ["approve", t("Approve request", "批准申请")],
                ["reject", t("Reject request", "拒绝申请")],
              ]
            : []),
          ...(entry.state === "approved"
            ? [["execute", t("Execute approved action", "执行已批准操作")]]
            : []),
          ...(["requested", "approved"].includes(entry.state)
            ? [["cancel", t("Cancel request", "取消申请")]]
            : []),
        ];
        for (const [command, title] of choices)
          tools.append(
            recoveryForm("approvals", `/admin/approvals/${entry.id}/commands`, {
              title,
              confirmation: t("Confirm this audited approval action?", "确认执行此审批操作？"),
              fields: { command, version: entry.version },
              receipt: () => t("Approval updated", "审批已更新"),
            }),
          );
        return [
          link(entry.subject_user_id, operatorLink("users", "account", entry.subject_user_id)),
          approvalAction(entry.action),
          stateLabel(entry.state),
          history,
          entry.reason,
          tools,
        ];
      },
    },
    incidents: {
      heading: t("Incidents", "事件"),
      columns: [
        t("Title", "标题"),
        t("Component", "组件"),
        t("State", "状态"),
        t("Updated", "更新时间"),
        t("Controls", "操作"),
      ],
      row: (entry) => [
        link(entry.title, operatorLink("incidents", "incident", entry.id)),
        entry.component,
        stateLabel(entry.state),
        entry.updated_at,
        incidentControls(entry),
      ],
    },
    sources: {
      heading: t("Sources", "数据源"),
      columns: [
        t("Source ID", "来源 ID"),
        t("Clearance", "权利状态"),
        t("Circuit", "熔断状态"),
        t("Last observation", "最近观测"),
        t("Action", "操作"),
      ],
      row: (source, canWrite) => [
        source.source_id,
        source.clearance_status,
        source.circuit_status,
        source.last_data_as_of,
        canWrite ? sourceCommand(source) : null,
      ],
    },
    jobs: {
      heading: t("Jobs", "作业"),
      columns: [
        t("Job ID", "作业 ID"),
        t("Type", "类型"),
        t("State", "状态"),
        t("Attempts", "尝试次数"),
        t("Error", "错误码"),
        t("Updated", "更新时间"),
        t("Action", "操作"),
      ],
      row: (job, canWrite) => [
        job.id,
        job.kind,
        job.status,
        job.attempts,
        job.error_code,
        job.updated_at,
        canWrite && job.kind === "query" && job.status === "failed" && job.attempts < 3
          ? recoveryForm("jobs", `/admin/jobs/${job.id}/retry`, {
              title: t("Retry query job", "重排查询作业"),
              confirmation: t("Requeue this failed query?", "重新排队执行此失败查询？"),
              fields: { version: job.version },
              receipt: () => t("Query requeued", "查询已重新排队"),
            })
          : null,
      ],
    },
    billing: {
      heading: t("Reconciliation", "对账"),
      columns: [
        t("Charge ID", "扣费 ID"),
        t("Account reference", "账户引用"),
        t("Credits", "额度"),
        t("State", "状态"),
        t("Reconciliation", "对账"),
        t("Created", "创建时间"),
        t("Action", "操作"),
      ],
      row: (entry, canWrite) => [
        canWrite
          ? link(entry.charge_id, operatorLink("billing", "charge", entry.charge_id))
          : entry.charge_id,
        entry.user_ref,
        entry.credits,
        entry.state,
        entry.reconciliation_status,
        entry.created_at,
        canWrite && entry.state === "charged"
          ? recoveryForm("billing", `/admin/charges/${entry.charge_id}/refund-credit`, {
              title: t("Return search credit", "退回查询额度"),
              confirmation: t("Return this search credit to the account?", "向该账户退回本次查询额度？"),
              receipt: () => t("Credit compensation recorded", "额度补偿已记录"),
            })
          : null,
      ],
    },
    recovery: {
      heading: t("Late payment confirmations", "晚到付款确认"),
      columns: [
        t("Receipt ID", "收据 ID"),
        t("Provider", "渠道"),
        t("Attempts", "尝试次数"),
        t("Received", "接收时间"),
        t("Action", "操作"),
      ],
      row: (entry) => [
        entry.id,
        entry.provider,
        entry.attempts,
        entry.received_at,
        recoveryForm("recovery", `/admin/payments/events/${entry.id}/replay`, {
          title: t("Replay confirmation", "重放确认"),
          caseReference: true,
          confirmation: t("Check and apply this sandbox confirmation?", "核对并应用此沙盒付款确认？"),
          receipt: (outcome) =>
            ({
              applied: t("Confirmation applied", "付款确认已入账"),
              already_applied: t("Confirmation already applied", "付款确认已入账过"),
              manual_review: t("Manual review required", "需要人工复核"),
            })[outcome],
        }),
      ],
    },
    support: {
      heading: t("Support queue", "支持工单"),
      columns: [
        t("Request ID", "工单编号"),
        t("Issue type", "问题类型"),
        t("State", "状态"),
        t("Assignee reference", "处理人引用"),
        t("Due (UTC)", "截止时间（UTC）"),
        t("Action", "操作"),
      ],
      row: (entry) => [
        entry.id,
        {
          data_quality: t("Data quality", "数据质量"),
          takedown: t("Data rights or takedown", "数据权利或下架"),
          account: t("Account access", "账户访问"),
          billing: t("Billing", "账务"),
          other: t("Other", "其他"),
        }[entry.category],
        supportState(entry.status),
        entry.assigned_to_you ? t("You", "自己") : entry.assignee_ref,
        entry.due_at,
        entry.assigned_to_you || entry.status === "received" || entry.can_take_over
          ? supportCase(entry)
          : null,
      ],
    },
    audit: {
      heading: t("Audit log", "审计日志"),
      columns: [
        t("Action", "操作"),
        t("Object", "对象"),
        t("Request ID", "请求编号"),
        t("Operator reference", "操作者引用"),
        t("Date", "日期"),
      ],
      row: (entry) => [entry.action, entry.object_id, entry.request_id, entry.actor_ref, entry.created_at],
    },
  };
  function incidentControls(entry) {
    const tools = element("div");
    for (const state of ["open", "monitoring", "resolved"].filter((item) => item !== entry.state))
      tools.append(
        recoveryForm("incidents", `/admin/incidents/${entry.id}`, {
          title: stateLabel(state),
          confirmation: t("Update the internal incident?", "更新此内部事件？"),
          fields: { state, version: entry.version },
          receipt: () => t("Incident updated", "事件已更新"),
        }),
      );
    return tools;
  }
  function operatorForm(path, title, fields, after, values = {}) {
    const form = element("form", undefined, "key-form security-form");
    form.append(element("h2", title));
    for (const [name, labelText, maximum, currentValue] of fields) {
      const label = element("label", labelText);
      const input = element(Array.isArray(maximum) ? "select" : "input");
      if (Array.isArray(maximum)) {
        for (const value of maximum) {
          const option = element("option", value);
          option.value = value;
          input.append(option);
        }
      } else if (typeof maximum === "object") {
        input.type = "number";
        input.min = maximum.min;
        input.max = maximum.max;
        input.value = currentValue;
      } else input.maxLength = maximum;
      input.name = name;
      input.required = true;
      label.append(input);
      form.append(label);
    }
    const submit = element("button", title, "btn brand");
    submit.type = "submit";
    form.append(submit);
    let attempt;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(async () => {
        if (submit.disabled) return;
        submit.disabled = true;
        try {
          const input = { ...Object.fromEntries(new FormData(form)), ...values };
          for (const number of form.querySelectorAll("input[type=number]"))
            input[number.name] = number.valueAsNumber;
          const shape = JSON.stringify(input);
          if (attempt?.shape !== shape) attempt = { shape, key: crypto.randomUUID() };
          const { data } = await post(path, input, (await session())?.csrf_token, attempt.key);
          await after(data.audit_id);
        } finally {
          submit.disabled = false;
        }
      });
    });
    return form;
  }
  const reportLabels = {
    alerts: t("Local alerts", "本机告警"),
    requests: t("Requests", "请求"),
    collection_runs: t("Collection runs", "采集运行"),
    collector_supervision: t("Collector supervision", "采集监督"),
    collector_media_cleanup: t("Primary image cleanup", "主图清理"),
    collector_details: t("Item detail enrichment", "详情页补证队列"),
    details_queued: t("Details queued", "待抓取详页"),
    details_retry: t("Details retrying", "重试中详页"),
    details_running: t("Details running", "运行中详页"),
    details_completed: t("Details completed", "已完成详页"),
    details_failed: t("Details failed", "失败详页"),
    details_expired: t("Details expired", "过期详页"),
    details_attempts: t("Detail attempts", "详页尝试次数"),
    source_status: t("Source state", "来源状态"),
    active: t("Active", "生效"),
    suspended: t("Suspended", "已暂停"),
    disabled: t("Disabled", "已禁用"),
    revoked: t("Revoked", "已撤权"),
    media_cleanup_due: t("Image cleanups due", "到期主图清理任务"),
    oldest_media_cleanup_due: t("Oldest cleanup due", "最早待清理时间"),
    media_maintenance_status: t("Last media maintenance", "最近主图维护状态"),
    media_maintenance_checked_at: t("Last media maintenance check", "主图维护最近检查"),
    backlog_pending: t("Backlog pending", "积压待续清"),
    store_unmatched: t("Media directory unmatched", "媒体目录未匹配"),
    processed: t("Maintenance processed", "已处理清理"),
    idle: t("No due items", "无到期项"),
    phase: t("Phase", "阶段"),
    checked_at: t("Checked", "最近更新"),
    expected_progress_at: t("Next progress due", "最迟推进时间"),
    last_cycle_at: t("Last finished cycle", "最近完成轮次"),
    health_report_status: t("Health report status", "健康报告状态"),
    health_report_checked_at: t("Last health report check", "健康报告最近检查"),
    recorded: t("Recorded", "已留存"),
    recent: t("Recent report retained", "已沿用近期报告"),
    unavailable: t("Unavailable", "不可用"),
    failed: t("Failed", "失败"),
    job_id: t("Job ID", "作业 ID"),
    lane: t("Queue", "队列"),
    spool: t("Response directory", "响应包目录"),
    page_jobs_due: t("Pages due", "到期页面作业"),
    page_jobs_missing: t("Pages missing packs", "页面缺包"),
    page_jobs_uninspected: t("Pages unchecked", "页面未检查"),
    image_jobs_due: t("Image jobs due", "到期主图作业"),
    image_jobs_missing: t("Images missing packs", "主图缺包"),
    image_jobs_uninspected: t("Images unchecked", "主图未检查"),
    collector_schedule: t("Refresh scheduling", "刷新计划"),
    refresh_due_plans: t("Plans due", "待登记计划"),
    refresh_next_due_at: t("Next unregistered slot", "最早未登记时段"),
    refresh_pending_slots: t("Slots awaiting dispatch", "待派发时段"),
    refresh_overdue_slots: t("Overdue slots", "逾期待处理时段"),
    refresh_materialized: t("Slots registered last cycle", "上轮登记时段"),
    refresh_prioritized: t("Viable slots prioritized last cycle", "上轮优先登记的有效时段"),
    refresh_enqueued: t("Jobs queued last cycle", "上轮入队作业"),
    refresh_recovered: t("Jobs recovered last cycle", "上轮恢复作业"),
    refresh_blocked: t("Dispatches blocked last cycle", "上轮受阻派发"),
    refresh_missed: t("Expired slots closed last cycle", "上轮关闭的过期时段"),
    collector_run_evidence: t("Collection evidence at capture", "采集证据快照"),
    report_clock: t("Report clock", "报告时钟"),
    database: t("Database clock", "数据库时钟"),
    explicit_simulation: t("Simulated time", "模拟时钟"),
    evidence_window_start: t("Evidence starts at", "证据窗口起点"),
    evidence_planned_slots: t("Planned slots", "计划时段"),
    evidence_page_jobs_dispatched: t("Jobs with page dispatch", "已派发页面的作业"),
    evidence_page_jobs_on_time: t("Jobs with on-time page dispatch", "准时派发页面的作业"),
    evidence_claimed_without_page: t("Claimed without page dispatch", "已领取但无页面派发"),
    evidence_primary_observations: t("Sale observations", "成交观察总数"),
    evidence_eligible_primaries: t("Eligible primary images at capture", "快照时可读主图数"),
    collector_intake: t("Response intake", "响应包入站"),
    intake_status: t("Intake state", "入站状态"),
    intake_scanned: t("Directory entries checked", "已检查目录项"),
    intake_published: t("Packs recovered", "已恢复响应包"),
    intake_deferred: t("Packs deferred", "暂缓响应包"),
    scan_limit: t("Scan continues next cycle", "下轮继续扫描"),
    ready: t("Ready", "就绪"),
    sale_evidence: t("Sale evidence", "成交证据"),
    effective_versions: t("Effective versions", "生效版本"),
    observed_parsers: t("Observed parsers", "观测到的解析器"),
    source_coverage: t("Source watermarks", "来源水位"),
    snapshot_quality: t("Snapshot quality", "快照质量"),
    fixture_activity: t("Fixture activity", "合成活动"),
    budget_usage: t("Local budget usage", "本机预算用量"),
    commercial_costs: t("Commercial costs", "实际经营成本"),
    signal: t("Signal", "信号"),
    value: t("Value", "数值"),
    denominator: t("Denominator", "分母"),
    state: t("State", "状态"),
    channel: t("Channel", "渠道"),
    operation: t("Operation", "操作"),
    errors: t("Errors", "错误数"),
    credits: t("Credits", "额度"),
    p95_ms: t("p95 (ms)", "p95（毫秒）"),
    run_id: t("Run ID", "运行 ID"),
    source_id: t("Source ID", "来源 ID"),
    started_at: t("Started", "开始时间"),
    completed_at: t("Completed", "完成时间"),
    outcome: t("Outcome", "结果"),
    stop_reason: t("Stop reason", "停止原因"),
    pages: t("Pages", "页数"),
    bytes: t("Bytes", "字节"),
    unconfirmed_bytes: t("Unconfirmed bytes", "未确认字节"),
    parser_version: t("Parser version", "解析器版本"),
    event_id: t("Event ID", "成交事件 ID"),
    observation_id: t("Observation ID", "观测 ID"),
    captured_at: t("Captured", "观测时间"),
    kind: t("Format", "成交方式"),
    identity_status: t("Identity", "身份核验"),
    price_status: t("Price status", "价格核验"),
    title: t("Title", "标题"),
    primary_image: t("Primary image", "商品主图"),
    rule: t("Rule", "规则"),
    version: t("Version", "版本"),
    runs: t("Runs", "运行数"),
    last_seen: t("Last seen", "最近观测"),
    category: t("Category", "类目"),
    data_as_of: t("Data as of", "数据时点"),
    freshness: t("Freshness", "时效"),
    market_coverage: t("Market coverage", "市场覆盖"),
    collector_status: t("Collector state", "采集状态"),
    engine_version: t("Engine version", "统计版本"),
    cleaner_version: t("Cleaner version", "匹配版本"),
    snapshots: t("Snapshots", "快照"),
    observations: t("Observations", "观测"),
    comparables: t("Comparable samples", "可比样本"),
    verified_prices: t("Verified prices", "核验价格"),
    verified_accounts: t("Verified accounts", "已核验账户"),
    distinct_query_owners: t("Distinct query owners", "去重查询账户"),
    delivered_queries: t("Delivered queries", "已交付查询"),
    paid_conversion: t("Paid conversion", "付费转化"),
    retention: t("Retention", "留存"),
    day: t("UTC day", "UTC 日期"),
    unit: t("Unit", "单位"),
    cap: t("Limit", "上限"),
    used: t("Used", "已用"),
    reserved: t("Reserved", "已预留"),
    compute_cost: t("Compute cost", "计算成本"),
    network_cost: t("Network cost", "网络成本"),
    cost_per_usable_query: t("Cost per usable query", "单次有效查询成本"),
    overdue_query_jobs: t("Overdue query jobs", "超时排队作业"),
    overdue_collector_supervisors: t("Overdue collector supervisors", "未按时推进的采集监督进程"),
    scanning: t("Checking queue", "检查队列"),
    dispatching: t("Processing", "正在处理"),
    waiting: t("Waiting", "等待下轮"),
    stopped: t("Stopped", "已停止"),
    overdue: t("Overdue", "已超时"),
    unobserved: t("Unobserved", "未观测"),
    worker_heartbeat_age: t("Worker heartbeat age (s)", "Worker 心跳年龄（秒）"),
    collector_failure_percent: t("Unsuccessful collection runs (%)", "未成功采集运行（%）"),
    alert: t("Alert", "触发告警"),
    within_budget: t("Within threshold", "阈值以内"),
    unknown: t("Unknown", "未知"),
  };
  const reportLabel = (key) => (Object.hasOwn(reportLabels, key) ? reportLabels[key] : key);
  const reportFilters = (view) => {
    const scope = current().searchParams,
      out = new URLSearchParams();
    const days = scope.get("days") ?? "";
    if (/^[1-9][0-9]?$/.test(days) && Number(days) <= 30) out.set("days", days);
    if (
      ["collector", "records", "rules", "coverage", "quality", "costs"].includes(view) &&
      safeId(scope.get("source"))
    )
      out.set("source", scope.get("source"));
    if (view === "records" && safeId(scope.get("record"))) out.set("record", scope.get("record"));
    return out;
  };
  function renderReport(view, data) {
    const filters = reportFilters(view);
    const form = element("form", undefined, "actions");
    form.method = "GET";
    form.action = `${prefix}/operations/${view}`;
    const field = (name, text, type, value) => {
      const label = element("label", text);
      const input = element("input");
      input.name = name;
      input.type = type;
      input.value = value;
      if (type === "number") {
        input.min = 1;
        input.max = 30;
      } else {
        input.maxLength = 36;
        input.pattern = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
      }
      label.append(input);
      form.append(label);
    };
    field("days", t("Window in days", "窗口天数"), "number", filters.get("days") ?? "1");
    if (["collector", "records", "rules", "coverage", "quality", "costs"].includes(view))
      field("source", t("Filter by source ID", "按来源 ID 筛选"), "text", filters.get("source") ?? "");
    if (view === "records")
      field("record", t("Find event ID", "查找成交事件 ID"), "text", filters.get("record") ?? "");
    const apply = element("button", t("Apply filters", "应用筛选"), "btn ghost");
    apply.type = "submit";
    form.append(apply);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const scope = Object.fromEntries([...new FormData(form)].filter(([, value]) => value.trim()));
      location.assign(`${form.action}?${new URLSearchParams(scope)}`);
    });
    const card = element("section", undefined, "card result-card");
    card.append(
      element(
        "p",
        t(
          `Offline fixtures · ${data.range_start} to ${data.as_of}`,
          `离线合成数据 · ${data.range_start} 至 ${data.as_of}`,
        ),
      ),
    );
    card.append(form);
    output.append(card);
    const entries = Object.entries(data.alert_settings ?? {}).filter(([name]) => name !== "version");
    for (const group of data.sections) {
      const rows = group.rows.map((row) =>
        row.map((value, index) => {
          const column = group.columns[index];
          if (value === null) return reportLabel("unknown");
          if (column === "source_id" && safeId(value) && view !== "records")
            return link(value, operatorLink("records", "source", value));
          if (typeof value === "boolean") return value ? t("Yes", "有") : t("No", "无");
          return typeof value === "string" ? reportLabel(value) : value;
        }),
      );
      output.append(accountTable(reportLabel(group.key), group.columns.map(reportLabel), rows));
    }
    if (entries.length) {
      const settings = {
        heartbeat_stale_seconds: [t("Heartbeat alert after seconds", "心跳告警秒数"), 5, 1800],
        query_delay_seconds: [t("Query delay alert after seconds", "查询延迟告警秒数"), 5, 600],
        collector_failure_percent: [t("Collection failure alert percent", "采集失败比例告警阈值"), 1, 100],
      };
      const fields = entries.map(([name, current]) => {
        const [label, min, max] = settings[name];
        return [name, label, { min, max }, current];
      });
      fields.push(["reason", t("Reason", "原因"), 1000]);
      output.append(
        operatorForm(
          "/admin/alerts/commands",
          t("Save alert thresholds", "保存告警阈值"),
          fields,
          (audit) =>
            showView(
              "monitoring",
              undefined,
              `${t("Alert thresholds recorded", "告警阈值已记录")} · ${audit}`,
            ),
          { version: data.alert_settings.version },
        ),
      );
    }
  }
  function operatorDetail(view, data) {
    const card = element("section", undefined, "card result-card");
    if (view === "users") {
      const account = data.account;
      card.append(element("h2", t("User 360", "用户 360")));
      card.append(
        element("p", `${account.id} · ${account.email_hint ?? "—"} · ${stateLabel(account.status)}`),
      );
      card.append(
        accountTable(
          t("Account activity", "账户活动"),
          [t("Sessions", "会话"), t("API keys", "API 密钥"), t("Queries", "查询"), t("Payments", "付款")],
          [[data.sessions, data.api_keys, data.query_count, data.payment_count]],
        ),
      );
      if (!data.operator && ["active", "suspended"].includes(account.status)) {
        const action = account.status === "active" ? "suspend" : "restore";
        card.append(
          recoveryForm("approvals", `/admin/users/${account.id}/approvals`, {
            title: approvalAction(action),
            confirmation: t("Request an independent account review?", "提交独立账户审批？"),
            fields: { action, credential_version: account.credential_version },
            receipt: () => t("Approval requested", "已提交审批"),
          }),
        );
      }
      card.append(
        accountTable(
          t("Recent charges", "近期扣费"),
          [t("Charge", "扣费"), t("State", "状态"), t("Created", "创建时间")],
          data.charges.map((charge) => [
            link(charge.id, operatorLink("billing", "charge", charge.id)),
            charge.state,
            charge.created_at,
          ]),
        ),
      );
      card.append(
        accountTable(
          t("Recent payment records", "近期付款记录"),
          [t("Payment", "付款编号"), t("Provider", "渠道"), t("Amount", "金额"), t("State", "状态")],
          data.payments.map((payment) => [
            payment.id,
            payment.provider,
            amount(Number(payment.amount_cents)),
            payment.state,
          ]),
        ),
      );
      card.append(
        accountTable(
          t("Support requests", "支持工单"),
          [t("Request", "工单"), t("Category", "类别"), t("State", "状态")],
          data.tickets.map((ticket) => [ticket.id, ticket.category, supportState(ticket.status)]),
        ),
      );
      card.append(
        accountTable(
          t("Internal account notes", "内部账户笔记"),
          [t("Note", "笔记"), t("Created", "创建时间")],
          data.notes.map((note) => [note.content, note.created_at]),
        ),
      );
      if (account.status !== "deleted")
        card.append(
          operatorForm(
            `/admin/users/${account.id}/notes`,
            t("Save account note", "保存账户笔记"),
            [["content", t("Internal note", "内部笔记"), 1000]],
            (audit) =>
              showView("users", undefined, `${t("Account note saved", "已保存账户笔记")} · ${audit}`),
          ),
        );
    } else if (view === "incidents") {
      const entry = data.incident;
      card.append(
        element("h2", entry.title),
        element("p", `${entry.component} · ${stateLabel(entry.state)}`),
        incidentControls(entry),
      );
      card.append(
        accountTable(
          t("Incident timeline", "事件时间线"),
          [t("State", "状态"), t("Time", "时间"), t("Request ID", "请求编号")],
          data.timeline.map((event) => [stateLabel(event.state), event.created_at, event.request_id]),
        ),
      );
    } else {
      const charge = data.charge;
      card.append(
        element("h2", t("Charge detail", "扣费详情")),
        element("p", `${charge.id} · ${charge.state} · ${charge.created_at}`),
      );
      card.append(link(t("Open account", "查看账户"), operatorLink("users", "account", charge.user_id)));
      card.append(
        accountTable(
          t("Ledger entries", "账本流水"),
          [t("Entry", "流水号"), t("Type", "类型"), t("Delta", "变动"), t("Balance after", "变动后余额")],
          data.ledger.map((row) => [row.id, row.kind, row.delta, row.balance_after]),
        ),
      );
    }
    return card;
  }
  function supportCase(entry) {
    const panel = element("details");
    panel.append(
      element(
        "summary",
        entry.assigned_to_you
          ? t("Manage request", "处理工单")
          : entry.can_take_over
            ? t("Take over request", "接手工单")
            : t("Claim request", "领取工单"),
      ),
    );
    const details = element("div");
    if (entry.assigned_to_you) {
      panel.append(details);
      panel.addEventListener("toggle", async () => {
        if (!panel.open) {
          details.replaceChildren();
          return;
        }
        await run(async () => {
          const { data } = await api(`/admin/support/${entry.id}`);
          if (!panel.open) return;
          details.replaceChildren(element("p", data.message));
          if (data.related_request_id)
            details.append(
              element("p", `${t("Related request", "关联请求")} · ${data.related_request_id}`, "small"),
            );
          if (data.reply)
            details.append(element("p", `${t("Latest reply", "最近回复")} · ${data.reply}`, "small"));
        });
      });
    }
    const operation = entry.can_take_over
      ? ["take_over", t("Take over request", "接手工单")]
      : {
          received: ["claim", t("Claim request", "领取工单")],
          in_progress: ["resolve", t("Record reply and resolve", "回复并处置")],
          resolved: ["close", t("Close request", "关闭工单")],
          closed: ["reopen", t("Reopen request", "重开工单")],
        }[entry.status];
    if (!operation) return panel;
    const [command, title] = operation;
    const form = element("form", undefined, "key-form security-form");
    function field(name, label, control) {
      const wrapper = element("label", label);
      control.name = name;
      control.required = true;
      wrapper.append(control);
      form.append(wrapper);
      return control;
    }
    const reason = field("reason", t("Reason", "原因"), element("input"));
    reason.maxLength = 1000;
    if (["claim", "reopen", "take_over"].includes(command)) {
      const deadline = field("due_at", t("Deadline (UTC)", "截止时间（UTC）"), element("input"));
      deadline.type = "datetime-local";
    } else if (command === "resolve") {
      field("reply", t("Reply for the requester", "回复给提交人"), element("textarea")).maxLength = 2000;
    }
    const submit = element("button", title, "btn brand");
    form.append(submit);
    panel.append(form);
    let attempt;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      const request = generation;
      run(async () => {
        try {
          const input = { command, version: entry.version, reason: reason.value.trim() };
          if (form.elements.due_at) input.due_at = new Date(`${form.elements.due_at.value}Z`).toISOString();
          if (form.elements.reply) input.reply = form.elements.reply.value.trim();
          const shape = JSON.stringify(input);
          if (attempt?.shape !== shape) attempt = { shape, key: crypto.randomUUID() };
          const { data } = await post(
            `/admin/support/${entry.id}/commands`,
            input,
            (await session())?.csrf_token,
            attempt.key,
          );
          if (request === generation)
            await showView(
              "support",
              undefined,
              `${t("Support request updated · Audit ID", "工单已更新 · 审计编号")} ${data.audit_id}`,
            );
        } finally {
          submit.disabled = false;
        }
      });
    });
    return panel;
  }
  function recoveryForm(view, path, { title, confirmation, fields, caseReference, receipt }) {
    const tools = element("details");
    const form = element("form", undefined, "key-form security-form");
    const reasonLabel = element("label", t("Reason", "原因"));
    const reason = element("input");
    reason.required = true;
    reason.maxLength = 1000;
    reasonLabel.append(reason);
    form.append(reasonLabel);
    const reference = element("input");
    if (caseReference) {
      const referenceLabel = element("label", t("Case reference", "工单引用"));
      reference.required = true;
      reference.maxLength = 200;
      referenceLabel.append(reference);
      form.append(referenceLabel);
    }
    const submit = element("button", t("Run command", "执行操作"), "btn brand");
    form.append(submit);
    tools.append(element("summary", title), form);
    let attempt;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (submit.disabled || !confirm(confirmation)) return;
      submit.disabled = true;
      const request = generation;
      run(async () => {
        try {
          const data = {
            ...fields,
            reason: reason.value.trim(),
            ...(caseReference ? { case_reference: reference.value.trim() } : {}),
          };
          const shape = JSON.stringify(data);
          if (attempt?.shape !== shape) attempt = { shape, key: crypto.randomUUID() };
          const { data: result } = await post(path, data, (await session())?.csrf_token, attempt.key);
          if (request !== generation) return;
          const notice = `${receipt(result.outcome)} · ${t("Audit ID", "审计编号")} ${result.audit_id}`;
          await showView(view, undefined, notice);
        } catch (error) {
          if (request !== generation) return;
          if (error.message === "state_conflict") {
            message(
              t(
                "Current state or evidence does not allow this command. Check the record and try again.",
                "当前状态或证据不满足操作条件。请核对记录后重试。",
              ) + (error.reference ? ` · ${error.reference}` : ""),
              "warning",
            );
          } else throw error;
        } finally {
          submit.disabled = false;
        }
      });
    });
    return tools;
  }
  function sourceCommand(source) {
    const tools = element("details");
    if (source.clearance_status === "revoked") return t("Revoked", "已撤销");
    tools.append(element("summary", t("Source controls", "来源操作")));
    const form = element("form", undefined, "key-form security-form");
    const label = element("label", t("Action", "操作"));
    const action = element("select");
    for (const [value, text] of [
      ["probe", t("Check local readiness", "检查本机就绪")],
      ["suspend", t("Suspend collection", "暂停采集")],
      ["revoke", t("Revoke source rights", "撤销来源权限")],
    ]) {
      const option = element("option", text);
      option.value = value;
      action.append(option);
    }
    label.append(action);
    const inputs = [t("Reason", "原因"), t("Evidence reference", "证据引用")].map((text, index) => {
      const field = element("label", text);
      const input = element("input");
      input.required = true;
      input.maxLength = index === 0 ? 1000 : 200;
      field.append(input);
      return { field, input };
    });
    const [reason, evidence] = inputs;
    const submit = element("button", t("Run command", "执行操作"), "btn brand");
    let attempt;
    form.append(label, reason.field, evidence.field, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      if (
        action.value !== "probe" &&
        !confirm(t("Apply this change to the selected source?", "将此变更应用到选中的来源？"))
      )
        return;
      submit.disabled = true;
      run(async () => {
        try {
          const data = {
            command: action.value,
            reason: reason.input.value.trim(),
            evidence_ref: evidence.input.value.trim(),
            version: source.version,
          };
          const shape = JSON.stringify(data);
          if (attempt?.shape !== shape) attempt = { shape, key: crypto.randomUUID() };
          const result = await post(
            `/admin/sources/${source.source_id}/commands`,
            data,
            (await session())?.csrf_token,
            attempt.key,
          );
          await showView("sources");
          const probe = result.data.probe_status;
          message(
            probe
              ? t(
                  `Local readiness ${probe} · ${result.data.audit_id}`,
                  `本机就绪状态 ${probe} · ${result.data.audit_id}`,
                )
              : t(`Source updated · ${result.data.audit_id}`, `来源已更新 · ${result.data.audit_id}`),
          );
        } finally {
          submit.disabled = false;
        }
      });
    });
    tools.append(form);
    return tools;
  }
  async function showView(view, cursor, notice = "") {
    const request = ++generation;
    if (!cursor) {
      output.replaceChildren();
      message(notice || t("Loading…", "正在加载…"));
      for (const control of operatorTabs)
        control.setAttribute("aria-pressed", String(control.dataset.opsView === view));
    }
    try {
      if (reports.includes(view)) {
        const { data } = await api(`/admin/telemetry/${view}?${reportFilters(view)}`);
        if (request === generation) {
          message(notice);
          renderReport(view, data);
        }
        return;
      }
      const params = cursor ? `?${new URLSearchParams({ cursor })}` : "";
      const caseKey = { users: "account", incidents: "incident", billing: "charge" }[view];
      const caseId = caseKey ? safeId(current().searchParams.get(caseKey)) : null;
      const path = caseId
        ? `/admin/${view === "billing" ? "charges" : view}/${caseId}`
        : `/admin/${view}${params}`;
      const [response, canWrite] = await Promise.all([api(path), recoveryAccess]);
      if (request !== generation) return;
      if (caseId) {
        message(notice);
        output.append(operatorDetail(view, response.data));
        return;
      }
      if (view === "overview" || view === "settings") {
        const data = response.data;
        const summary =
          view === "overview"
            ? [
                [t("Active query jobs", "活动查询作业"), data.active_jobs],
                [t("Open support requests", "未结工单"), data.open_support],
                [t("Open incidents", "未解决事件"), data.open_incidents],
                [t("Pending approvals", "待执行审批"), data.pending_approvals],
              ]
            : [
                [t("Data mode", "数据模式"), data.data_mode],
                [
                  t("Live collection", "真实采集"),
                  data.collector_enabled ? t("Enabled", "启用") : t("Disabled", "关闭"),
                ],
                [t("Payments mode", "支付模式"), data.payments_mode],
                [
                  t("Payment fixtures", "支付沙盒"),
                  data.payment_fixtures_enabled ? t("Enabled", "启用") : t("Disabled", "关闭"),
                ],
              ];
        message(notice);
        output.append(
          accountTable(
            view === "overview" ? t("Operations overview", "运营概览") : t("Effective settings", "生效设置"),
            [t("Item", "项目"), t("Value", "数值")],
            [...summary, [t("As of", "截至"), data.as_of]],
          ),
        );
        return;
      }
      const { heading, columns, row } = views[view];
      const data = response.data;
      const rows = Array.isArray(data) ? data : data.items;
      const card = accountTable(
        heading,
        columns,
        rows.map((entry) => row(entry, canWrite)),
      );
      if (data.next_cursor) {
        const next = button(t("Load more", "加载更多"), () =>
          run(async () => {
            next.disabled = true;
            try {
              await showView(view, data.next_cursor);
              next.remove();
            } finally {
              next.disabled = false;
            }
          }),
        );
        card.append(next);
      }
      message(notice);
      if (!cursor && view === "incidents")
        output.append(
          operatorForm(
            "/admin/incidents",
            t("Open incident", "登记事件"),
            [
              ["component", t("Component", "组件"), ["api", "collector", "query", "payments", "support"]],
              ["title", t("Incident title", "事件标题"), 140],
              ["reason", t("Reason", "原因"), 1000],
            ],
            (audit) =>
              showView("incidents", undefined, `${t("Incident registered", "已登记事件")} · ${audit}`),
          ),
        );
      output.append(card);
    } catch (error) {
      if (request !== generation) return;
      if (error.status === 401 || error.message === "reauthentication_required")
        output.append(link(t("Sign in again", "重新登录"), `${prefix}/login`));
      if (notice) {
        output.append(
          element("p", t("Unable to refresh. Open this tab again.", "刷新失败，请重新打开此标签页。")),
        );
        return;
      }
      throw error;
    }
  }
  for (const button of operatorTabs)
    button.addEventListener("click", () =>
      run(() => {
        history.pushState(null, "", `${prefix}/operations/${button.dataset.opsView}`);
        return showView(button.dataset.opsView);
      }),
    );
  addEventListener("popstate", () => location.reload());
  const initial = document.querySelector("[data-ops-tabs]").dataset.panel;
  run(() => showView(operatorTabs.some((tab) => tab.dataset.opsView === initial) ? initial : "overview"));
}

async function showUsage() {
  const { data } = await api("/v1/usage");
  const labels = {
    grant: t("Credits granted", "额度入账"),
    consume: t("Search charge", "查询扣费"),
    expire: t("Credits expired", "额度到期"),
    refund: t("Credit refund", "额度退回"),
  };
  output.append(
    accountTable(
      t("Credit buckets", "额度桶"),
      [t("Type", "类型"), t("Balance", "余额"), t("Expires", "到期")],
      data.wallets.map((row) => [row.type, row.balance, row.expires_at]),
    ),
  );
  output.append(
    accountTable(
      t("Latest credit entries", "最近额度流水"),
      [t("Date", "日期"), t("Action", "操作"), t("Change", "变动"), t("Balance after", "变更后余额")],
      data.ledger.map((row) => [row.created_at, labels[row.kind] ?? row.kind, row.delta, row.balance_after]),
    ),
  );
}

function billingPlanName(plan) {
  return { starter: "Starter", pro: "Pro", purchased_1500: t("Credit pack", "额度包") }[plan] ?? plan;
}

if (page === "/pricing") {
  const state = document.querySelector("[data-pricing-state]");
  const offers = document.querySelector("[data-pricing-offers]");
  const actions = document.querySelector("[data-pricing-actions]");
  run(async () => {
    const user = await session();
    if (!user) return;
    actions.lastElementChild.replaceWith(
      link(t("View account billing", "查看账单"), `${prefix}/account/billing`),
    );
    if (!user.email_verified || user.mfa_required) return;
    let preview;
    try {
      preview = (await api("/billing/offers")).data;
    } catch (error) {
      if (error.status === 503 || error.status === 401 || error.status === 403) return;
      throw error;
    }
    if (preview.data_mode !== "offline_fixture" || !preview.offers.length) return;
    state.textContent = t("Sandbox preview. Amounts are for testing.", "沙盒预览，金额仅用于测试。");
    const credits = new Intl.NumberFormat(document.documentElement.lang);
    for (const offer of preview.offers) {
      const card = element("article", undefined, "card result-card pricing-offer");
      card.dataset.plan = offer.plan_code;
      card.append(
        element("h3", billingPlanName(offer.plan_code)),
        element("p", amount(offer.amount_cents), "price-amount"),
        element(
          "p",
          offer.kind === "subscription"
            ? t("Monthly test subscription", "按月测试订阅")
            : t("One-time test purchase", "一次性测试购买"),
        ),
        element("p", `${credits.format(offer.credits)} ${t("credits", "额度")}`),
        link(
          t("Open test checkout", "打开测试结账"),
          `${prefix}/account/billing?${new URLSearchParams({ plan: offer.plan_code })}`,
        ),
      );
      offers.append(card);
    }
  });
}

async function showBilling() {
  let data, prices, transactions;
  try {
    const [subscription, offers, payments] = await Promise.all([
      api("/billing/subscription"),
      api("/billing/offers"),
      api("/billing/payments"),
    ]);
    data = subscription.data;
    prices = offers.data;
    transactions = payments.data;
  } catch (error) {
    if (error.status !== 503) throw error;
    message(
      t(
        "Payment sandbox is unavailable. Your credits and usage are available separately.",
        "支付沙盒暂不可用。仍可在用量页查看额度及扣费。",
      ),
    );
    output.replaceChildren(link(t("View usage", "查看用量"), `${prefix}/account/usage`));
    return;
  }
  const labels = {
    pending: t("Awaiting confirmation", "等待确认"),
    free: t("Free", "免费"),
    active: t("Active", "生效中"),
    succeeded: t("Succeeded", "已成功"),
    refunded: t("Refunded", "已退款"),
    failed: t("Failed", "失败"),
    expired: t("Expired", "已过期"),
    disputed: t("Disputed", "有争议"),
    awaiting_reconciliation: t("Awaiting reconciliation", "等待对账"),
    confirmed: t("Confirmed", "已确认"),
  };
  const subscriptionCard = element("section", undefined, "card result-card");
  subscriptionCard.append(element("h2", t("Subscription", "订阅")));
  subscriptionCard.append(
    element("p", `${billingPlanName(data.plan_code)} · ${labels[data.status] ?? data.status}`),
  );
  if (data.current_period_end)
    subscriptionCard.append(
      element("p", `${t("Current period ends", "本期结束")} · ${data.current_period_end}`, "small"),
    );
  if (data.cancel_at_period_end)
    subscriptionCard.append(
      element("p", t("Scheduled to end after this period.", "订阅将在本期结束后取消。")),
    );
  else if (data.version) {
    const cancel = button(t("Cancel at period end", "本期结束后取消"), () =>
      run(async () => {
        if (!confirm(t("End renewal after the current billing period?", "本期结束后停止续费？"))) return;
        cancel.disabled = true;
        try {
          await post("/billing/cancel", { version: data.version }, (await session())?.csrf_token);
          await showBilling();
        } finally {
          cancel.disabled = false;
        }
      }),
    );
    cancel.className = "btn ghost";
    subscriptionCard.append(cancel);
  }
  const checkout = element("section", undefined, "card result-card");
  checkout.append(
    element("h2", t("Test checkout", "测试结账")),
    element(
      "p",
      t(
        "These sandbox offers use fixture amounts. No real payment is collected.",
        "以下为沙盒测试报价，使用合成金额。此处不会收取实际款项。",
      ),
    ),
  );
  const chooser = element("label", t("Payment provider", "支付渠道"));
  const provider = element("select");
  for (const choice of prices.providers) {
    const option = element("option", choice === "stripe" ? "Stripe" : "PayPal");
    option.value = choice;
    provider.append(option);
  }
  chooser.append(provider);
  checkout.append(chooser);
  const currentOrder = element("div", undefined, "summary-note");
  const checkoutId = safeId(current().searchParams.get("checkout"));
  async function checkOrder(id) {
    const { data } = await api(`/billing/checkout/${id}`);
    currentOrder.replaceChildren(
      element("p", `${data.provider} · ${amount(data.amount_cents)} · ${labels[data.status] ?? data.status}`),
    );
    currentOrder.append(
      button(t("Refresh order", "刷新订单"), () =>
        run(async () => {
          await showBilling();
        }),
      ),
    );
  }
  const actions = element("div", undefined, "actions");
  const keys = new Map();
  const selected = element("p", undefined, "summary-note");
  selected.hidden = true;
  checkout.append(selected);
  function selectOffer(offer) {
    if (!offer) return;
    selected.hidden = false;
    selected.textContent = `${t("Selected test offer", "选中的测试报价")} · ${billingPlanName(offer.plan_code)} · ${amount(offer.amount_cents)}`;
    const url = current();
    const params = new URLSearchParams({ plan: offer.plan_code });
    const existing = safeId(url.searchParams.get("checkout"));
    if (existing) params.set("checkout", existing);
    url.search = params.toString();
    history.replaceState(null, "", url);
    const alternate = document.querySelector("[data-language]");
    alternate.href = `${zh ? "" : "/zh-CN"}/account/billing${url.search}`;
  }
  selectOffer(prices.offers.find((offer) => offer.plan_code === current().searchParams.get("plan")));
  for (const offer of prices.offers) {
    const buttonLabel = `${billingPlanName(offer.plan_code)} · ${amount(offer.amount_cents)} · ${offer.credits} ${t("credits", "额度")}`;
    const start = button(buttonLabel, () =>
      run(async () => {
        const channel = provider.value;
        if (
          !confirm(
            t(
              `Create a ${channel} test checkout for ${amount(offer.amount_cents)}?`,
              `创建 ${channel} 的 ${amount(offer.amount_cents)} 测试订单？`,
            ),
          )
        )
          return;
        selectOffer(offer);
        start.disabled = true;
        const request = {
          plan_code: offer.plan_code,
          offer_version: prices.offer_version,
          provider: channel,
        };
        const shape = JSON.stringify(request);
        if (!keys.has(shape)) keys.set(shape, crypto.randomUUID());
        try {
          const { data } = await post(
            "/billing/checkout",
            request,
            (await session())?.csrf_token,
            keys.get(shape),
          );
          const route = new URL(data.checkout_url, location.origin);
          const id = safeId(/^\/billing\/checkout\/([^/]+)$/.exec(route.pathname)?.[1]);
          if (route.origin !== location.origin || !id) throw new Error("forbidden");
          const url = current();
          url.searchParams.set("checkout", id);
          history.replaceState(null, "", url);
          const alternate = document.querySelector("[data-language]");
          alternate.href = `${zh ? "" : "/zh-CN"}/account/billing${url.search}`;
          await checkOrder(id);
        } finally {
          start.disabled = false;
        }
      }),
    );
    actions.append(start);
  }
  checkout.append(actions, currentOrder);
  output.replaceChildren(
    subscriptionCard,
    checkout,
    accountTable(
      t("Payments and refunds", "付款与退款"),
      [
        t("Date", "日期"),
        t("Provider", "渠道"),
        t("Amount", "金额"),
        t("Refund", "退款"),
        t("Status", "状态"),
      ],
      transactions.items.map((row) => [
        row.created_at,
        row.provider,
        amount(row.amount_cents),
        amount(row.refunded_cents),
        labels[row.status] ?? row.status,
      ]),
    ),
  );
  if (checkoutId) await checkOrder(checkoutId);
}

async function showLogs(cursor) {
  const params = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  const { data } = await api(`/v1/requests${params}`);
  const card = accountTable(
    t("Requests", "请求"),
    [
      t("Date", "日期"),
      t("Operation", "操作"),
      t("Status", "状态"),
      t("Credits", "额度"),
      t("Request ID", "请求编号"),
    ],
    data.items.map((row) => [
      row.created_at,
      row.operation,
      `${row.http_status}${row.error_code ? ` · ${row.error_code}` : ""}`,
      row.credits_charged,
      row.request_id,
    ]),
  );
  if (data.next_cursor) {
    const more = button(t("Load more", "加载更多"), () =>
      run(async () => {
        more.disabled = true;
        try {
          await showLogs(data.next_cursor);
          more.remove();
        } finally {
          more.disabled = false;
        }
      }),
    );
    card.append(more);
  }
  output.append(card);
}

async function showKeys() {
  const { data } = await api("/v1/keys");
  const setup = element("section", undefined, "card result-card");
  setup.append(element("h2", t("Create an API key", "创建 API 密钥")));
  const form = element("form", undefined, "key-form");
  const label = element("label", t("Key name", "密钥名称"));
  const name = element("input");
  name.name = "name";
  name.maxLength = 80;
  name.required = true;
  label.append(name);
  const scopes = element("fieldset");
  scopes.append(element("legend", t("Scopes", "权限范围")));
  for (const scope of ["sold:read", "jobs:read", "usage:read"]) {
    const check = element("input");
    check.type = "checkbox";
    check.name = "scopes";
    check.value = scope;
    check.checked = scope === "sold:read";
    const entry = element("label");
    entry.append(check, scope);
    scopes.append(entry);
  }
  const submit = element("button", t("Create key", "创建密钥"), "btn brand");
  const secret = element("div");
  secret.setAttribute("aria-live", "polite");
  let attempt;
  const saveKey = async (path, input, idempotency) => {
    const { data } = await post(path, input, (await session())?.csrf_token, idempotency);
    secret.replaceChildren();
    if (data.key) {
      const value = element("input");
      value.value = data.key;
      value.readOnly = true;
      value.setAttribute("aria-label", t("New key shown once", "仅显示一次的新密钥"));
      value.addEventListener("focus", () => value.select());
      secret.append(
        value,
        button(t("Hide key", "隐藏密钥"), () => secret.replaceChildren()),
      );
      value.focus();
    } else
      secret.append(
        element(
          "p",
          t(
            "The command succeeded earlier. Rotate the key if you need a new secret.",
            "操作此前已成功。需要新密钥时请轮换。",
          ),
        ),
      );
    await refreshKeys();
  };
  form.append(label, scopes, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      try {
        const values = new FormData(form);
        const input = { name: values.get("name").trim(), scopes: values.getAll("scopes") };
        const shape = JSON.stringify(input);
        if (attempt?.shape !== shape) attempt = { shape, key: crypto.randomUUID() };
        await saveKey("/v1/keys", input, attempt.key);
        attempt = undefined;
        form.reset();
      } finally {
        submit.disabled = false;
      }
    });
  });
  setup.append(form, secret);
  const list = element("div");
  const refreshKeys = async (rows) => {
    const keys = rows ?? (await api("/v1/keys")).data;
    list.replaceChildren(
      accountTable(
        t("Your API keys", "你的 API 密钥"),
        [
          t("Name", "名称"),
          t("Prefix", "前缀"),
          t("Scopes", "权限"),
          t("Last used", "上次使用"),
          t("Actions", "操作"),
        ],
        keys.map((row) => {
          const controls = element("div", undefined, "actions");
          if (row.revoked_at) controls.append(t("Revoked", "已撤销"));
          else {
            const id = safeId(row.id);
            const key = crypto.randomUUID();
            controls.append(
              button(t("Rotate", "轮换"), () =>
                run(async () => {
                  if (
                    confirm(
                      t("Rotate this key? The old key will be revoked.", "轮换此密钥？旧密钥将被撤销。"),
                    )
                  )
                    await saveKey(`/v1/keys/${id}/rotate`, { name: row.name, scopes: row.scopes }, key);
                }),
              ),
              button(t("Revoke", "撤销"), () =>
                run(async () => {
                  if (
                    !confirm(
                      t("Revoke this key? Calls using it will fail.", "撤销此密钥？使用它的调用将失败。"),
                    )
                  )
                    return;
                  await api(`/v1/keys/${id}`, {
                    method: "DELETE",
                    headers: { "X-CSRF-Token": (await session())?.csrf_token ?? "" },
                  });
                  secret.replaceChildren();
                  await refreshKeys();
                }),
              ),
            );
          }
          return [row.name, row.prefix, row.scopes.join(", "), row.last_used_at, controls];
        }),
      ),
    );
  };
  output.append(setup, list);
  await refreshKeys(data);
}

function securityForm(title, fields, action, onSuccess) {
  const form = element("form", undefined, "key-form security-form");
  for (const { name, label, type = "password", optional = false, autocomplete } of fields) {
    const field = element("label", label);
    const input = element("input");
    input.name = name;
    input.type = type;
    input.required = !optional;
    input.autocomplete = autocomplete ?? "current-password";
    if (type === "text") {
      input.inputMode = "numeric";
      input.pattern = "[0-9]{6}";
    }
    field.append(input);
    form.append(field);
  }
  const submit = element("button", title, "btn brand");
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    run(async () => {
      try {
        const data = Object.fromEntries([...new FormData(form)].filter(([, value]) => value !== ""));
        const result = await post(action, data, (await session())?.csrf_token);
        await onSuccess(result.data);
      } finally {
        form.reset();
        submit.disabled = false;
      }
    });
  });
  return form;
}

function deletionStatus(receipt) {
  return api("/account/deletion-requests/by-receipt", { headers: { "X-Deletion-Receipt": receipt } });
}

const receiptForm = document.querySelector("[data-deletion-receipt]");
if (receiptForm)
  receiptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      const value = receiptForm.elements.receipt.value.trim();
      const { data } = await deletionStatus(value);
      const labels = {
        requested: t("Deletion requested", "已申请删除"),
        processing: t("Deletion in progress", "正在删除"),
        completed: t("Deletion complete", "已完成删除"),
      };
      message(`${labels[data.state] ?? data.state} · ${data.request_id}`);
    });
  });

function accountDeletion() {
  const card = element("section", undefined, "card result-card");
  card.append(element("h2", t("Delete account", "删除账户")));
  card.append(
    element(
      "p",
      t(
        "Deletion ends your sessions and revokes account access, API keys and shares. Required billing and audit records are retained.",
        "删除会结束登录会话并撤销账户、密钥与分享访问。必要的账务和审计记录会保留。",
      ),
    ),
  );
  const prepare = button(t("Prepare deletion", "准备删除"), () => {
    prepare.disabled = true;
    const receipt = privateReceipt();
    const label = element(
      "label",
      t("Save this private receipt to view deletion status later", "请保存此私密回执，以后可查询删除状态"),
    );
    const value = element("input");
    value.readOnly = true;
    value.value = receipt;
    value.addEventListener("focus", () => value.select());
    label.append(value);
    const submit = button(t("Confirm account deletion", "确认删除账户"), () =>
      run(async () => {
        if (!confirm(t("Permanently delete this account?", "永久删除此账户？"))) return;
        submit.disabled = true;
        let id;
        try {
          const { data } = await post(
            "/account/deletion-requests",
            { confirm: true, receipt_token: receipt },
            (await session())?.csrf_token,
          );
          id = data.request.request_id;
        } catch (failure) {
          try {
            id = (await deletionStatus(receipt)).data.request_id;
          } catch {
            submit.disabled = false;
            throw failure;
          }
        }
        controls.remove();
        for (const section of output.children) {
          if (section !== card) section.hidden = true;
        }
        message(t(`Deletion requested · ${id}`, `已申请删除 · ${id}`));
      }),
    );
    const controls = element("div", undefined, "actions");
    controls.append(
      submit,
      button(t("Cancel", "取消"), () => {
        label.remove();
        controls.remove();
        prepare.disabled = false;
        prepare.focus();
      }),
    );
    card.append(label, controls);
    value.focus();
  });
  card.append(prepare, link(t("Check a deletion receipt", "查询删除回执"), `${prefix}/deletion-receipt`));
  return card;
}

async function showAccountSecurity(codes) {
  const [sessions, mfa] = await Promise.all([api("/account/sessions"), api("/account/mfa")]);
  output.replaceChildren();
  const state = element("section", undefined, "card result-card");
  state.append(element("h2", t("Two-factor authentication", "双重验证")));
  const statusText = mfa.data.enabled
    ? t("Authenticator enabled", "验证器已启用")
    : t("Authenticator disabled", "验证器未启用");
  state.append(element("p", statusText));
  const oneTime = element("div", undefined, "security-secrets");
  oneTime.setAttribute("aria-live", "polite");
  function showCodes(codes) {
    oneTime.replaceChildren(element("h3", t("Save these one-time recovery codes", "请保存这些一次性恢复码")));
    const list = element("ul");
    for (const code of codes) list.append(element("li", code));
    oneTime.append(
      list,
      button(t("Hide recovery codes", "隐藏恢复码"), () => oneTime.replaceChildren()),
    );
  }
  if (mfa.data.enabled) {
    state.append(
      element(
        "p",
        t(
          `${mfa.data.recovery_codes_remaining} unused recovery codes`,
          `剩余 ${mfa.data.recovery_codes_remaining} 个恢复码`,
        ),
        "small",
      ),
    );
    const regenerate = button(t("Replace recovery codes", "更换恢复码"), () =>
      run(async () => {
        if (!confirm(t("Replace all unused recovery codes?", "更换全部未使用的恢复码？"))) return;
        regenerate.disabled = true;
        try {
          const { data } = await post("/account/mfa/recovery-codes", {}, (await session())?.csrf_token);
          showCodes(data.recovery_codes);
        } finally {
          regenerate.disabled = false;
        }
      }),
    );
    state.append(regenerate);
    if (!mfa.data.required) {
      const disable = button(t("Disable authenticator", "停用验证器"), () =>
        run(async () => {
          if (!confirm(t("Disable the authenticator and sign out?", "停用验证器并退出登录？"))) return;
          await api("/account/mfa", {
            method: "DELETE",
            headers: { "X-CSRF-Token": (await session())?.csrf_token ?? "" },
          });
          location.assign(`${prefix}/login`);
        }),
      );
      disable.className = "btn ghost";
      state.append(disable);
    }
  } else {
    const enable = button(t("Set up authenticator", "设置验证器"), () =>
      run(async () => {
        enable.disabled = true;
        try {
          const { data } = await post("/account/mfa/setup", {}, (await session())?.csrf_token);
          const code = element("code", data.secret);
          const proof = securityForm(
            t("Activate authenticator", "启用验证器"),
            [
              {
                name: "totp_code",
                label: t("Authenticator code", "验证器验证码"),
                type: "text",
                autocomplete: "one-time-code",
              },
            ],
            "/account/mfa/confirm",
            (result) => showAccountSecurity(result.recovery_codes),
          );
          oneTime.replaceChildren(
            element(
              "p",
              t(
                "Enter this secret into your authenticator, then enter its current code.",
                "将此密钥输入验证器，再填写当前验证码。",
              ),
            ),
            code,
            proof,
          );
        } finally {
          enable.disabled = false;
        }
      }),
    );
    state.append(enable);
  }
  if (codes) showCodes(codes);
  state.append(oneTime);

  const signIns = accountTable(
    t("Active sessions", "活动会话"),
    [t("Device", "设备"), t("Started", "开始时间"), t("Expires", "到期"), t("Actions", "操作")],
    sessions.data.map((row) => {
      const revoke = button(
        row.is_current ? t("Sign out", "退出登录") : t("Revoke session", "撤销会话"),
        () =>
          run(async () => {
            if (!confirm(t("End this session?", "结束此会话？"))) return;
            await api(`/account/sessions/${row.id}`, {
              method: "DELETE",
              headers: { "X-CSRF-Token": (await session())?.csrf_token ?? "" },
            });
            if (row.is_current) location.assign(`${prefix}/login`);
            else await showAccountSecurity();
          }),
      );
      return [
        row.is_current ? `${row.device_label} · ${t("Current", "当前")}` : row.device_label,
        row.created_at,
        row.expires_at,
        revoke,
      ];
    }),
  );
  const credentials = element("section", undefined, "card result-card");
  credentials.append(element("h2", t("Reauthenticate", "重新认证")));
  const password = { name: "password", label: t("Password", "密码") };
  const authFields = mfa.data.enabled
    ? [
        password,
        {
          name: "totp_code",
          label: t("Authenticator code", "验证器验证码"),
          type: "text",
          autocomplete: "one-time-code",
        },
      ]
    : [password];
  credentials.append(
    securityForm(t("Verify identity", "验证身份"), authFields, "/auth/reauthenticate", () =>
      message(t("Identity verified.", "身份已验证。")),
    ),
  );
  credentials.append(element("h2", t("Change password", "修改密码")));
  credentials.append(
    securityForm(
      t("Update password", "更新密码"),
      [
        { name: "current_password", label: t("Current password", "当前密码") },
        { name: "new_password", label: t("New password", "新密码"), autocomplete: "new-password" },
      ],
      "/account/password",
      () => location.assign(`${prefix}/login`),
    ),
  );
  output.append(state, signIns, credentials, accountDeletion());
}

async function showSavedResearch() {
  const controls = element("section", undefined, "card result-card");
  const filter = element("form", undefined, "actions");
  const searchLabel = element("label", t("Find by saved name", "按保存名称查找"));
  const keyword = element("input");
  keyword.maxLength = 120;
  searchLabel.append(keyword);
  const search = element("button", t("Search saved research", "搜索已保存研究"), "btn ghost");
  search.type = "submit";
  filter.append(searchLabel, search);
  const picks = element("form", undefined, "actions");
  const select = (label, options) => {
    const group = element("label", label);
    const field = element("select");
    for (const [value, name] of options) {
      const option = element("option", name);
      option.value = value;
      field.append(option);
    }
    group.append(field);
    picks.append(group);
    return field;
  };
  const left = select(t("Left research", "左侧研究"), []);
  const right = select(t("Right research", "右侧研究"), []);
  const choices = [
    ["", t("Saved view", "保存时的视图")],
    ["authoritative", t("Authoritative", "权威统计")],
    ["adjusted", t("With saved exclusions", "应用已保存的排除项")],
  ];
  const leftMode = select(t("Left view", "左侧视图"), choices);
  const rightMode = select(t("Right view", "右侧视图"), choices);
  const compare = element("button", t("Compare saved research", "对照已保存研究"), "btn brand");
  compare.type = "submit";
  picks.append(compare);
  const comparison = element("div", undefined, "saved-comparison");
  const list = element("div");
  controls.append(filter, picks, comparison);
  output.append(controls, list);

  const csrf = async () => (await session())?.csrf_token;
  const refresh = async () => {
    const { data } = await api(`/v1/saved-research?${new URLSearchParams({ q: keyword.value })}`);
    list.replaceChildren();
    comparison.replaceChildren();
    for (const side of [left, right]) {
      side.replaceChildren();
      for (const item of data) {
        const option = element("option", item.name);
        option.value = item.id;
        side.append(option);
      }
    }
    if (data.length >= 2) right.selectedIndex = 1;
    compare.disabled = data.length < 2;
    if (!data.length)
      list.append(element("p", t("No saved research found.", "没有找到已保存研究。"), "notice"));
    for (const item of data) {
      const card = element("article", undefined, "card result-card");
      const title = element("h2", item.name);
      const href = `${prefix}/results/${item.query_id}?${new URLSearchParams({ saved: item.id })}`;
      const rename = element("form", undefined, "actions");
      const label = element("label", t("New saved name", "新的保存名称"));
      const input = element("input");
      input.maxLength = 120;
      input.required = true;
      input.value = item.name;
      label.append(input);
      const submit = element("button", t("Rename", "重命名"), "btn ghost");
      submit.type = "submit";
      rename.append(label, submit);
      rename.addEventListener("submit", (event) => {
        event.preventDefault();
        run(async () => {
          submit.disabled = true;
          try {
            await api(`/v1/saved-research/${item.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "X-CSRF-Token": await csrf() },
              body: JSON.stringify({ name: input.value, version: item.version }),
            });
            message(t("Saved name updated.", "已更新保存名称。"));
            await refresh();
          } finally {
            submit.disabled = false;
          }
        });
      });
      const remove = button(t("Remove save", "移除保存"), () =>
        run(async () => {
          remove.disabled = true;
          try {
            await api(`/v1/saved-research/${item.id}`, {
              method: "DELETE",
              headers: { "X-CSRF-Token": await csrf() },
            });
            message(t("Saved reference removed.", "保存引用已移除。"));
            await refresh();
          } finally {
            remove.disabled = false;
          }
        }),
      );
      card.append(
        title,
        element("p", t(`${item.excluded_count} saved exclusions`, `${item.excluded_count} 个已保存排除项`)),
        link(t("Open saved view", "打开保存的视图"), href),
        rename,
        remove,
      );
      list.append(card);
    }
  };
  const sideCard = (row) => {
    const card = element("article", undefined, "card result-card");
    card.append(element("h2", row.name));
    if (!row.available) {
      card.append(element("p", t("This snapshot is unavailable.", "该快照目前不可用。")));
      return card;
    }
    card.append(
      element(
        "p",
        row.view === "adjusted" ? t("Adjusted view", "调整视图") : t("Authoritative view", "权威视图"),
      ),
      element("strong", amount(row.median_cents)),
      element(
        "p",
        t(
          `${row.n_price_verified} verified · ${row.excluded_count} excluded`,
          `已核验 ${row.n_price_verified} 条 · 排除 ${row.excluded_count} 条`,
        ),
      ),
      element(
        "p",
        t(
          `Typical range ${amount(row.p25_cents)} – ${amount(row.p75_cents)}`,
          `典型区间 ${amount(row.p25_cents)} – ${amount(row.p75_cents)}`,
        ),
      ),
      element(
        "p",
        t(
          `${row.window_days} days · ${row.currency} · ${row.price_basis === "item" ? "item price" : "item plus observed shipping"}`,
          `${row.window_days} 天 · ${row.currency} · ${row.price_basis === "item" ? "商品价" : "商品价加已观察运费"}`,
        ),
      ),
      element(
        "p",
        t(
          `Data as of ${row.data_as_of} · Market coverage unknown`,
          `数据时点 ${row.data_as_of} · 市场覆盖未知`,
        ),
      ),
    );
    return card;
  };
  filter.addEventListener("submit", (event) => {
    event.preventDefault();
    run(refresh);
  });
  picks.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      if (!left.value || !right.value || left.value === right.value) {
        message(t("Choose two distinct saved views.", "请选择两个不同的保存视图。"), "warning");
        return;
      }
      compare.disabled = true;
      try {
        const { data } = await post(
          "/v1/saved-research/compare",
          {
            left_id: left.value,
            right_id: right.value,
            ...(leftMode.value ? { left_view: leftMode.value } : {}),
            ...(rightMode.value ? { right_view: rightMode.value } : {}),
          },
          await csrf(),
        );
        comparison.replaceChildren(sideCard(data.left), sideCard(data.right));
        const reasons = {
          unavailable: t("snapshot availability", "快照可用性"),
          marketplace: t("market or currency", "市场或币种"),
          price_basis: t("price basis", "价格口径"),
          window: t("time window", "时间窗口"),
          scope: t("query and coverage", "查询条件与数据范围"),
          sample_size: t("sample size", "样本量"),
        };
        message(
          data.median_delta_cents === null
            ? t(
                `Median difference unavailable · ${data.differences.map((item) => reasons[item]).join(", ")}`,
                `无法计算中位价差 · ${data.differences.map((item) => reasons[item]).join("、")}`,
              )
            : t(
                `Right minus left: ${amount(data.median_delta_cents)}`,
                `右侧减左侧为 ${amount(data.median_delta_cents)}`,
              ),
        );
      } finally {
        compare.disabled = false;
      }
    });
  });
  await refresh();
}

async function showBatchWorkbench() {
  const statusLabel = (s) =>
    ({
      queued: t("Queued", "排队中"),
      running: t("Running", "计算中"),
      ready_to_claim: t("Ready to claim", "待显式领取"),
      delivered: t("Delivered", "已交付"),
      failed: t("Failed", "失败"),
      cancelled: t("Cancelled", "已取消"),
      expired: t("Expired", "已过期"),
      completed: t("Completed", "已完成"),
      partial: t("Partial", "部分完成"),
    })[s] ?? s;

  const intro = element(
    "p",
    t(
      "Upload or paste CSV (max 20 rows, 1 active batch per account). Preview deduplication and upper-bound credits before submitting; claim ready items explicitly with zero upfront deduction.",
      "上传或粘贴 CSV（每次最多 20 行、每账户仅限 1 个活跃批量任务）。提交前先预览去重与最大预估额度；提交不提前扣费，就绪后显式领取结算。",
    ),
    "notice",
  );

  const formCard = element("section", undefined, "card result-card");
  formCard.append(element("h2", t("CSV batch input", "CSV 批量输入")));
  const form = element("form");
  const nameLabel = element("label", t("Batch name (optional)", "批量名称（可选）"));
  const nameInput = element("input");
  nameInput.maxLength = 120;
  nameInput.placeholder = t("e.g. Handheld inventory check", "例如：掌机库存复核");
  nameLabel.append(nameInput);

  const fileLabel = element("label", t("Choose CSV file", "选择 CSV 文件"));
  const fileInput = element("input");
  fileInput.type = "file";
  fileInput.accept = ".csv,text/csv";
  fileLabel.append(fileInput);

  const csvLabel = element("label", t("CSV rows (header must include q)", "CSV 内容（表头须包含 q）"));
  const csvArea = element("textarea");
  csvArea.rows = 6;
  csvArea.setAttribute("data-batch-csv", "");
  csvArea.value =
    "q,condition,window_days\nNintendo Switch OLED,like_new,90\nNintendo Switch OLED,like_new,90\n";
  csvLabel.append(csvArea);

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    run(async () => {
      csvArea.value = await file.text();
    });
  });

  const btnRow = element("div", undefined, "actions");
  const sampleBtn = element("button", t("Load sample CSV", "加载示例 CSV"), "btn ghost");
  sampleBtn.type = "button";
  sampleBtn.addEventListener("click", () => {
    csvArea.value =
      "q,category,window_days\nNintendo Game Boy,video_games,90\nNintendo Game Boy,video_games,90\nUncovered Item,video_games,90\n";
  });
  const previewBtn = element("button", t("Preview dedupe & cost", "预览去重与额度上限"), "btn ghost");
  previewBtn.type = "button";
  const submitBtn = element("button", t("Submit batch", "提交批量任务"), "btn brand");
  submitBtn.type = "submit";
  btnRow.append(sampleBtn, previewBtn, submitBtn);
  form.append(nameLabel, fileLabel, csvLabel, btnRow);

  const previewBox = element("div");
  previewBox.setAttribute("data-batch-preview", "");
  formCard.append(form, previewBox);

  const activeBox = element("section", undefined, "card result-card");
  activeBox.setAttribute("data-batch-detail", "");
  const listBox = element("section", undefined, "card result-card");
  listBox.setAttribute("data-batch-list", "");
  output.append(intro, formCard, activeBox, listBox);

  const csrf = async () => (await session())?.csrf_token;
  let activeId = safeId(current().searchParams.get("batch") ?? "");
  let submitAttempt = null;
  let claimAttempt = null;
  let cancelAttempt = null;

  function renderPreview(preview) {
    previewBox.replaceChildren();
    const summary = element(
      "p",
      t(
        `Rows: ${preview.total_rows} · Valid: ${preview.valid_rows} · Unique: ${preview.unique_executable_queries} · Duplicates: ${preview.duplicate_rows} · Reusable: ${preview.reusable_queries} · Est. max credits: ${preview.max_estimated_credits} (available: ${preview.current_available_credits})`,
        `总行数：${preview.total_rows} · 有效：${preview.valid_rows} · 唯一查询：${preview.unique_executable_queries} · 批内重复：${preview.duplicate_rows} · 10分钟复用：${preview.reusable_queries} · 预计上限：${preview.max_estimated_credits} credits（可用余额：${preview.current_available_credits}）`,
      ),
      "notice",
    );
    previewBox.append(summary);
    const list = element("ul");
    for (const item of preview.items) {
      const text = item.valid
        ? `#${item.item_index + 1} ${item.normalized_query?.q ?? ""} — ${
            item.deduplicated_in_batch
              ? t(`duplicate of #${item.primary_item_index + 1}`, `重复 #${item.primary_item_index + 1}`)
              : item.reusable
                ? t("10m reuse", "10分钟复用")
                : item.covered_offline
                  ? t("covered offline", "离线语料覆盖")
                  : t("uncovered offline", "无离线语料")
          } · ${t("max credits", "预计上限")}: ${item.estimated_max_credits}`
        : `#${item.item_index + 1} — ${t("invalid", "无效")}: ${item.error_code ?? "invalid_parameter"}`;
      list.append(element("li", text, "small"));
    }
    previewBox.append(list);
  }

  function renderBatch(batch) {
    activeBox.replaceChildren();
    activeBox.append(element("h2", `${batch.name} · ${statusLabel(batch.status)}`));
    activeBox.append(
      element(
        "p",
        t(
          `Items: ${batch.total_items} (${batch.unique_query_count} unique) · Est. max credits: ${batch.estimated_max_credits} · Charged so far: ${batch.total_credits_charged}`,
          `条目：${batch.total_items}（唯一 ${batch.unique_query_count}）· 预计上限：${batch.estimated_max_credits} · 已实际扣费：${batch.total_credits_charged}`,
        ),
        "small",
      ),
    );
    const bar = element("div", undefined, "actions");
    const refreshBtn = button(t("Refresh status", "刷新进度"), () =>
      run(async () => {
        await loadBatch(batch.id);
      }),
    );
    refreshBtn.className = "btn ghost";
    bar.append(refreshBtn);

    const readyCount = batch.items.filter((i) => i.claimable).length;
    if (readyCount > 0) {
      const maxPotential = batch.items.reduce((sum, i) => (i.claimable ? sum + i.potential_credits : sum), 0);
      const claimBtn = button(
        t(
          `Claim ready (${readyCount} items, up to ${maxPotential} credits)`,
          `领取就绪结果（${readyCount} 项，最多 ${maxPotential} credits）`,
        ),
        () =>
          run(async () => {
            claimBtn.disabled = true;
            try {
              const shape = `${batch.id}:${batch.items.map((i) => `${i.item_index}:${i.status}`).join(",")}`;
              if (claimAttempt?.shape !== shape) claimAttempt = { shape, key: crypto.randomUUID() };
              const res = await post(`/v1/batches/${batch.id}/claim`, {}, await csrf(), claimAttempt.key);
              message(
                t(
                  `Claimed ${res.data.claimed_query_ids.length} queries (${res.data.credits_charged_now} credits charged now).`,
                  `已领取 ${res.data.claimed_query_ids.length} 项查询（本次扣费 ${res.data.credits_charged_now} credits）。`,
                ),
              );
              await loadAll();
            } finally {
              claimBtn.disabled = false;
            }
          }),
      );
      bar.append(claimBtn);
    }

    if (["queued", "running"].includes(batch.status)) {
      const cancelBtn = button(t("Cancel remaining", "取消剩余任务"), () =>
        run(async () => {
          cancelBtn.disabled = true;
          try {
            const shape = `${batch.id}:${batch.version}`;
            if (cancelAttempt?.shape !== shape) cancelAttempt = { shape, key: crypto.randomUUID() };
            await post(
              `/v1/batches/${batch.id}/cancel`,
              { version: batch.version },
              await csrf(),
              cancelAttempt.key,
            );
            message(t("Remaining queued items cancelled.", "已取消剩余排队条目。"));
            await loadAll();
          } finally {
            cancelBtn.disabled = false;
          }
        }),
      );
      cancelBtn.className = "btn ghost";
      bar.append(cancelBtn);
    }

    for (const fmt of ["csv", "json"]) {
      const exportBtn = button(t(`Export ${fmt.toUpperCase()}`, `导出 ${fmt.toUpperCase()}`), () =>
        run(async () => {
          exportBtn.disabled = true;
          try {
            const out = await post(
              `/v1/batches/${batch.id}/export`,
              { format: fmt },
              await csrf(),
              undefined,
              fmt === "csv",
            );
            const blob =
              fmt === "csv" ? out : new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
            download(blob, `soldbench-batch-${batch.id}.${fmt}`);
          } finally {
            exportBtn.disabled = false;
          }
        }),
      );
      exportBtn.className = "btn ghost";
      bar.append(exportBtn);
    }
    activeBox.append(bar);

    const table = element("div", undefined, "table-scroll");
    const inner = element("table");
    const head = element("tr");
    for (const col of [
      t("#", "序号"),
      t("Query", "查询"),
      t("Status", "状态"),
      t("Median", "中位价"),
      t("Verified n", "有效样本"),
      t("Credits", "扣费"),
      t("Action", "操作"),
    ]) {
      head.append(element("th", col));
    }
    const thead = element("thead");
    thead.append(head);
    inner.append(thead);
    const tbody = element("tbody");
    for (const item of batch.items) {
      const tr = element("tr");
      tr.append(element("td", String(item.item_index + 1)));
      tr.append(element("td", String(item.input_query?.q ?? "")));
      const statusText = item.rights_unavailable
        ? t("Rights unavailable", "权限已不可用")
        : `${statusLabel(item.status)}${item.error_code ? ` (${item.error_code})` : ""}`;
      tr.append(element("td", statusText));
      tr.append(element("td", item.stats ? amount(item.stats.median_cents) : "—"));
      tr.append(element("td", item.stats ? String(item.stats.n_price_verified) : "—"));
      tr.append(element("td", String(item.credits_charged)));
      const actCell = element("td");
      if (item.claimable && item.query_id) {
        const oneBtn = button(
          t(`Claim (${item.potential_credits})`, `领取 (${item.potential_credits})`),
          () =>
            run(async () => {
              oneBtn.disabled = true;
              try {
                const res = await post(
                  `/v1/batches/${batch.id}/claim`,
                  { item_indices: [item.item_index] },
                  await csrf(),
                  crypto.randomUUID(),
                );
                message(
                  t(
                    `Item #${item.item_index + 1} processed (${res.data.credits_charged_now} credits charged).`,
                    `第 #${item.item_index + 1} 项已处理（本次扣费 ${res.data.credits_charged_now}）。`,
                  ),
                );
                await loadAll();
              } finally {
                oneBtn.disabled = false;
              }
            }),
        );
        oneBtn.className = "btn ghost";
        actCell.append(oneBtn);
      } else if (item.status === "delivered" && safeId(item.query_id) && !item.rights_unavailable) {
        actCell.append(link(t("Open result", "查看结果"), `${prefix}/results/${item.query_id}`));
      } else {
        actCell.textContent = "—";
      }
      tr.append(actCell);
      tbody.append(tr);
    }
    inner.append(tbody);
    table.append(inner);
    activeBox.append(table);
  }

  async function loadBatch(id) {
    const { data } = await api(`/v1/batches/${id}`);
    activeId = data.id;
    renderBatch(data);
  }

  async function loadAll() {
    const { data } = await api("/v1/batches");
    listBox.replaceChildren(element("h2", t("Recent batches", "近期批量任务")));
    if (!data.items.length) {
      listBox.append(element("p", t("No batches yet.", "暂无批量任务。"), "notice"));
      activeBox.replaceChildren();
      return;
    }
    const ul = element("ul");
    for (const b of data.items) {
      const li = element("li");
      const open = button(`${b.name} (${statusLabel(b.status)} · ${b.total_items})`, () =>
        run(async () => {
          await loadBatch(b.id);
        }),
      );
      open.className = "btn ghost";
      li.append(open);
      ul.append(li);
    }
    listBox.append(ul);
    const target = activeId && data.items.some((b) => b.id === activeId) ? activeId : data.items[0].id;
    await loadBatch(target);
  }

  previewBtn.addEventListener("click", () =>
    run(async () => {
      previewBtn.disabled = true;
      try {
        const res = await post("/v1/batches/preview", { csv: csvArea.value }, await csrf());
        renderPreview(res.data);
      } finally {
        previewBtn.disabled = false;
      }
    }),
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      submitBtn.disabled = true;
      try {
        const payload = {
          ...(nameInput.value.trim() ? { name: nameInput.value.trim() } : {}),
          csv: csvArea.value,
        };
        const shape = JSON.stringify(payload);
        if (submitAttempt?.shape !== shape) submitAttempt = { shape, key: crypto.randomUUID() };
        const res = await post("/v1/batches", payload, await csrf(), submitAttempt.key);
        activeId = res.data.id;
        message(t("Batch submitted without upfront credit charge.", "批量任务已提交（尚未扣费）。"));
        await loadAll();
      } finally {
        submitBtn.disabled = false;
      }
    });
  });

  await loadAll();
}

async function showArchiveHistory() {
  const intro = element(
    "p",
    t(
      "Inspect actual retained archive windows, missing collection gaps, and single-sale historical trends (multi-unit listing averages excluded; missing segments remain null).",
      "核对真实留存档案时间跨度、采集缺口与单笔成交历史走势（自动排除多件挂牌均价行；缺失时段保持空缺不补零）。",
    ),
    "notice",
  );

  const formCard = element("section", undefined, "card result-card");
  formCard.append(element("h2", t("Archive window & filters", "档案窗口与筛选")));
  const form = element("form");

  const qLabel = element("label", t("Query keyword", "关键词"));
  const qInput = element("input");
  qInput.maxLength = 120;
  qInput.required = true;
  qInput.setAttribute("data-history-q", "");
  qInput.value = current().searchParams.get("q") ?? "Nintendo Switch";
  qLabel.append(qInput);

  const winLabel = element("label", t("Window days", "查询天数窗口"));
  const winSelect = element("select");
  for (const [val, label] of [
    ["30", t("30 days", "30 天")],
    ["90", t("90 days", "90 天")],
    ["180", t("180 days", "180 天")],
    ["365", t("365 days", "365 天")],
    ["custom", t("Custom UTC dates", "自定义 UTC 日期")],
  ]) {
    const opt = element("option", label);
    opt.value = val;
    winSelect.append(opt);
  }
  winSelect.value = "90";
  winLabel.append(winSelect);

  const fromLabel = element("label", t("From UTC date (YYYY-MM-DD)", "起始 UTC 日期 (YYYY-MM-DD)"));
  const fromInput = element("input");
  fromInput.placeholder = "2026-10-01";
  fromLabel.append(fromInput);

  const toLabel = element("label", t("To UTC date (YYYY-MM-DD)", "结束 UTC 日期 (YYYY-MM-DD)"));
  const toInput = element("input");
  toInput.placeholder = "2026-11-17";
  toLabel.append(toInput);

  const granLabel = element("label", t("Series granularity", "时间序列粒度"));
  const granSelect = element("select");
  for (const [val, label] of [
    ["", t("Auto", "自动")],
    ["day", t("Daily (UTC)", "按日 (UTC)")],
    ["week", t("Weekly (UTC)", "按周 (UTC)")],
    ["month", t("Monthly (UTC)", "按月 (UTC)")],
  ]) {
    const opt = element("option", label);
    opt.value = val;
    granSelect.append(opt);
  }
  granLabel.append(granSelect);

  const partialLabel = element("label", undefined, "actions");
  const partialCheck = element("input");
  partialCheck.type = "checkbox";
  const partialSpan = element(
    "span",
    t("Allow partial coverage (mark missing gaps)", "允许部分覆盖（标注缺失缺口）"),
  );
  partialLabel.append(partialCheck, partialSpan);

  const btnRow = element("div", undefined, "actions");
  const covBtn = element("button", t("Check retained coverage", "检查留存覆盖"), "btn ghost");
  covBtn.type = "button";
  const runBtn = element("button", t("Load historical trend", "加载历史研究"), "btn brand");
  runBtn.type = "submit";
  btnRow.append(covBtn, runBtn);
  form.append(qLabel, winLabel, fromLabel, toLabel, granLabel, partialLabel, btnRow);

  const covBox = element("div");
  covBox.setAttribute("data-history-coverage", "");
  formCard.append(form, covBox);

  const resultBox = element("section", undefined, "card result-card");
  resultBox.setAttribute("data-history-results", "");
  output.append(intro, formCard, resultBox);

  const csrf = async () => (await session())?.csrf_token;

  function buildParams(forCoverage = false) {
    const p = new URLSearchParams({ q: qInput.value.trim() });
    if (forCoverage) return p;
    if (winSelect.value === "custom") {
      if (fromInput.value.trim()) p.set("from_date", fromInput.value.trim());
      if (toInput.value.trim()) p.set("to_date", toInput.value.trim());
    } else {
      p.set("window_days", winSelect.value);
    }
    if (partialCheck.checked) p.set("allow_partial", "true");
    if (granSelect.value) p.set("granularity", granSelect.value);
    return p;
  }

  function renderCoverage(cov) {
    covBox.replaceChildren();
    const windowsText = cov.supported_history_windows.length
      ? cov.supported_history_windows.join(", ")
      : t("None", "无");
    covBox.append(
      element(
        "p",
        t(
          `Retained days: ${cov.actual_retained_days} · Supported complete windows: ${windowsText} · Excluded multi-unit rows: ${cov.excluded_multi_unit_rows} · Internal gaps: ${cov.missing_gaps.length}`,
          `实际留存天数：${cov.actual_retained_days} · 支持完整窗口：${windowsText} · 已排除多件均价行：${cov.excluded_multi_unit_rows} · 内部缺口数：${cov.missing_gaps.length}`,
        ),
        "notice",
      ),
    );
    if (cov.covered_spans.length) {
      const ul = element("ul");
      for (const s of cov.covered_spans) {
        ul.append(
          element(
            "li",
            `${s.start.slice(0, 10)} → ${s.end.slice(0, 10)} (${s.completeness === "complete" ? t("complete", "完整") : t("partial", "部分")})`,
            "small",
          ),
        );
      }
      covBox.append(ul);
    }
  }

  function renderResults(payload, appendItems = false) {
    if (!appendItems) {
      resultBox.replaceChildren();
      resultBox.append(
        element(
          "h2",
          `${t("Coverage", "覆盖状态")}: ${payload.coverage_status === "complete" ? t("Complete", "完整覆盖") : t("Partial (with gaps)", "部分覆盖（含缺口）")}`,
        ),
      );
      resultBox.append(
        element(
          "p",
          t(
            `Single-sale verified n: ${payload.stats.n_price_verified} · Median: ${amount(payload.stats.median_cents)} · P25/P75: ${amount(payload.stats.p25_cents)} / ${amount(payload.stats.p75_cents)} · Excluded multi-unit rows: ${payload.excluded_multi_unit_count} · Gaps: ${payload.missing_gaps.length}`,
            `单笔核验样本：${payload.stats.n_price_verified} · 中位价：${amount(payload.stats.median_cents)} · P25/P75：${amount(payload.stats.p25_cents)} / ${amount(payload.stats.p75_cents)} · 排除多件均价：${payload.excluded_multi_unit_count} · 缺口段：${payload.missing_gaps.length}`,
          ),
          "small",
        ),
      );

      const expBar = element("div", undefined, "actions");
      for (const fmt of ["csv", "json"]) {
        const expBtn = button(t(`Export ${fmt.toUpperCase()}`, `导出 ${fmt.toUpperCase()}`), () =>
          run(async () => {
            expBtn.disabled = true;
            try {
              const p = buildParams(false);
              const body = { format: fmt, q: p.get("q") };
              if (p.has("window_days")) body.window_days = Number(p.get("window_days"));
              if (p.has("from_date")) body.from_date = p.get("from_date");
              if (p.has("to_date")) body.to_date = p.get("to_date");
              if (p.get("allow_partial") === "true") body.allow_partial = true;
              if (p.has("granularity")) body.granularity = p.get("granularity");
              const out = await post("/v1/history/export", body, await csrf(), undefined, fmt === "csv");
              const blob =
                fmt === "csv" ? out : new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
              download(blob, `soldbench-history-${payload.query_hash.slice(0, 8)}.${fmt}`);
            } finally {
              expBtn.disabled = false;
            }
          }),
        );
        expBtn.className = "btn ghost";
        expBar.append(expBtn);
      }
      resultBox.append(expBar);

      const tsTable = element("div", undefined, "table-scroll");
      const tsInner = element("table");
      const tsHead = element("tr");
      for (const col of [
        t("Bucket UTC", "UTC 时段"),
        t("Coverage", "覆盖情况"),
        t("Samples", "样本数"),
        t("Median", "中位价"),
      ]) {
        tsHead.append(element("th", col));
      }
      const tsThead = element("thead");
      tsThead.append(tsHead);
      tsInner.append(tsThead);
      const tsBody = element("tbody");
      const covLabels = {
        complete: t("Complete", "完整"),
        partial: t("Partial", "部分"),
        missing: t("Missing gap", "数据缺口"),
      };
      for (const b of payload.time_series.buckets) {
        const tr = element("tr");
        tr.append(element("td", `${b.start.slice(0, 10)} → ${b.end.slice(0, 10)}`));
        tr.append(element("td", covLabels[b.observation_coverage] ?? b.observation_coverage));
        tr.append(element("td", String(b.sample_count)));
        tr.append(element("td", amount(b.median_cents)));
        tsBody.append(tr);
      }
      tsInner.append(tsBody);
      tsTable.append(tsInner);
      resultBox.append(tsTable);

      const salesHeading = element("h3", t("Archived single-sale observations", "已归档单笔成交记录"));
      const salesList = element("ul");
      salesList.setAttribute("data-history-items", "");
      resultBox.append(salesHeading, salesList);
    }

    const salesList = resultBox.querySelector("[data-history-items]");
    for (const item of payload.items) {
      const li = element(
        "li",
        `${item.sold_at ? item.sold_at.slice(0, 10) : "—"} · ${item.title ?? t("Title withheld", "标题不公开")} · ${amount(item.price_usd_cents)} · ${t("Photo", "主图")}: ${item.primary_image.state}`,
        "small",
      );
      salesList.append(li);
    }
    const prevMore = resultBox.querySelector("[data-history-more]");
    if (prevMore) prevMore.remove();
    if (payload.next_cursor) {
      const more = button(t("Load more", "加载更多"), () =>
        run(async () => {
          const p = buildParams(false);
          p.set("cursor", payload.next_cursor);
          const nextRes = await api(`/v1/history?${p}`);
          renderResults(nextRes.data, true);
        }),
      );
      more.className = "btn ghost";
      more.setAttribute("data-history-more", "");
      resultBox.append(more);
    }
  }

  covBtn.addEventListener("click", () =>
    run(async () => {
      covBtn.disabled = true;
      try {
        const res = await api(`/v1/history/coverage?${buildParams(true)}`);
        renderCoverage(res.data);
      } finally {
        covBtn.disabled = false;
      }
    }),
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run(async () => {
      runBtn.disabled = true;
      try {
        const res = await api(`/v1/history?${buildParams(false)}`);
        renderResults(res.data, false);
      } finally {
        runBtn.disabled = false;
      }
    });
  });

  if (qInput.value.trim()) {
    try {
      const res = await api(`/v1/history/coverage?${buildParams(true)}`);
      renderCoverage(res.data);
    } catch {
      // Leave initial empty query clean without error banner
    }
  }
}

if (page.startsWith("/account"))
  run(async () => {
    const user = await session();
    if (!user?.email_verified || user.mfa_required) {
      message(t("A verified account is required.", "此页面需要已验证的账户。"));
      output.append(link(t("Sign in", "登录"), resume("/login")));
      return;
    }
    const signOut = document.querySelector("[data-logout]");
    signOut.hidden = false;
    signOut.addEventListener("click", () =>
      run(async () => {
        await post("/auth/logout", {}, (await session())?.csrf_token);
        location.assign(`${prefix}/`);
      }),
    );
    if (page === "/account/usage") return showUsage();
    if (page === "/account/logs") return showLogs();
    if (page === "/account/saved") return showSavedResearch();
    if (page === "/account/batches") return showBatchWorkbench();
    if (page === "/account/history") return showArchiveHistory();
    if (page === "/account/security") return showAccountSecurity();
    if (page === "/account/billing") return showBilling();
    if (page === "/account/keys") {
      try {
        await showKeys();
      } catch (error) {
        if (error.message === "reauthentication_required")
          output.append(link(t("Sign in again", "重新登录"), resume("/login")));
        throw error;
      }
      return;
    }
    if (page === "/account") {
      const balance = await api("/v1/usage");
      const usage = element("section", undefined, "card result-card");
      usage.append(element("h2", t("Credit balance", "额度余额")));
      if (Number.isSafeInteger(balance.data.total_available))
        usage.append(element("strong", String(balance.data.total_available)));
      output.append(usage);
    }
    const history = await api("/v1/queries");
    const recent = element("section", undefined, "card result-card");
    recent.append(element("h2", t("Recent research", "近期研究")));
    if (!history.data.items.length) {
      recent.append(element("p", t("Your research history is empty.", "暂无研究记录。")));
    }
    const entries = element("ul");
    const more = button(t("Load more", "加载更多"), () => {
      more.disabled = true;
      run(async () => {
        try {
          const params = new URLSearchParams({ cursor: more.dataset.cursor });
          showHistory((await api(`/v1/queries?${params}`)).data);
        } finally {
          more.disabled = false;
        }
      });
    });
    function showHistory({ items, next_cursor }) {
      for (const row of items) {
        const id = safeId(row.query_id);
        const item = element("li");
        const when = `${row.created_at.slice(0, 16).replace("T", " ")} UTC`;
        if (id && row.result_state === "available") {
          item.append(link(row.q, `${prefix}/results/${id}`));
        } else {
          item.append(element("strong", row.q));
        }
        item.append(element("p", when, "small"));
        entries.append(item);
      }
      more.hidden = !next_cursor;
      more.dataset.cursor = next_cursor ?? "";
    }
    showHistory(history.data);
    recent.append(entries, more);
    output.append(recent);
  });
