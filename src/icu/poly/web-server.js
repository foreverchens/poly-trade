import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { PolyClient } from "./core/PolyClient.js";

const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewDir = path.join(__dirname, "view");

const app = express();
const polyClient = new PolyClient();
const SUPPORTED_TAGS = new Set([21, 235, 39]);
const DEFAULT_TAG_ID = 235;
const CLIENT_ERROR_PATTERNS = [/market is required/i, /Invalid interval/i];
const PAGE_ROUTES = [
    { label: "Crypto Markets", path: "/" },
    { label: "Positions", path: "/positions" },
];

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
