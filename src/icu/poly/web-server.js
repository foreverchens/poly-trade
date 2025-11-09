import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { PolyClient } from "./core/PolyClient.js";

const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewDir = path.join(__dirname, "view");

const app = express();
app.use(express.json());
const polyClient = new PolyClient();
const SUPPORTED_TAGS = new Set([21, 235, 39]);
const DEFAULT_TAG_ID = 235;
const CLIENT_ERROR_PATTERNS = [/market is required/i, /Invalid interval/i];
const PAGE_ROUTES = [
    { label: "Crypto Markets", path: "/" },
    { label: "Positions", path: "/positions" },
];
const DAY_MS = 24 * 60 * 60 * 1000;
const TRADE_LOOKBACK_DAYS = 3;
const MAX_TRADE_ITEMS = 10;

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
        const { market, interval } = req.query;
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

app.get("/api/orderbook/:tokenId", async (req, res) => {
    try {
        const { tokenId } = req.params;
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

app.get("/api/trades", async (req, res) => {
    try {
        const { address } = req.query;
        if (!address || typeof address !== "string") {
            return res.status(400).json({ error: "missing_address", message: "address is required" });
        }

        const normalized = address.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
            return res.status(400).json({ error: "invalid_address", message: "address must be a valid EVM address" });
        }

        const trades = await polyClient.listMyTrades({ makerAddress: normalized });
        res.json(trades);
    } catch (err) {
        console.error("Failed to fetch trades:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_fetch_trades",
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
        const { tokenId } = req.params;
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

app.post("/api/place-order", async (req, res) => {
    try {
        const { price, size, side, tokenId } = req.body;
        if (!price || !size || !side || !tokenId) {
            return res.status(400).json({
                error: "missing_parameters",
                message: "price, size, side, and tokenId are required",
            });
        }
        const result = await polyClient.placeOrder(price, size, side, tokenId);
        res.json(result);
    } catch (err) {
        console.error("Failed to place order:", err.message);
        res.status(err.response?.status || 500).json({
            error: "failed_to_place_order",
            message: err.response?.data || err.message,
        });
    }
});


app.use(express.static(viewDir));

app.get("/", (_req, res) => {
    res.sendFile(path.join(viewDir, "crypto-markets.html"));
});

app.get("/positions", (_req, res) => {
    res.sendFile(path.join(viewDir, "positions.html"));
});

app.listen(PORT, () => {
    const baseUrl = `http://localhost:${PORT}`;
    console.log(`Poly crypto markets server running at ${baseUrl}`);
    console.log("Available pages:");
    PAGE_ROUTES.forEach(({ label, path }) => {
        console.log(` - ${label}: ${baseUrl}${path}`);
    });
});
