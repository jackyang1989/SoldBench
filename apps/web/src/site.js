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
      if (/^\/v1\/media\/[0-9a-f-]{36}$/.test(comp.primary_image?.url ?? "")) {
        const photo = element("img", undefined, "comp-image");
        photo.alt = t("Sale photo", "成交主图");
        photo.loading = "lazy";
        photo.src = comp.primary_image.url;
        photo.addEventListener("error", () =>
          photo.replaceWith(element("span", t("Photo unavailable", "主图不可用"), "small")),
        );
        item.append(photo);
      }
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
      research.share,
    );
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
  const searchPath = ["/", "/playground"].includes(page) ? page : "/search";
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

const support = document.querySelector("[data-support]");
if (support) {
  let previous;
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
        if (previous?.serialized !== serialized) previous = { serialized, key: crypto.randomUUID() };
        const { data } = await post("/support/requests", ticket, (await session())?.csrf_token, previous.key);
        message(t(`Request received · ${data.request_id}`, `已受理 · 工单编号 ${data.request_id}`));
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
  const labels = {
    submit: t("Submit for review", "送审"),
    approve: t("Approve", "批准"),
    publish: t("Publish", "发布"),
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
      card.append(preview);
      const tools = element("div", undefined, "actions");
      tools.append(
        button(t("Edit latest", "编辑最新版本"), () => {
          selected = row;
          contentForm.elements.kind.value = row.kind;
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
      const action = (operation, revision, label = labels[operation]) => {
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
              await command(
                { command: operation, entry_id: row.id, version: row.version, revision, reason },
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
      if (row.state === "approved" && row.latest_revision !== row.published_revision)
        tools.append(action("publish", row.latest_revision));
      if (row.published_revision) tools.append(action("unpublish", row.published_revision));
      for (const revision of row.publication_history.slice(0, 8)) {
        if (revision !== row.published_revision)
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
        const input = {
          command: "draft",
          kind,
          slug,
          version: selected?.slug === slug && selected?.kind === kind ? selected.version : 0,
          body: {
            en: { title: fields.get("en_title"), body: fields.get("en_body") },
            "zh-CN": { title: fields.get("zh_title"), body: fields.get("zh_body") },
          },
          reason: fields.get("reason"),
        };
        const shape = JSON.stringify(input);
        if (draftAttempt?.shape !== shape) draftAttempt = { shape, key: crypto.randomUUID() };
        await command(input, draftAttempt.key);
        draftAttempt = undefined;
        selected = undefined;
        contentForm.reset();
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
  const recoveryTab = operatorTabs.find((item) => item.dataset.opsView === "recovery");
  const recoveryAccess = api("/admin/recovery", { method: "GET" })
    .then(({ data }) => {
      recoveryTab.hidden = !data.payment_fixtures_enabled;
      return true;
    })
    .catch(() => false);
  let generation = 0;
  const views = {
    sources: {
      heading: t("Sources", "数据源"),
      columns: [
        t("Source ID", "来源 ID"),
        t("Clearance", "权利状态"),
        t("Circuit", "熔断状态"),
        t("Last observation", "最近观测"),
        t("Action", "操作"),
      ],
      row: (source) => [
        source.source_id,
        source.clearance_status,
        source.circuit_status,
        source.last_data_as_of,
        sourceCommand(source),
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
        entry.charge_id,
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
      const params = cursor ? `?${new URLSearchParams({ cursor })}` : "";
      const [response, canWrite] = await Promise.all([api(`/admin/${view}${params}`), recoveryAccess]);
      if (request !== generation) return;
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
    button.addEventListener("click", () => run(() => showView(button.dataset.opsView)));
  run(() => showView("jobs"));
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
  const labelsForPlan = { starter: "Starter", pro: "Pro", purchased_1500: t("Credit pack", "额度包") };
  const subscriptionCard = element("section", undefined, "card result-card");
  subscriptionCard.append(element("h2", t("Subscription", "订阅")));
  subscriptionCard.append(
    element(
      "p",
      `${labelsForPlan[data.plan_code] ?? data.plan_code} · ${labels[data.status] ?? data.status}`,
    ),
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
  for (const offer of prices.offers) {
    const buttonLabel = `${labelsForPlan[offer.plan_code] ?? offer.plan_code} · ${amount(offer.amount_cents)} · ${offer.credits} ${t("credits", "额度")}`;
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
          alternate.href = `${zh ? "" : "/zh-CN"}/account/billing?checkout=${id}`;
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
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const receipt = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
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
