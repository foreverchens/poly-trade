import express from "express";
import path from "path";
import {fileURLToPath} from "url";
import axios from "axios";
import {
    buildClient,
    getAccount,
    getAccountWithBalance,
    activeClientMap,
    getDefaultClient,
} from "./core/poly-client-manage.js";
import {getBalances, transferPOL, transferUSDC} from "./core/ether-client.js";
import {listOrders, deleteOrder, updateOrder, getBalanceHistory} from "./db/repository.js";
import {getMinuteSamples} from "./db/statisc-repository.js";
import {
    listConvergenceTaskConfigs,
    getConvergenceTaskConfig,
    upsertConvergenceTaskConfig,
    deleteConvergenceTaskConfig,
} from "./db/convergence-task-config-repository.js";
import { log } from "console";

const PORT = process.env.PORT || 3001;
const BTC_PRICE_SOURCE = process.env.BTC_PRICE_SOURCE || "https://api.binance.com/api/v3/klines";
const BTC_PRICE_SYMBOL = process.env.BTC_PRICE_SYMBOL || "BTCUSDT";
const BTC_HISTORY_CACHE_TTL_MS = 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BTC_CANDLE_INTERVAL_MINUTES = 15;
const BTC_PROVIDER_INTERVAL = "15m";
const BTC_PROVIDER_INTERVAL_MS = BTC_CANDLE_INTERVAL_MINUTES * MINUTE_MS;
const BTC_CACHE_VERSION = "v15m";
const BTC_INTERVAL_CONFIG = {
    "1h": {durationMs: HOUR_MS},
    "6h": {durationMs: 6 * HOUR_MS},
    "1d": {durationMs: DAY_MS},
    "1w": {durationMs: 7 * DAY_MS},
    max: {durationMs: 180 * DAY_MS},
};
const DEFAULT_BTC_INTERVAL = "1d";
const MAX_BINANCE_LIMIT = 1000;
const MAX_BINANCE_BATCHES = 24;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewDir = path.join(__dirname, "view");

const polyClient = await getDefaultClient();

const app = express();
app.use(express.json());
const SUPPORTED_TAGS = new Set([21, 235, 39,101267,818]);
const DEFAULT_TAG_ID = 235;
const CLIENT_ERROR_PATTERNS = [/market is required/i, /Invalid interval/i];
// 主应用路由（独立页面路由已整合到主应用中，不再单独列出）
const MAIN_APP_ROUTE = {label: "Polymarket 管理平台", path: "/"};
const TRADE_LOOKBACK_DAYS = 3;
const MAX_TRADE_ITEMS = 10;

// ============================================================================
// API 路由 - 市场数据相关
// ============================================================================

app.get("/api/crypto-markets", async (req, res) => {
    try {
        const requestedTag = Number.parseInt(req.query.tag, 10);
        const tagId = SUPPORTED_TAGS.has(requestedTag) ? requestedTag : DEFAULT_TAG_ID;
        const markets = await polyClient.listCryptoMarketSortedByEndDate(tagId);
        res.json(markets);
    } catch (err) {
        console.error("Failed to fetch crypto markets:", err.message);
        const status = err.response?.status || 500;
        res.status(status).json({
            error: "failed_to_fetch_markets",
            message: err.response?.data || err.message,
        });
    }
});

app.get("/api/price-history", async (req, res) => {
    try {
        const {market, interval} = req.query;
        const payload = await polyClient.getPricesHistory(market, interval);
        res.json(payload);
    } catch (err) {
        console.error("Failed to fetch price history:", err.message);
        const isClientError = CLIENT_ERROR_PATTERNS.some((pattern) => pattern.test(err.message ?? ""));
        const status = isClientError ? 400 : err.response?.status || 500;
        res.status(status).json({
            error: "failed_to_fetch_price_history",
            message: err.response?.data || err.message,
        });
    }
});

app.get("/api/btc-history", async (req, res) => {
    try {
        const interval = normalizeBtcInterval(req.query.interval);

        // 如果指定了 btcInterval 和 limit，则使用这些参数
        const options = {};
        if (req.query.btcInterval === "1m") {
            options.btcInterval = "1m";
            options.btcIntervalMs = MINUTE_MS;
        }
        if (req.query.limit) {
            const limit = Number.parseInt(req.query.limit, 10);
            if (Number.isFinite(limit) && limit > 0) {
                options.limit = limit;
            }
        }

        const btcIntervalMs = options.btcIntervalMs || BTC_PROVIDER_INTERVAL_MS;
        const customRange = normalizeBtcRange(req.query.start, req.query.end, btcIntervalMs);
        const history = await getBtcHistory(interval, customRange, Object.keys(options).length > 0 ? options : undefined);
        res.json({history});
    } catch (err) {
        console.error("Failed to fetch BTC price history:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_btc_history",
            message: err.response?.data || err.message,
        });
    }
});

