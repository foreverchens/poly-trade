import express from "express";
import path from "path";
import {fileURLToPath} from "url";
import {PolyClient} from "./core/PolyClient.js";

const PORT = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewDir = path.join(__dirname, "view");

const app = express();
const polyClient = new PolyClient();

app.get("/api/crypto-markets", async (_req, res) => {
    try {
        const markets = await polyClient.listCryptoMarketSortedByEndDate();
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


app.use(express.static(viewDir));

app.get("/", (_req, res) => {
    res.sendFile(path.join(viewDir, "crypto-markets.html"));
});

app.listen(PORT, () => {
    console.log(`Poly crypto markets server running at http://localhost:${PORT}`);
});
