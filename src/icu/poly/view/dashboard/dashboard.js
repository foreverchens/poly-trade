const $ = (id) => document.getElementById(id);
const f2 = (n = 0) => Number(n || 0).toFixed(2);
const fmtMoney = (n) => (Number.isFinite(Number(n)) ? "$" + f2(n) : "—");
const PRICE_DISPLAY_MULTIPLIER = 100;
const PRICE_DISPLAY_DECIMALS = 1;
// 价格范围：双开区间 (0, 1)，不包含0和1
const MIN_ORDER_PRICE = 0.0001; // 用于HTML input的min属性（接近0但不等于0）
const MAX_ORDER_PRICE = 0.9999; // 用于HTML input的max属性（接近1但不等于1）
const formatPrice = (value, { fallback = "—", withUnit = true } = {}) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const scaled = (num * PRICE_DISPLAY_MULTIPLIER).toFixed(PRICE_DISPLAY_DECIMALS);
    return withUnit ? `${scaled}%` : scaled;
};
const formatPriceInput = (value) => {
    return formatPrice(value, { fallback: "", withUnit: false });
};
const parsePriceInput = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num / PRICE_DISPLAY_MULTIPLIER : Number.NaN;
};
const formatTs = (ts) => {
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
};
const shorten = (text = "", head = 6, tail = 4) => {
    if (!text) return "—";
    return text.length <= head + tail ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;
};
const POLY_EVENT_BASE_URL = "https://polymarket.com/event/";
const MIN_CURRENT_VALUE = 1;
let cachedPositions = []; // 保存已加载的原始持仓数据
const accountMetaByAddress = new Map();
let selectedAccountAddresses = new Set();

const normalizeAddress = (value = "") => {
    if (typeof value !== "string") return "";
    return value.trim().toLowerCase();
};

function ensureManualAccountMeta(address) {
    const normalized = normalizeAddress(address);
    if (!normalized) return null;
    if (accountMetaByAddress.has(normalized)) {
        return accountMetaByAddress.get(normalized);
    }
    const meta = {
        address: normalized,
        rawAddress: address,
        pkIdx: null,
        name: "",
        usdcBalance: null,
        manual: true,
    };
    accountMetaByAddress.set(normalized, meta);
    return meta;
}

function getAccountMeta(address, metaMap = accountMetaByAddress) {
    const normalized = normalizeAddress(address);
    if (!normalized) return null;
    return metaMap.get(normalized) || null;
}

function getActiveAddresses() {
    const addresses = [];
    selectedAccountAddresses.forEach((addr) => {
        const meta = accountMetaByAddress.get(addr);
        const address = meta?.rawAddress || addr;
        if (address) addresses.push(address);
    });
    return addresses;
}

async function fetchPositions(addr) {
    const url = `https://data-api.polymarket.com/positions?sizeThreshold=1&limit=100&sortBy=TOKENS&sortDirection=DESC&user=${addr}`;
    const res = await fetch(url, { mode: "cors" });
    let text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        const fixed = text.replace(/([{,\s])(\w+)\s*:/g, '$1"$2":').replace(/'/g, '"');
        data = JSON.parse(fixed);
    }
    // 移除过滤逻辑，返回所有仓位，让 renderPositions 根据复选框状态决定是否过滤
    if (Array.isArray(data)) {
        return data;
    }
    return data;
}

async function fetchAccounts() {
    const res = await fetch("/api/accounts");
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
    }
    return res.json();
}

function renderAccounts(items = []) {
    const container = $("accountsList");
    if (!container) return;
    container.innerHTML = "";
    if (!items.length) {
        container.innerHTML =
            '<div class="accounts-empty muted">暂无托管账号，使用上方输入框手动加载地址。</div>';
        return;
    }

    items.forEach((item) => {
        const normalized = normalizeAddress(item.address);
        if (!normalized) return;
        const meta = {
            ...item,
            address: normalized,
            rawAddress: item.address,
            manual: false,
        };
        accountMetaByAddress.set(normalized, meta);
        const chip = document.createElement("label");
        chip.className = `account-chip${selectedAccountAddresses.has(normalized) ? " active" : ""}`;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedAccountAddresses.has(normalized);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
                selectedAccountAddresses.add(normalized);
            } else {
                selectedAccountAddresses.delete(normalized);
            }
            chip.classList.toggle("active", checkbox.checked);
            load();
        });

        const body = document.createElement("div");
        body.className = "account-chip-body";
        const pkLabel = Number.isInteger(item.pkIdx) ? `#${item.pkIdx}` : "—";
        const addressLabel = shorten(item.address || "");
        body.textContent = `${pkLabel} · ${addressLabel}`;
        chip.appendChild(checkbox);
        chip.appendChild(body);
        container.appendChild(chip);
    });
}