// ============================================================================
// API 路由 - 订单簿与价格
// ============================================================================

app.get("/api/orderbook/:tokenId", async (req, res) => {
    try {
        const {tokenId} = req.params;
        const orderBook = await polyClient.getOrderBook(tokenId);
        res.json(orderBook);
    } catch (err) {
        console.error("Failed to fetch order book:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_orderbook",
            message: err.response?.data || err.message,
        });
    }
});

app.get("/api/hour-minute-samples", async (req, res) => {
    const marketSlug = typeof req.query.market_slug === "string" ? req.query.market_slug.trim() : "";
    if (!marketSlug) {
        return res.status(400).json({
            error: "missing_market_slug",
            message: "market_slug is required",
        });
    }

    try {
        const samples = await getMinuteSamples(marketSlug);
        res.json({
            market_slug: marketSlug,
            count: samples.length,
            samples,
        });
    } catch (err) {
        console.error("Failed to fetch hour minute samples:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_hour_minute_samples",
            message: err.response?.data || err.message,
        });
    }
});

// ============================================================================
// API 路由 - 交易与订单管理
// ============================================================================

app.get("/api/trades", async (req, res) => {
    try {
        const {address} = req.query;
        if (!address || typeof address !== "string") {
            return res.status(400).json({error: "missing_address", message: "address is required"});
        }

        const normalized = address.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
            return res.status(400).json({error: "invalid_address", message: "address must be a valid EVM address"});
        }
        const client = Array.from(activeClientMap().values()).find((client) => client.funderAddress === normalized);
        if (!client) {
            return res.status(400).json({error: "account_not_found", message: "account not found"});
        }
        const trades = await client.listMyTrades({makerAddress: normalized});
        res.json(trades);
    } catch (err) {
        console.error("Failed to fetch trades:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_trades",
            message: err.response?.data || err.message,
        });
    }
});

app.get("/api/open-orders", async (req, res) => {
    try {
        const {market, assetId} = req.query;
        const clients = activeClientMap();
        if (!clients.size) {
            return res.json([]);
        }
        const allOrders = [];
        for (const client of clients.values()) {
            if (!client) continue;
            const orders = await client.listOpenOrders({
                market: market || undefined,
                assetId: assetId || undefined,
            });
            orders.map((order) => {
                order.pkIdx = client.pkIdx;
                return order;
            });
            await enrichOrdersWithMarketMeta(orders,client);
            allOrders.push(...orders);
        }
        res.json(allOrders);
    } catch (err) {
        console.error("Failed to fetch open orders:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_open_orders",
            message: err.response?.data || err.message,
        });
    }
});

// ============================================================================
// API 路由 - 收敛任务配置
// ============================================================================

app.get("/api/convergence-tasks", async (_req, res) => {
    try {
        const configs = await listConvergenceTaskConfigs();
        const enriched = await attachAccountDetails(configs);
        res.json({count: enriched.length, items: enriched});
    } catch (err) {
        console.error("Failed to list convergence tasks:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_list_convergence_tasks",
            message: err.message,
        });
    }
});

app.get("/api/convergence-tasks/:slug", async (req, res) => {
    try {
        const {slug} = req.params;
        if (!slug) {
            throw validationError("slug 不能为空");
        }
        const task = await getConvergenceTaskConfig(slug);
        if (!task) {
            return res.status(404).json({
                error: "convergence_task_not_found",
                message: `任务 ${slug} 不存在`,
            });
        }
        const [enriched] = await attachAccountDetails([task]);
        res.json(enriched || task);
    } catch (err) {
        console.error("Failed to fetch convergence task:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_fetch_convergence_task",
            message: err.message,
        });
    }
});

app.post("/api/convergence-tasks", async (req, res) => {
    try {
        const payload = buildTaskConfigPayload(req.body || {});
        const saved = await upsertConvergenceTaskConfig(payload);
        res.status(201).json(saved);
    } catch (err) {
        console.error("Failed to create convergence task:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_create_convergence_task",
            message: err.message,
        });
    }
});

