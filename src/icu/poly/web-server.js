import express from "express";
import path from "path";
import {fileURLToPath} from "url";
import axios from "axios";
import { getPolyClient } from "./core/poly-client-manage.js";
import {listOrders, deleteOrder, updateOrder} from "./db/repository.js";
import {getMinuteSamples} from "./db/statisc-repository.js";

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

const app = express();
app.use(express.json());
const SUPPORTED_TAGS = new Set([21, 235, 39]);
const DEFAULT_TAG_ID = 235;
const CLIENT_ERROR_PATTERNS = [/market is required/i, /Invalid interval/i];
const PAGE_ROUTES = [
    {label: "Crypto Markets", path: "/"},
    {label: "dashboard", path: "/dashboard"},
    {label: "Bot Orders", path: "/bot-orders"},
    {label: "Hour Samples", path: "/hour-minute-samples"},
];
const TRADE_LOOKBACK_DAYS = 3;
const MAX_TRADE_ITEMS = 10;

app.get("/api/crypto-markets", async (req, res) => {
    try {
        const requestedTag = Number.parseInt(req.query.tag, 10);
        const tagId = SUPPORTED_TAGS.has(requestedTag) ? requestedTag : DEFAULT_TAG_ID;
        const markets = await getPolyClient().listCryptoMarketSortedByEndDate(tagId);
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
        const payload = await getPolyClient().getPricesHistory(market, interval);
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
        const customRange = normalizeBtcRange(req.query.start, req.query.end);
        const history = await getBtcHistory(interval, customRange);
        res.json({history});
    } catch (err) {
        console.error("Failed to fetch BTC price history:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_btc_history",
            message: err.response?.data || err.message,
        });
    }
});

app.get("/api/orderbook/:tokenId", async (req, res) => {
    try {
        const {tokenId} = req.params;
        const orderBook = await getPolyClient().getOrderBook(tokenId);
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

        const trades = await getPolyClient().listMyTrades({makerAddress: normalized});
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
        const orders = await getPolyClient().listOpenOrders({
            market: market || undefined,
            assetId: assetId || undefined,
        });
        const enriched = await enrichOrdersWithMarketMeta(orders);
        res.json(enriched);
    } catch (err) {
        console.error("Failed to fetch open orders:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_open_orders",
            message: err.response?.data || err.message,
        });
    }
});

function parseTradeTimestamp(value) {
    if (!value) {
        return Date.now();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return value > 1e12 ? value : value * 1000;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
        return numeric > 1e12 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
        return parsed;
    }

    return Date.now();
}

/**
 * 获取最优买卖价格
 * @route GET /api/best-prices/:tokenId
 * @returns {Object} {
 *   bestBid: number,    // 最优买价（最高买价，bids数组最后一个元素）
 *   bestAsk: number,    // 最优卖价（最低卖价，asks数组最后一个元素）
 *   tokenId: string     // token ID
 * }
 */