async function initAccountsPanel() {
    const status = $("accountsStatus");
    if (status) {
        status.textContent = "加载账户…";
    }
    try {
        const payload = await fetchAccounts();
        const items = Array.isArray(payload?.items) ? payload.items : [];
        accountMetaByAddress.clear();
        selectedAccountAddresses = new Set();
        items.forEach((item) => {
            const normalized = normalizeAddress(item.address);
            if (!normalized) return;
            selectedAccountAddresses.add(normalized);
        });
        renderAccounts(items);
        if (status) {
            status.textContent = `共 ${items.length} 个账户`;
        }
        return items;
    } catch (err) {
        console.error("Failed to fetch accounts:", err);
        if (status) status.textContent = "账户加载失败";
        renderAccounts([]);
        return [];
    }
}

async function fetchOrderBook(tokenId) {
    if (!tokenId) {
        return { bestBid: null, bestAsk: null };
    }
    try {
        const res = await fetch(`/api/best-prices/${tokenId}`);
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errorText}`);
        }
        const data = await res.json();
        return { bestBid: data.bestBid, bestAsk: data.bestAsk };
    } catch (err) {
        console.error(`Failed to fetch best prices for ${tokenId}:`, err);
        return { bestBid: null, bestAsk: null };
    }
}

async function placeCloseOrder(tokenId, price, size, side, pkIdx) {
    try {
        const numericPkIdx = Number(pkIdx);
        const payload = {
            tokenId,
            price,
            size,
            side,
        };
        if (Number.isInteger(numericPkIdx)) {
            payload.pkIdx = numericPkIdx;
        }
        const res = await fetch("/api/place-order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const text = await res.text();
        let responsePayload = null;
        if (text) {
            try {
                responsePayload = JSON.parse(text);
            } catch (parseErr) {
                console.warn("Failed to parse place-order payload", parseErr);
            }
        }
        const apiError =
            Boolean(responsePayload?.error) ||
            (typeof responsePayload?.status === "number" && responsePayload.status >= 400);
        if (!res.ok || apiError) {
            const fallback = responsePayload?.error || responsePayload?.message || text || `HTTP ${res.status}`;
            throw new Error(fallback);
        }
        return responsePayload;
    } catch (err) {
        console.error("Failed to place order:", err);
        throw err;
    }
}

async function fetchTrades(addr) {
    const res = await fetch(`/api/trades?address=${addr}`);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
    }
    return res.json();
}

async function fetchOpenOrders() {
    const res = await fetch(`/api/open-orders`);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
    }
    return res.json();
}

async function fetchCurrentAddress() {
    const res = await fetch("/api/current-address");
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.address) {
        return data.address;
    }
    if (Array.isArray(data.addresses) && data.addresses.length) {
        return data.addresses[0];
    }
    return null;
}

async function renderPositions(rows, { accountMetaMap = accountMetaByAddress } = {}) {
    const tbody = $("tbody");
    tbody.innerHTML = "";

    // 先用 curPrice 判断哪些是小额仓位，小额仓位永远不调用订单簿API
    const showSmall = $("hideSmallPositions")?.checked || false;

    // 判断是否为小额仓位（基于 curPrice）
    const isSmallPosition = (r) => {
        const size = Number(r.size ?? 0);
        const cur = Number(r.curPrice ?? 0);
        const currentValue = size * cur;
        return currentValue <= MIN_CURRENT_VALUE;
    };

    // 只对非小额仓位获取订单簿数据（小额仓位永远不调用API）
    const nonSmallRows = rows.filter((r) => !isSmallPosition(r));
    const tokenIdSet = new Set();
    nonSmallRows.forEach((r) => {
        const tokenId = r.asset || r.tokenId || r.asset_id || r.assetId || r.token_id || "";
        if (tokenId) tokenIdSet.add(tokenId);
    });

    // 只对非小额仓位获取订单簿数据
    const orderBookMap = new Map();
    await Promise.all(
        Array.from(tokenIdSet).map(async (tokenId) => {
            const { bestBid, bestAsk } = await fetchOrderBook(tokenId);
            orderBookMap.set(tokenId, { bestBid, bestAsk });
        }),
    );

    // 为所有仓位添加订单簿数据（只对非小额仓位有数据，小额仓位永远为 null）
    const enrichedRows = rows.map((r) => {
        const tokenId = r.asset || r.tokenId || r.asset_id || r.assetId || r.token_id || "";
        // 小额仓位永远不调用API，订单簿数据为 null
        const orderBook = orderBookMap.get(tokenId) || { bestBid: null, bestAsk: null };
        return { ...r, ...orderBook, tokenId };
    });

    // 根据单选框状态过滤小额仓位：选中时显示小额仓位，未选中时隐藏小额仓位
    const filteredRows = showSmall
        ? enrichedRows // 选中时显示所有仓位（包括小额）
        : enrichedRows.filter((r) => !isSmallPosition(r)); // 未选中时隐藏小额仓位

    // 用于计算盈亏的仓位：始终排除小额仓位，不管复选框状态
    const nonSmallRowsForCalc = enrichedRows.filter((r) => !isSmallPosition(r));

    // 基于非小额仓位计算盈亏（非小额仓位已经有订单簿数据）
    let totalValue = 0,
        totalPnl = 0,
        totalCost = 0;
    // 统一使用最优买价作为标记价格，缺失时退回当前价
    const getMarkPrice = (row) => {
        if (Number.isFinite(row.bestBid)) {
            return Number(row.bestBid);
        }
        const fallback = Number(row.curPrice ?? 0);
        return Number.isFinite(fallback) ? fallback : 0;
    };

    nonSmallRowsForCalc.forEach((r) => {
        const size = Number(r.size ?? 0);
        const avg = Number(r.avgPrice ?? 0);
        const markPrice = getMarkPrice(r);
        const holdValue = size * markPrice;
        const costValue = size * avg;
        const cashPnl = holdValue - costValue;
        totalValue += holdValue;
        totalPnl += cashPnl;
        totalCost += costValue;
    });

    // 基于过滤后的列表显示持仓（根据复选框状态）
    filteredRows.forEach((r) => {
        const title = r.slug || r.title || r.eventSlug || r.asset || "—";
        const outcome = r.outcome ? `（${r.outcome}）` : "";
        const icon = r.icon || "";
        const size = Number(r.size ?? 0);
        const avg = Number(r.avgPrice ?? 0);
        const tokenId = r.tokenId;
        const bestBid = r.bestBid;
        const bestAsk = r.bestAsk;
        const markPrice = getMarkPrice(r);
        const holdValue = size * markPrice;
        const costValue = size * avg;
        const cashPnl = holdValue - costValue;
        const percentPnl = costValue ? cashPnl / costValue : 0;
        const accountAddress = r.__accountAddress || r.address || r.ownerAddress || "";
        if (accountAddress) {
            ensureManualAccountMeta(accountAddress);
        }
        const accountMeta = getAccountMeta(accountAddress, accountMetaMap);
        const pkIdx = accountMeta?.pkIdx;
        const pkIdxLiteral = Number.isInteger(pkIdx) ? pkIdx : "null";
        const actionDisabledAttr = Number.isInteger(pkIdx) ? "" : ' disabled title="该账号未托管，无法平仓"';

        // 注意：盈亏计算已在 nonSmallRows 中完成，这里只用于显示单行数据

        const tr = document.createElement("tr");
        // 在 rowId 中包含地址信息，确保不同地址的同一资产有唯一标识
        // 使用地址的前8个字符（去掉0x前缀）作为后缀
        const addressSuffix = accountAddress
            ? `-${accountAddress.replace(/^0x/i, "").slice(0, 8)}`
            : "";
        const rowId = `row-${tokenId || Math.random().toString(36).slice(2, 9)}${addressSuffix}`;
        tr.id = rowId;

        tr.innerHTML = `
    <td class="asset" data-th="资产">
      ${icon ? `<img class="icon" src="${icon}" alt="">` : ""}
      <div>
        <div>${title}</div>
        <div class="outcome">${outcome}</div>
      </div>
    </td>
    <td class="right" data-th="数量">${size}</td>
    <td class="right" data-th="成交价">${formatPrice(avg)}</td>
    <td class="right" data-th="最优买价">
      ${Number.isFinite(bestBid) ? `<span class="green">${formatPrice(bestBid)}</span>` : '<span class="muted">—</span>'}
    </td>
    <td class="right" data-th="最优卖价">
      ${Number.isFinite(bestAsk) ? `<span class="red">${formatPrice(bestAsk)}</span>` : '<span class="muted">—</span>'}
    </td>
    <td class="right" data-th="持有价值">${fmtMoney(holdValue)}</td>
    <td class="right" data-th="当前盈亏">
      <span class="${cashPnl >= 0 ? "green" : "red"}">${(cashPnl >= 0 ? "+" : "") + fmtMoney(cashPnl)}</span>
      <span class="${percentPnl >= 0 ? "green" : "red"}"> (${(percentPnl >= 0 ? "+" : "") + (percentPnl * 100).toFixed(2)}%)</span>
    </td>
    <td class="close-order" data-th="平仓">
      <input type="number" step="0.1" min="${MIN_ORDER_PRICE * PRICE_DISPLAY_MULTIPLIER}" max="${MAX_ORDER_PRICE * PRICE_DISPLAY_MULTIPLIER}" placeholder="价格（%）"
             id="${rowId}-price" value="${formatPriceInput(bestBid)}" />
      <input type="number" step="0.01" min="0.01" placeholder="数量"
             id="${rowId}-size" value="${size > 0 ? size.toFixed(3) : ""}" max="${size}" />
      <button${Number.isFinite(bestBid) ? ` data-best-bid="${bestBid}"` : ""} onclick="handleCloseOrder('${tokenId}', '${rowId}', 'SELL', ${pkIdxLiteral})"${actionDisabledAttr}>平仓</button>
    </td>
  `;
        tbody.appendChild(tr);
    });

    $("sumValue").textContent = fmtMoney(totalValue);
    const pnlPct = totalCost ? totalPnl / totalCost : 0;
    $("sumPnl").innerHTML =
        `<span class="${totalPnl >= 0 ? "green" : "red"}">${(totalPnl >= 0 ? "+" : "") + fmtMoney(totalPnl)}</span>`;
    $("sumPnlPct").innerHTML =
        `<span class="${pnlPct >= 0 ? "green" : "red"}">${(pnlPct * 100).toFixed(2)}%</span>`;

    // 更新当前浮动盈亏到收益看板（只更新当前浮动盈亏，不覆盖已实现盈亏）
    const currentPnlEl = $("currentPnl");
    const currentPnlPctEl = $("currentPnlPct");
    if (currentPnlEl) {
        const colorClass = totalPnl >= 0 ? "green" : "red";
        currentPnlEl.innerHTML = `<span class="${colorClass}">${(totalPnl >= 0 ? "+" : "") + fmtMoney(totalPnl)}</span>`;
    }
    if (currentPnlPctEl) {
        const colorClass = pnlPct >= 0 ? "green" : "red";
        currentPnlPctEl.innerHTML = `<span class="${colorClass}">${(pnlPct >= 0 ? "+" : "") + (pnlPct * 100).toFixed(2)}%</span>`;
    }

    // 返回计算好的盈亏数据，供外部使用
    return { currentPnl: totalPnl, currentPnlPct: pnlPct };
}

function parseOrderTime(value) {
    if (!value) return "—";
    if (typeof value === "number") {
        return formatTs(value > 1e12 ? value : value * 1000);
    }
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber)) {
        return formatTs(asNumber > 1e12 ? asNumber : asNumber * 1000);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? "—" : formatTs(parsed);
}

function renderOpenOrders(orders = []) {
    const tbody = $("openOrderBody");
    const status = $("openOrderStatus");
    tbody.innerHTML = "";
    if (!Array.isArray(orders) || !orders.length) {
        status.textContent = "暂无挂单";
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="9" class="muted" data-th="提示">暂无挂单</td>`;
        tbody.appendChild(tr);
        return;
    }
    status.textContent = `共有 ${orders.length} 条挂单`;
    orders.forEach((order) => {
        const sideLabel = (order.side || order.action || "—").toUpperCase();
        const price = Number(order.price ?? order.limit_price ?? 0);
        const remaining = Number(order.size_matched ?? order.remaining ?? order.size ?? 0);
        const original = Number(
            order.original_size ?? order.making_amount ?? order.total_size ?? remaining,
        );
        const slug = order.marketSlug || order.slug || null;
        const marketLabel =
            order.marketQuestion || order.question || order.market || (slug ? shorten(slug) : "—");
        const marketCell = slug
            ? `<a class="link" href="${POLY_EVENT_BASE_URL}${slug}" target="_blank" rel="noreferrer">${marketLabel}</a>`
            : marketLabel;
        const accountInfo = order.account || {};
        const accountAddress = accountInfo.address || "";
        if (accountAddress) {
            ensureManualAccountMeta(accountAddress);
        }
        // pkIdx 直接从 order.pkIdx 读取（后端在 /api/open-orders 中设置）
        const pkIdxValue = Number(order.pkIdx ?? accountInfo.pkIdx);
        const pkIdx = Number.isInteger(pkIdxValue) ? pkIdxValue : null;
        const cancelDisabledAttr = pkIdx === null ? ' disabled title="该账号未托管，无法撤单"' : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `
  <td data-th="订单ID">${shorten(order.id || order.order_id || "")}</td>
  <td data-th="市场">${marketCell}</td>
  <td data-th="方向"><span class="${sideLabel.includes("BUY") || sideLabel.includes("BID") ? "green" : "red"}">${sideLabel}</span></td>
  <td data-th="价格">${formatPrice(price)}</td>
  <td data-th="初始数量">${f2(original)}</td>
  <td data-th="成交数量">${f2(remaining)}</td>
  <td data-th="状态">${order.status || order.state || "live"}</td>
  <td data-th="创建时间">${parseOrderTime(order.created_time || order.created_at || order.timestamp)}</td>
  <td data-th="操作">
    <button class="cancel-btn" data-order-id="${order.id || order.order_id || ""}" data-pkidx="${pkIdx ?? ""}"${cancelDisabledAttr}>撤单</button>
  </td>
`;
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".cancel-btn").forEach((button) => {
        button.addEventListener("click", () => {
            const orderId = button.dataset.orderId;
            const pkIdx = Number.isFinite(Number(button.dataset.pkidx))
                ? Number(button.dataset.pkidx)
                : null;
            if (!orderId) {
                alert("缺少 orderId，无法撤单");
                return;
            }
            if (pkIdx === null) {
                alert("该账号未托管，无法撤单");
                return;
            }
            cancelOpenOrder(orderId, pkIdx, button);
        });
    });
}