app.put("/api/convergence-tasks/:slug", async (req, res) => {
    try {
        const {slug} = req.params;
        const payload = buildTaskConfigPayload(req.body || {}, {slugFromParams: slug});
        const saved = await upsertConvergenceTaskConfig(payload);
        res.json(saved);
    } catch (err) {
        console.error("Failed to update convergence task:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_update_convergence_task",
            message: err.message,
        });
    }
});

app.delete("/api/convergence-tasks/:slug", async (req, res) => {
    try {
        const {slug} = req.params;
        if (!slug) {
            throw validationError("slug 不能为空");
        }
        await deleteConvergenceTaskConfig(slug);
        res.json({success: true});
    } catch (err) {
        console.error("Failed to delete convergence task:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_delete_convergence_task",
            message: err.message,
        });
    }
});



/**
 * 获取最优买卖价格
 * @route GET /api/best-prices/:tokenId
 * @returns {Object} {
 *   bestBid: number,    // 最优买价（最高买价，bids数组最后一个元素）
 *   bestAsk: number,    // 最优卖价（最低卖价，asks数组最后一个元素）
 *   tokenId: string     // token ID
 * }
 */
// ============================================================================
// API 路由 - 账户与余额管理
// ============================================================================

app.get("/api/best-prices/:tokenId", async (req, res) => {
    try {
        const {tokenId} = req.params;
        const orderBook = await polyClient.getOrderBook(tokenId);

        // 提取最优买价和最优卖价
        // 注意：bids数组按价格从低到高排序，最优买价（最高价）在数组末尾
        //      asks数组按价格从高到低排序，最优卖价（最低价）在数组末尾
        const bestBid = orderBook.bids && orderBook.bids.length > 0
            ? Number(orderBook.bids[orderBook.bids.length - 1].price)
            : null;
        const bestAsk = orderBook.asks && orderBook.asks.length > 0
            ? Number(orderBook.asks[orderBook.asks.length - 1].price)
            : null;

        res.json({
            bestBid,
            bestAsk,
            tokenId,
        });
    } catch (err) {
        console.error("Failed to fetch best prices:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_best_prices",
            message: err.response?.data || err.message,
        });
    }
});

app.get("/api/available-clients", async (_req, res) => {
    try {
        const clients = activeClientMap();
        const clientList = Array.from(clients.keys()).map((pkIdx) => ({
            pkIdx,
        }));
        res.json(clientList);
    } catch (err) {
        console.error("Failed to fetch available clients:", err.message);
        res.status(500).json({
            error: "failed_to_fetch_clients",
            message: err.message,
        });
    }
});

app.post("/api/place-order", async (req, res) => {
    try {
        const {price, size, side, tokenId, pkIdx} = req.body;
        logger.info(`[place-order] ${price}, ${size}, ${side}, ${tokenId}, ${pkIdx}`);
        if (!price || !size || !side || !tokenId) {
            return res.status(400).json({
                error: "missing_parameters",
                message: "price, size, side, and tokenId are required",
            });
        }
        const client = activeClientMap().get(Number(pkIdx));
        if (!client) {
            return res.status(400).json({
                error: "client_not_found",
                message: `No client found for pkIdx: ${pkIdx}`,
            });
        }
        const result = await client.placeOrder(price, size, side, tokenId);
        res.json(result);
    } catch (err) {
        console.error("Failed to place order:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_place_order",
            message: err.response?.data || err.message,
        });
    }
});

app.post("/api/cancel-order", async (req, res) => {
    try {
        const {orderId, pkIdx} = req.body;
        if (!orderId) {
            return res.status(400).json({
                error: "missing_order_id",
                message: "orderId is required",
            });
        }
        const client = activeClientMap().get(pkIdx);
        if (!client) {
            return res.status(400).json({
                error: "client_not_found",
                message: `No client found for pkIdx: ${pkIdx}`,
            });
        }
        const result = await client.cancelOrder(orderId);
        res.json(result);
    } catch (err) {
        console.error("Failed to cancel order:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_cancel_order",
            message: err.response?.data || err.message,
        });
    }
});