app.get("/api/best-prices/:tokenId", async (req, res) => {
    try {
        const {tokenId} = req.params;
        const orderBook = await getPolyClient().getOrderBook(tokenId);

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

app.post("/api/place-order", async (req, res) => {
    try {
        const {price, size, side, tokenId} = req.body;
        if (!price || !size || !side || !tokenId) {
            return res.status(400).json({
                error: "missing_parameters",
                message: "price, size, side, and tokenId are required",
            });
        }
        const result = await getPolyClient().placeOrder(price, size, side, tokenId);
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
        const {orderId} = req.body;
        if (!orderId) {
            return res.status(400).json({
                error: "missing_order_id",
                message: "orderId is required",
            });
        }
        const result = await getPolyClient().cancelOrder(orderId);
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
        const address = getPolyClient().signer.address;
        res.json({address});
    } catch (err) {
        console.error("Failed to get current address:", err.message);
        res.status(500).json({
            error: "failed_to_get_address",
            message: err.message,
        });
    }
});


app.use(express.static(viewDir));
const btcHistoryCache = new Map();

function normalizeBtcInterval(value) {
    const key = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (key && BTC_INTERVAL_CONFIG[key]) {
        return key;
    }
    return DEFAULT_BTC_INTERVAL;
}

function normalizeBtcRange(startValue, endValue) {
    if (startValue === undefined || endValue === undefined) return null;
    const startNum = Number(startValue);
    const endNum = Number(endValue);
    if (!Number.isFinite(startNum) || !Number.isFinite(endNum)) return null;
    const orderedStart = Math.min(startNum, endNum);
    const orderedEnd = Math.max(startNum, endNum);
    const now = Date.now();
    const safeEnd = Math.min(orderedEnd, now);
    const safeStart = Math.max(0, Math.min(orderedStart, safeEnd - BTC_PROVIDER_INTERVAL_MS));
    if (safeEnd - safeStart < BTC_PROVIDER_INTERVAL_MS) {
        return {
            startTime: safeStart,
            endTime: safeStart + BTC_PROVIDER_INTERVAL_MS,
        };
    }
    return {
        startTime: safeStart,
        endTime: safeEnd,
    };
}

async function getBtcHistory(interval, customRange = null) {
    const key = interval || DEFAULT_BTC_INTERVAL;
    const useCache = !customRange;
    const cacheKey = `${BTC_CACHE_VERSION}:${key}`;
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
    const durationMs = customRange
        ? Math.max(BTC_PROVIDER_INTERVAL_MS, customRange.endTime - customRange.startTime)
        : defaultDuration;
    const targetStart = customRange?.startTime ?? Math.max(0, targetEnd - durationMs);
    const normalizedStart = Math.floor(targetStart / BTC_PROVIDER_INTERVAL_MS) * BTC_PROVIDER_INTERVAL_MS;
    const totalRange = Math.max(BTC_PROVIDER_INTERVAL_MS, (targetEnd - normalizedStart));
    const requiredCandles = Math.max(2, Math.ceil(totalRange / BTC_PROVIDER_INTERVAL_MS) + 2);
    const history = await fetchBtcCandles({
        startTime: normalizedStart,
        endTime: targetEnd,
        requiredCandles,
    });
    const filtered = history
        .filter(point => point.t >= targetStart && point.t <= targetEnd + BTC_PROVIDER_INTERVAL_MS);
    if (useCache) {
        btcHistoryCache.set(cacheKey, {timestamp: now, history: filtered});
    }
    return filtered;
}

async function fetchBtcCandles({startTime, endTime, requiredCandles}) {
    const points = [];
    let nextStart = startTime;
    let batchCount = 0;
    while (nextStart < endTime && points.length < requiredCandles && batchCount < MAX_BINANCE_BATCHES) {
        const remaining = requiredCandles - points.length;
        const limit = Math.min(MAX_BINANCE_LIMIT, Math.max(remaining, 10));
        const params = {
            symbol: BTC_PRICE_SYMBOL,
            interval: BTC_PROVIDER_INTERVAL,
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
        nextStart = lastTime + BTC_PROVIDER_INTERVAL_MS;
        batchCount++;
    }
    return dedupeCandles(points).filter(point => point.t <= endTime + BTC_PROVIDER_INTERVAL_MS);
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

async function enrichOrdersWithMarketMeta(orders) {
    for (let order of orders) {
        let conditionId = order.market;
        order.market = (await getPolyClient().getMarketByConditionId(conditionId))[0].slug;
    }
    return orders;
}

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

app.get("/", (_req, res) => {
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

app.listen(PORT, () => {
    const baseUrl = `http://localhost:${PORT}`;
    console.log(`Poly crypto markets server running at ${baseUrl}`);
    console.log("Available pages:");
    PAGE_ROUTES.forEach(({label, path}) => {
        console.log(` - ${label}: ${baseUrl}${path}`);
    });
});