async function fetchPositionsFor(addresses = []) {
    const tasks = addresses.map(async (address) => {
        const normalized = normalizeAddress(address);
        try {
            const rows = await fetchPositions(address);
            return { address: normalized, rows: Array.isArray(rows) ? rows : [] };
        } catch (error) {
            return { address: normalized, rows: [], error };
        }
    });
    const results = await Promise.all(tasks);
    const rows = [];
    const errors = [];
    results.forEach(({ address, rows: items, error }) => {
        if (!address) return;
        ensureManualAccountMeta(address);
        if (error) {
            errors.push({ address, error });
            return;
        }
        items.forEach((row) => {
            rows.push({
                ...row,
                __accountAddress: address,
            });
        });
    });
    return { rows, errors };
}

async function fetchTradesFor(addresses = []) {
    const tasks = addresses.map(async (address) => {
        const normalized = normalizeAddress(address);
        if (!normalized) {
            return [];
        }
        try {
            const trades = await fetchTrades(address);
            return trades;
        } catch (error) {
            return [];
        }
    });
    let  trades = await Promise.all(tasks);
    trades = trades.flat().sort((a, b) => (b.match_time || 0) - (a.match_time || 0));
    return trades;
}

async function refreshOpenOrdersSection() {
    const status = $("openOrderStatus");
    if (status) {
        status.textContent = "刷新挂单…";
        status.classList.add("loading");
    }
    try {
        const orders = await fetchOpenOrders();
        renderOpenOrders(Array.isArray(orders) ? orders : []);
    } catch (err) {
        console.error("Failed to refresh open orders:", err);
        if (status) status.textContent = "挂单刷新失败";
        const tbody = $("openOrderBody");
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="9" class="muted" data-th="提示">挂单刷新失败</td></tr>`;
        }
    } finally {
        if (status) status.classList.remove("loading");
    }
}

async function refreshTradesSection(addresses = getActiveAddresses()) {
    const tradeHint = $("tradeStatus");
    if (!addresses.length) {
        if (tradeHint) tradeHint.textContent = "等待加载…";
        return;
    }
    if (tradeHint) {
        tradeHint.textContent = "刷新成交…";
        tradeHint.classList.add("loading");
    }
    try {
        const trades = await fetchTradesFor(addresses);
        renderTrades(trades);
    } catch (err) {
        console.error("Failed to refresh trades:", err);
        if (tradeHint) tradeHint.textContent = "成交刷新失败";
        const tbody = $("tradeBody");
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="9" class="muted" data-th="提示">成交刷新失败</td></tr>`;
        }
    } finally {
        if (tradeHint) tradeHint.classList.remove("loading");
    }
}