app.get("/api/current-address", async (req, res) => {
    try {
        const clients = Array.from(activeClientMap().values());
        const addresses = clients.map((client) => client.funderAddress);
        res.json({addresses, address: addresses[0] || null});
    } catch (err) {
        console.error("Failed to get current address:", err.message);
        res.status(500).json({error: "failed_to_get_address", message: err.message});
    }
});

app.get("/api/accounts", async (_req, res) => {
    try {
        const configs = await listConvergenceTaskConfigs();
        const uniqueIndices = [
            ...new Set(
                configs
                    .map((config) => (Number.isInteger(config?.task?.pkIdx) ? config.task.pkIdx : null))
                    .filter((idx) => Number.isInteger(idx)),
            ),
        ].sort((a, b) => a - b);

        const accounts = await Promise.all(
            uniqueIndices.map(async (idx) => {
                try {
                    const account = getAccount(idx);
                    const balances = await getBalances(account.address);
                    return {
                        pkIdx: idx,
                        address: account.address,
                        polBalance: balances.pol,
                        usdcBalance: balances.usdc,
                    };
                } catch (err) {
                    console.error(`[accounts] Failed to fetch account #${idx}:`, err.message);
                    const account = getAccount(idx);
                    return {
                        pkIdx: idx,
                        address: account.address,
                        polBalance: null,
                        usdcBalance: null,
                        error: err.message,
                    };
                }
            }),
        );

        res.json({count: accounts.length, items: accounts});
    } catch (err) {
        console.error("Failed to list accounts:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_list_accounts",
            message: err.message,
        });
    }
});

app.post("/api/accounts/:pkIdx/transfer-pol", async (req, res) => {
    try {
        const {pkIdx} = req.params;
        const {to, amount} = req.body;

        if (!to || !amount) {
            return res.status(400).json({
                error: "invalid_params",
                message: "to 和 amount 参数不能为空",
            });
        }

        const idx = parseInt(pkIdx, 10);
        if (!Number.isInteger(idx)) {
            return res.status(400).json({
                error: "invalid_pkIdx",
                message: "pkIdx 必须是整数",
            });
        }

        const account = getAccount(idx);
        const result = await transferPOL(account.privateKey, to, amount);

        res.json({
            success: true,
            hash: result.hash,
            from: result.from,
            to: result.to,
            value: result.value,
        });
    } catch (err) {
        console.error("Failed to transfer POL:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_transfer_pol",
            message: err.message,
        });
    }
});

app.post("/api/accounts/:pkIdx/transfer-usdc", async (req, res) => {
    try {
        const {pkIdx} = req.params;
        const {to, amount} = req.body;

        if (!to || !amount) {
            return res.status(400).json({
                error: "invalid_params",
                message: "to 和 amount 参数不能为空",
            });
        }

        const idx = parseInt(pkIdx, 10);
        if (!Number.isInteger(idx)) {
            return res.status(400).json({
                error: "invalid_pkIdx",
                message: "pkIdx 必须是整数",
            });
        }

        const account = getAccount(idx);
        const result = await transferUSDC(account.privateKey, to, amount);

        res.json({
            success: true,
            hash: result.hash,
            from: result.from,
            to: result.to,
            value: result.value,
        });
    } catch (err) {
        console.error("Failed to transfer USDC:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_transfer_usdc",
            message: err.message,
        });
    }
});

app.get("/api/balance-history", async (req, res) => {
    try {
        const days = req.query.days ? parseInt(req.query.days, 10) : 7;
        const balanceLogs = await getBalanceHistory({days});
        res.json({count: balanceLogs.length, items: balanceLogs});
    } catch (err) {
        console.error("Failed to get balance history:", err.message);
        res.status(err.statusCode || err.status || 500).json({
            error: "failed_to_get_balance_history",
            message: err.message,
        });
    }
});


app.use(express.static(viewDir));
const btcHistoryCache = new Map();

