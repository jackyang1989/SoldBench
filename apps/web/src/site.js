const page = document.body.dataset.page;
const prefix = document.body.dataset.prefix;
const zh = document.documentElement.lang === "zh-CN";
const t = (en, cn) => (zh ? cn : en);
const status = document.querySelector("[data-status]");
const actions = document.querySelector("[data-actions]");
const output = document.querySelector("[data-results]");
const search = document.querySelector("[data-search]");
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
  if (!response.ok) {
    throw Object.assign(new Error(body.error?.code ?? "service_unavailable"), {
      status: response.status,
      reference: response.headers.get("X-Request-ID"),
      retryAfter: response.headers.get("Retry-After"),
    });
  }
  return body;
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
    card.append(viewport, research.share);
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
  const searchPath = page === "/" ? "/" : "/search";
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

if (page === "/account")
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
    const [balance, history] = await Promise.all([api("/v1/usage"), api("/v1/queries")]);
    const usage = element("section", undefined, "card result-card");
    usage.append(element("h2", t("Credit balance", "额度余额")));
    if (Number.isSafeInteger(balance.data.total_available)) {
      usage.append(element("strong", String(balance.data.total_available)));
    }
    output.append(usage);
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