async function refreshPositionsSection(addresses = getActiveAddresses()) {
    const st = $("status");
    if (!addresses.length) {
        if (st) st.textContent = "请先选择至少一个账户";
        return;
    }
    if (st) {
        st.textContent = "刷新资产…";
        st.classList.add("loading");
    }
    try {
        const result = await fetchPositionsFor(addresses);
        cachedPositions = result.rows;
        const pnl = await renderPositions(cachedPositions, { accountMetaMap: accountMetaByAddress });
        if (st) {
            st.textContent = `已加载 ${cachedPositions.length} 条持仓`;
        }
        return pnl;
    } catch (err) {
        console.error("Failed to refresh positions:", err);
        if (st) st.textContent = "资产刷新失败";
    } finally {
        if (st) st.classList.remove("loading");
    }
}

// 重新渲染已缓存的持仓数据（不重新获取）
async function rerenderCachedPositions() {
    if (cachedPositions.length > 0) {
        await renderPositions(cachedPositions, { accountMetaMap: accountMetaByAddress });
    }
}

const toastContainer = $("toastContainer");

function showToast({ title = "提示", message = "" }) {
    if (!toastContainer) return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<strong>${title}</strong><div>${message}</div>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.remove();
    }, 4000);
}

async function cancelOpenOrder(orderId, pkIdx, button) {
    if (!orderId) return;
    const numericPkIdx = Number(pkIdx);
    if (!Number.isInteger(numericPkIdx)) {
        alert("未找到托管账号，无法撤单");
        return;
    }
    const confirmed = confirm(`确认撤销订单 ${shorten(orderId)} 吗？`);
    if (!confirmed) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "撤单中…";
    try {
        const res = await fetch("/api/cancel-order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId, pkIdx: numericPkIdx }),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body?.message || body?.error || `HTTP ${res.status}`);
        }
        await refreshOpenOrdersSection();
        showToast({ title: "撤单成功", message: `订单 ${shorten(orderId)} 已撤销` });
    } catch (err) {
        alert(`撤单失败：${err.message || err}`);
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function renderTrades(trades) {
    const tbody = $("tradeBody");
    const status = $("tradeStatus");
    tbody.innerHTML = "";

    const normalizeNumber = (value) => {
        if (value === undefined || value === null) return 0;
        const num = Number(value);
        return Number.isFinite(num) ? num : 0;
    };

    const flatTrades = Array.isArray(trades) ? trades.flat() : [];

    if (!flatTrades.length) {
        status.textContent = "最近3天暂无成交";
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="9" class="muted" data-th="提示">最近3天暂无成交</td>`;
        tbody.appendChild(tr);
        return;
    }

    flatTrades.forEach((trade) => {
        const price = normalizeNumber(trade.price ?? trade.order_price);
        const size = normalizeNumber(trade.matched_amount ?? trade.size ?? trade.amount);
        const notional = price * size;
        const rawMatchTime = trade.match_time ?? trade.matchTime;
        const numericMatchTime = Number(rawMatchTime);
        const matchTime =
            Number.isFinite(numericMatchTime) && numericMatchTime > 0
                ? numericMatchTime * 1000
                : undefined;
        const marketLabel = trade.question || "—";
        const orderIdLabel = shorten(trade.order_id || trade.orderId || "");
        const outcome = trade.outcome || "—";
        const accountAddress = trade.__accountAddress || "";
        if (accountAddress) {
            ensureManualAccountMeta(accountAddress);
        }
        const trEl = document.createElement("tr");
        trEl.innerHTML = `
  <td data-th="市场">${marketLabel}</td>
  <td data-th="订单ID">${orderIdLabel}</td>
  <td data-th="市场方向">${outcome}</td>
  <td data-th="订单方向"><span class="${trade.side === "BUY" ? "green" : "red"}">${trade.side || "—"}</span></td>
  <td data-th="价格" class="right">${formatPrice(price)}</td>
  <td data-th="数量" class="right">${f2(size)}</td>
  <td data-th="成交额" class="right">${fmtMoney(notional)}</td>
  <td data-th="成交时间">${formatTs(matchTime)}</td>
  <td data-th="Tx">
    ${
        trade.transactionHash
            ? `<a class="link" href="https://polygonscan.com/tx/${trade.transactionHash}" target="_blank" rel="noreferrer">${shorten(trade.transactionHash)}</a>`
            : '<span class="muted">—</span>'
    }
  </td>`;
        tbody.appendChild(trEl);
    });

    status.textContent = `最近 ${flatTrades.length} 条成交（≤3天）`;
}

function calculateRealizedPnl(trades) {
    if (!Array.isArray(trades)) return { last24h: 0, total: 0 };

    const flatTrades = trades.flat();
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;

    const normalizeNumber = (value) => {
        if (value === undefined || value === null) return 0;
        const num = Number(value);
        return Number.isFinite(num) ? num : 0;
    };

    // 按 tokenId 分组，计算每个 token 的已实现盈亏
    const tokenMap = new Map();

    flatTrades.forEach((trade) => {
        const tokenId = trade.asset_id || trade.assetId || trade.token_id || trade.tokenId || "";
        const price = normalizeNumber(trade.price ?? trade.order_price);
        const size = normalizeNumber(trade.matched_amount ?? trade.size ?? trade.amount);
        const side = (trade.side || "").toUpperCase();
        const rawMatchTime = trade.match_time ?? trade.matchTime;
        const numericMatchTime = Number(rawMatchTime);
        const matchTime =
            Number.isFinite(numericMatchTime) && numericMatchTime > 0
                ? numericMatchTime * 1000
                : undefined;

        if (!tokenId || !matchTime) return;

        if (!tokenMap.has(tokenId)) {
            tokenMap.set(tokenId, []);
        }
        tokenMap.get(tokenId).push({ price, size, side, matchTime });
    });

    let last24hPnl = 0;
    let totalPnl = 0;

    // 对每个 token 计算已实现盈亏（FIFO 方法）
    tokenMap.forEach((trades, tokenId) => {
        // 按时间排序
        trades.sort((a, b) => a.matchTime - b.matchTime);

        const buyQueue = [];
        let last24hRealized = 0;
        let totalRealized = 0;

        trades.forEach((trade) => {
            const isLast24h = trade.matchTime >= last24h;

            if (trade.side === "BUY" || trade.side === "BID") {
                buyQueue.push({ price: trade.price, size: trade.size, matchTime: trade.matchTime });
            } else if (trade.side === "SELL" || trade.side === "ASK") {
                let remaining = trade.size;

                while (remaining > 0 && buyQueue.length > 0) {
                    const buy = buyQueue[0];
                    const matched = Math.min(remaining, buy.size);
                    const pnl = (trade.price - buy.price) * matched;

                    if (isLast24h || buy.matchTime >= last24h) {
                        last24hRealized += pnl;
                    }
                    totalRealized += pnl;

                    remaining -= matched;
                    buy.size -= matched;

                    if (buy.size <= 0) {
                        buyQueue.shift();
                    }
                }
            }
        });

        last24hPnl += last24hRealized;
        totalPnl += totalRealized;
    });

    return { last24h: last24hPnl, total: totalPnl };
}

function updatePnlDashboard({ currentPnl, currentPnlPct, last24hPnl, totalPnl }) {
    const currentPnlEl = $("currentPnl");
    const currentPnlPctEl = $("currentPnlPct");
    const last24hPnlEl = $("last24hPnl");
    const last24hPnlPctEl = $("last24hPnlPct");
    const totalPnlEl = $("totalPnl");
    const totalPnlPctEl = $("totalPnlPct");

    // 当前浮动盈亏（只在传入时更新）
    if (currentPnl !== undefined && currentPnlEl) {
        const colorClass = currentPnl >= 0 ? "green" : "red";
        currentPnlEl.innerHTML = `<span class="${colorClass}">${(currentPnl >= 0 ? "+" : "") + fmtMoney(currentPnl)}</span>`;
    }
    if (currentPnlPct !== undefined && currentPnlPctEl) {
        const colorClass = currentPnlPct >= 0 ? "green" : "red";
        currentPnlPctEl.innerHTML = `<span class="${colorClass}">${(currentPnlPct >= 0 ? "+" : "") + (currentPnlPct * 100).toFixed(2)}%</span>`;
    }

    // 最近24h盈亏（只在传入时更新）
    if (last24hPnl !== undefined) {
        if (last24hPnlEl) {
            if (last24hPnl === null) {
                last24hPnlEl.textContent = "—";
            } else {
                const colorClass = last24hPnl >= 0 ? "green" : "red";
                last24hPnlEl.innerHTML = `<span class="${colorClass}">${(last24hPnl >= 0 ? "+" : "") + fmtMoney(last24hPnl)}</span>`;
            }
        }
        if (last24hPnlPctEl) {
            last24hPnlPctEl.textContent = "";
        }
    }

    // 至今盈亏 = 当前浮动盈亏 + 已实现盈亏（只在传入时更新）
    if (totalPnl !== undefined && currentPnl !== undefined) {
        const total = currentPnl + totalPnl;
        if (totalPnlEl) {
            if (totalPnl === null) {
                totalPnlEl.textContent = "—";
            } else {
                const colorClass = total >= 0 ? "green" : "red";
                totalPnlEl.innerHTML = `<span class="${colorClass}">${(total >= 0 ? "+" : "") + fmtMoney(total)}</span>`;
            }
        }
        if (totalPnlPctEl) {
            totalPnlPctEl.textContent = "";
        }
    }
}

async function handleCloseOrder(tokenId, rowId, side, pkIdx) {
    if (!tokenId) {
        alert("缺少 tokenId，无法平仓");
        return;
    }
    const numericPkIdx = Number(pkIdx);
    if (!Number.isInteger(numericPkIdx)) {
        alert("该账号未托管，无法平仓");
        return;
    }

    const priceInput = document.getElementById(`${rowId}-price`);
    const sizeInput = document.getElementById(`${rowId}-size`);
    const actionContainer = priceInput?.parentElement;
    const button = actionContainer?.querySelector("button");
    if (!priceInput || !sizeInput || !button) {
        alert("平仓控件缺失，请刷新页面后再试");
        return;
    }
    const price = parsePriceInput(priceInput.value);
    const size = Number(sizeInput.value);

    // 价格校验：双开区间 (0, 1)，不包含0和1
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
        alert(`请输入有效的价格（大于 0% 且小于 100%）`);
        return;
    }
    const bestBidAttr = button.dataset?.bestBid;
    const currentBestBid = Number(bestBidAttr);
    if (Number.isFinite(currentBestBid) && price < currentBestBid) {
        alert(`卖单价格需≥当前最优买价 ${formatPrice(currentBestBid)}`);
        return;
    }

    if (!size || size <= 0) {
        alert("请输入有效的数量");
        return;
    }

    // Round price to 3 decimal places to avoid floating point precision issues
    const roundedPrice = Math.round(price * 1000) / 1000;

    if (!confirm(`确认平仓？\n价格: ${formatPrice(roundedPrice)}\n数量: ${size}\n方向: ${side}`)) {
        return;
    }

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "提交中...";

    try {
        const result = await placeCloseOrder(tokenId, roundedPrice, size, side, numericPkIdx);
        if (result.error) {
            alert(`平仓失败: ${result.error || "未知错误"}`);
        } else {
            await refreshOpenOrdersSection();
            showToast({
                title: "平仓成功",
                message: `订单 ${shorten(result.orderID || "")} 状态 ${result.status}`,
            });
        }
    } catch (err) {
        if (
            err?.code === "not enough balance / allowance" ||
            err?.message?.includes("not enough balance")
        ) {
            alert("平仓失败：账户余额或授权不足，请先补充/授权后再试。");
        } else {
            alert(`平仓失败: ${err?.message || "未知错误"}`);
        }
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

async function load() {
    const addresses = getActiveAddresses();
    if (!addresses.length) {
        alert("请先选择至少一个账户");
        return;
    }
    const st = $("status");
    const tradeHint = $("tradeStatus");
    const openOrderHint = $("openOrderStatus");
    if (st) {
        st.textContent = "加载中…";
        st.classList.add("loading");
    }
    if (tradeHint) {
        tradeHint.textContent = "加载最近成交…";
        tradeHint.classList.add("loading");
    }
    if (openOrderHint) {
        openOrderHint.textContent = "加载挂单…";
        openOrderHint.classList.add("loading");
    }
    try {
        const [positionResult, tradesResult, openOrders] = await Promise.all([
            fetchPositionsFor(addresses),
            fetchTradesFor(addresses),
            fetchOpenOrders().catch((err) => {
                console.error("Failed to fetch open orders:", err);
                return null;
            }),
        ]);

        cachedPositions = positionResult.rows;
        const positionPnl = await renderPositions(cachedPositions, {
            accountMetaMap: accountMetaByAddress,
        });
        if (st) {
            st.textContent = `已加载 ${cachedPositions.length} 条持仓`;
        }

        renderTrades(tradesResult);
        const openOrdersList = Array.isArray(openOrders) ? openOrders : [];
        renderOpenOrders(openOrdersList);
        if (openOrderHint) {
            openOrderHint.textContent = Array.isArray(openOrders)
                ? `共有 ${openOrders.length} 条挂单`
                : "挂单加载失败";
        }

        const realizedPnl = calculateRealizedPnl(tradesResult);
        const currentPnl = positionPnl?.currentPnl ?? 0;
        const currentPnlPct = positionPnl?.currentPnlPct ?? 0;
        updatePnlDashboard({
            currentPnl,
            currentPnlPct,
            last24hPnl: realizedPnl.last24h,
            totalPnl: realizedPnl.total,
        });
    } catch (err) {
        console.error(err);
        if (st) st.textContent = "加载失败（请检查网络/CORS 或稍后重试）";
    } finally {
        if (st) st.classList.remove("loading");
        if (tradeHint) tradeHint.classList.remove("loading");
        if (openOrderHint) openOrderHint.classList.remove("loading");
    }
}

$("refresh").addEventListener("click", load);
const positionRefreshBtn = $("positionRefresh");
if (positionRefreshBtn) {
    positionRefreshBtn.addEventListener("click", () => refreshPositionsSection());
}
const hideSmallPositionsCheckbox = $("hideSmallPositions");
if (hideSmallPositionsCheckbox) {
    hideSmallPositionsCheckbox.addEventListener("change", () => {
        // 如果有缓存的数据，直接重新渲染；否则刷新
        if (cachedPositions.length > 0) {
            rerenderCachedPositions();
        } else {
            refreshPositionsSection();
        }
    });
}
const openOrderRefreshBtn = $("openOrderRefresh");
if (openOrderRefreshBtn) {
    openOrderRefreshBtn.addEventListener("click", () => refreshOpenOrdersSection());
}
const tradeRefreshBtn = $("tradeRefresh");
if (tradeRefreshBtn) {
    tradeRefreshBtn.addEventListener("click", () => refreshTradesSection());
}
window.handleCloseOrder = handleCloseOrder;

// 初始化：加载当前地址
(async () => {
    const accounts = await initAccountsPanel();
    if (!accounts.length) {
        try {
            const address = await fetchCurrentAddress();
            if (address) {
                $("addr").value = address;
            }
        } catch (err) {
            console.error("Failed to fetch current address:", err);
        }
    }
    load();
})();