async function attachAccountDetails(configs = []) {
    if (!Array.isArray(configs) || configs.length === 0) {
        return configs;
    }

    const indices = [
        ...new Set(
            configs
                .map((config) => (Number.isInteger(config?.task?.pkIdx) ? config.task.pkIdx : null))
                .filter((idx) => Number.isInteger(idx)),
        ),
    ];
    if (!indices.length) {
        return configs.map((config) => ({
            ...config,
            account: null,
        }));
    }

    const accountEntries = await Promise.all(
        indices.map(async (idx) => {
            try {
                const account = await getAccountWithBalance(idx);
                return [
                    idx,
                    {
                        idx,
                        address: account.address,
                        usdcBalance: account.usdcBalance ?? null,
                    },
                ];
            } catch (err) {
                console.error(
                    `[convergence-tasks] Failed to fetch account #${idx}:`,
                    err.message,
                );
                try {
                    const fallback = getAccount(idx);
                    return [
                        idx,
                        {
                            idx,
                            address: fallback.address,
                            usdcBalance: null,
                        },
                    ];
                } catch (deriveErr) {
                    console.error(
                        `[convergence-tasks] Failed to derive address for #${idx}:`,
                        deriveErr.message,
                    );
                    return [idx, null];
                }
            }
        }),
    );

    const accountMap = new Map(accountEntries.filter(([, value]) => Boolean(value)));

    return configs.map((config) => {
        const pkIdx = Number.isInteger(config?.task?.pkIdx) ? config.task.pkIdx : null;
        return {
            ...config,
            account: pkIdx !== null ? accountMap.get(pkIdx) || null : null,
        };
    });
}

function normalizeBtcInterval(value) {
    const key = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (key && BTC_INTERVAL_CONFIG[key]) {
        return key;
    }
    return DEFAULT_BTC_INTERVAL;
}

function normalizeBtcRange(startValue, endValue, btcIntervalMs = BTC_PROVIDER_INTERVAL_MS) {
    if (startValue === undefined || endValue === undefined) return null;
    const startNum = Number(startValue);
    const endNum = Number(endValue);
    if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return null;
    const orderedStart = Math.min(startNum, endNum);
    const orderedEnd = Math.max(startNum, endNum);
    const now = Date.now();
    const safeEnd = Math.min(orderedEnd, now);
    const safeStart = Math.max(0, Math.min(orderedStart, safeEnd - btcIntervalMs));
    if (safeEnd - safeStart < btcIntervalMs) {
        return {
            startTime: safeStart,
            endTime: safeStart + btcIntervalMs,
        };
    }
    return {
        startTime: safeStart,
        endTime: safeEnd,
    };
}

async function getBtcHistory(interval, customRange = null, options = null) {
    const key = interval || DEFAULT_BTC_INTERVAL;
    const useCache = !customRange;

    // 如果提供了 options，使用指定的 btcInterval 和 limit
    // 否则使用默认的 15 分钟间隔
    const btcInterval = options?.btcInterval || BTC_PROVIDER_INTERVAL;
    const btcIntervalMs = options?.btcIntervalMs || BTC_PROVIDER_INTERVAL_MS;
    const limit = options?.limit || null;

    const cacheKey = `${BTC_CACHE_VERSION}:${key}:${btcInterval}${limit ? `:${limit}` : ""}`;
    if (useCache) {
        const cached = btcHistoryCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < BTC_HISTORY_CACHE_TTL_MS) {
            return cached.history;
        }
    }
    const config = BTC_INTERVAL_CONFIG[key] || BTC_INTERVAL_CONFIG[DEFAULT_BTC_INTERVAL];
    const defaultDuration = config.durationMs ?? DAY_MS;
    const now = Date.now();
    const targetEnd = customRange?.endTime ?? now;

    // 如果指定了 limit，计算所需的时间范围（最近1小时）
    const durationMs = customRange
        ? Math.max(btcIntervalMs, customRange.endTime - customRange.startTime)
        : (limit ? limit * btcIntervalMs : defaultDuration);

    const targetStart = customRange?.startTime ?? Math.max(0, targetEnd - durationMs);
    const normalizedStart = Math.floor(targetStart / btcIntervalMs) * btcIntervalMs;
    const totalRange = Math.max(btcIntervalMs, (targetEnd - normalizedStart));
    const requiredCandles = limit
        ? Math.min(limit, Math.ceil(totalRange / btcIntervalMs) + 2)
        : Math.max(2, Math.ceil(totalRange / btcIntervalMs) + 2);

    const history = await fetchBtcCandles({
        startTime: normalizedStart,
        endTime: targetEnd,
        requiredCandles,
        interval: btcInterval,
        intervalMs: btcIntervalMs,
    });

    let filtered = history.filter(point => point.t >= targetStart && point.t <= targetEnd + btcIntervalMs);

    // 如果指定了 limit，只返回最近的 limit 根 k 线（按时间倒序取前 limit 根，然后按时间正序返回）
    if (limit && filtered.length > limit) {
        const sorted = filtered.sort((a, b) => b.t - a.t);
        filtered = sorted.slice(0, limit).sort((a, b) => a.t - b.t);
    }

    if (useCache) {
        btcHistoryCache.set(cacheKey, {timestamp: now, history: filtered});
    }
    return filtered;
}

async function fetchBtcCandles({startTime, endTime, requiredCandles, interval = BTC_PROVIDER_INTERVAL, intervalMs = BTC_PROVIDER_INTERVAL_MS}) {
    const points = [];
    let nextStart = startTime;
    let batchCount = 0;
    while (nextStart < endTime && points.length < requiredCandles && batchCount < MAX_BINANCE_BATCHES) {
        const remaining = requiredCandles - points.length;
        const limit = Math.min(MAX_BINANCE_LIMIT, Math.max(remaining, 10));
        const params = {
            symbol: BTC_PRICE_SYMBOL,
            interval: interval,
            limit,
            startTime: nextStart,
        };
        const response = await axios.get(BTC_PRICE_SOURCE, {params, timeout: 10_000});
        if (!Array.isArray(response.data) || !response.data.length) break;
        const batchPoints = response.data.map(entry => ({
            t: Number(entry?.[0]),
            p: Number(entry?.[4]),
        })).filter(point => Number.isFinite(point.t) && Number.isFinite(point.p));
        if (!batchPoints.length) break;
        points.push(...batchPoints);
        const lastTime = batchPoints[batchPoints.length - 1].t;
        if (!Number.isFinite(lastTime)) break;
        nextStart = lastTime + intervalMs;
        batchCount++;
    }
    return dedupeCandles(points).filter(point => point.t <= endTime + intervalMs);
}

function dedupeCandles(points) {
    const seen = new Set();
    return points.filter(point => {
        const key = point.t;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function enrichOrdersWithMarketMeta(orders,client) {
    for (let order of orders) {
        let conditionId = order.market;
        order.market = (await client.getMarketByConditionId(conditionId))[0].slug;
    }
    return orders;
}

function validationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function parseRequiredString(value, fieldName) {
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    throw validationError(`${fieldName} 不能为空`);
}

function parseNumberField(value, fieldName, {integer = false} = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        throw validationError(`${fieldName} 必须是数字`);
    }
    if (integer && !Number.isInteger(numeric)) {
        throw validationError(`${fieldName} 必须是整数`);
    }
    return numeric;
}

function parseBooleanField(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
    }
    return Boolean(value);
}

function buildTaskConfigPayload(body, {slugFromParams = null} = {}) {
    if (!body || typeof body !== "object") {
        throw validationError("请求体必须是对象");
    }

    const taskInput = body.task ?? {};
    const scheduleInput = body.schedule ?? {};
    const positionInput = body.position ?? {};
    const riskInput = body.riskControl ?? {};
    const riskPriceInput = riskInput.price ?? {};
    const riskTimeInput = riskInput.time ?? {};
    const riskStatsInput = riskInput.statistics ?? {};
    const riskLiquidityInput = riskInput.liquidity ?? {};
    const riskSpikeInput = riskInput.spikeProtection ?? {};

    const candidateSlug = taskInput.slug ?? body.slug ?? null;
    const slugBase = slugFromParams ?? candidateSlug;
    const slug = parseRequiredString(slugBase, "task.slug");
    if (slugFromParams && candidateSlug && slugFromParams !== candidateSlug) {
        throw validationError("URL 中的 slug 与请求体不一致");
    }

    const task = {
        name: parseRequiredString(taskInput.name, "task.name"),
        slug,
        symbol: parseRequiredString(taskInput.symbol, "task.symbol"),
        pkIdx: parseNumberField(taskInput.pkIdx, "task.pkIdx", {integer: true}),
        active: parseBooleanField(taskInput.active),
        test: parseBooleanField(taskInput.test),
    };

    const schedule = {
        cronExpression: parseRequiredString(scheduleInput.cronExpression, "schedule.cronExpression"),
        cronTimeZone: parseRequiredString(scheduleInput.cronTimeZone, "schedule.cronTimeZone"),
        tickIntervalSeconds: parseNumberField(
            scheduleInput.tickIntervalSeconds,
            "schedule.tickIntervalSeconds",
            {integer: true},
        ),
    };

    const position = {
        positionSizeUsdc: parseNumberField(
            positionInput.positionSizeUsdc,
            "position.positionSizeUsdc",
        ),
        extraSizeUsdc: parseNumberField(positionInput.extraSizeUsdc, "position.extraSizeUsdc"),
        allowExtraEntryAtCeiling: parseBooleanField(positionInput.allowExtraEntryAtCeiling),
    };

    const riskControl = {
        price: {
            triggerPriceGt: parseNumberField(
                riskPriceInput.triggerPriceGt,
                "riskControl.price.triggerPriceGt",
            ),
            takeProfitPrice: parseNumberField(
                riskPriceInput.takeProfitPrice,
                "riskControl.price.takeProfitPrice",
            ),
        },
        time: {
            maxMinutesToEnd: parseNumberField(
                riskTimeInput.maxMinutesToEnd,
                "riskControl.time.maxMinutesToEnd",
                {integer: true},
            ),
            monitorModeMinuteThreshold: parseNumberField(
                riskTimeInput.monitorModeMinuteThreshold,
                "riskControl.time.monitorModeMinuteThreshold",
                {integer: true},
            ),
        },
        statistics: {
            zMin: parseNumberField(riskStatsInput.zMin, "riskControl.statistics.zMin"),
            ampMin: parseNumberField(riskStatsInput.ampMin, "riskControl.statistics.ampMin"),
            highVolatilityZThreshold: parseNumberField(
                riskStatsInput.highVolatilityZThreshold,
                "riskControl.statistics.highVolatilityZThreshold",
            ),
        },
        liquidity: {
            sufficientThreshold: parseNumberField(
                riskLiquidityInput.sufficientThreshold,
                "riskControl.liquidity.sufficientThreshold",
            ),
        },
        spikeProtection: {
            count: parseNumberField(
                riskSpikeInput.count,
                "riskControl.spikeProtection.count",
                {integer: true},
            ),
        },
    };

    const extra =
        typeof body.extra === "string"
            ? body.extra
            : typeof taskInput.extra === "string"
                ? taskInput.extra
                : "";

    return {
        task,
        schedule,
        position,
        riskControl,
        extra,
    };
}


// ============================================================================
// API 路由 - 机器人订单管理
// ============================================================================

app.get("/api/bot-orders", async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit) : 100;
        const orders = await listOrders(limit);
        res.json(orders);
    } catch (err) {
        console.error("Failed to fetch bot orders:", err.message);
        res.status(500).json({
            error: "failed_to_fetch_bot_orders",
            message: err.message,
        });
    }
});

app.delete("/api/bot-orders/:id", async (req, res) => {
    try {
        const {id} = req.params;
        await deleteOrder(id);
        res.json({success: true});
    } catch (err) {
        console.error("Failed to delete order:", err.message);
        res.status(500).json({
            error: "failed_to_delete_order",
            message: err.message,
        });
    }
});

app.put("/api/bot-orders/:id", async (req, res) => {
    try {
        const {id} = req.params;
        const data = req.body;
        const updated = await updateOrder(id, data);
        res.json(updated);
    } catch (err) {
        console.error("Failed to update order:", err.message);
        res.status(500).json({
            error: "failed_to_update_order",
            message: err.message,
        });
    }
});

// ============================================================================
// 页面路由 - 主应用与子页面（供 iframe 加载）
// ============================================================================

// 主应用路由
app.get("/", (_req, res) => {
    res.sendFile(path.join(viewDir, "index.html"));
});

// 子页面路由（供 iframe 加载使用，不对外暴露）
app.get("/crypto-markets", (_req, res) => {
    res.sendFile(path.join(viewDir, "crypto-markets.html"));
});

app.get("/dashboard", (_req, res) => {
    res.sendFile(path.join(viewDir, "dashboard.html"));
});

app.get("/bot-orders", (_req, res) => {
    res.sendFile(path.join(viewDir, "bot-orders.html"));
});

app.get("/hour-minute-samples", (_req, res) => {
    res.sendFile(path.join(viewDir, "hour-minute-samples.html"));
});

app.get("/convergence-tasks", (_req, res) => {
    res.sendFile(path.join(viewDir, "convergence-tasks.html"));
});

app.listen(PORT, () => {
    const baseUrl = `http://localhost:${PORT}`;
    console.log(`Poly crypto markets server running at ${baseUrl}`);
    console.log(`Main App: ${baseUrl}${MAIN_APP_ROUTE.path}`);
    console.log("API endpoints available at /api/*");
});
