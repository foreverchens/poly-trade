/**
 * {
 *     "id": "72027",
 *     "ticker": "bitcoin-above-on-november-10",
 *     "slug": "bitcoin-above-on-november-10",
 *     "title": "Bitcoin above ___ on November 10?",
 *     "endDate": "2025-11-10T17:00:00Z",
 *     "markets": [
 *         {
 *             "id": "662278",
 *             "question": "Will the price of Bitcoin be above $96,000 on November 10?",
 *             "conditionId": "0x7610eda46826016b5acacc0984215297e13abb14f3d874055b7d36125331d557",
 *             "slug": "bitcoin-above-96k-on-november-10",
 *             "endDate": "2025-11-10T17:00:00Z",
 *             "outcomes": "[\"Yes\", \"No\"]",
 *             "outcomePrices": "[\"0.965\", \"0.035\"]",
 *             "questionID": "0x14542b32173b4f7bae9332f7395e153e446abd7af69339d45e0f95a92c9db61c",
 *             "orderPriceMinTickSize": 0.001,
 *             "orderMinSize": 5,
 *             "clobTokenIds": "[\"1236263333717230556874983326391713643919426906179012681653274002869331971296\", \"82448076613763615618193284238975981021308260848290112802899447916510131027492\"]",
 *         },
 *         {
 *
 *         }
 *     ]
 * }
 */
import "dotenv/config";
import axios from "axios";
import { readFile, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PolyClient, PolySide } from "./core/PolyClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.resolve(__dirname, './data/endgame-bot-state.json');

// 执行周期间隔，单位：毫秒
const LOOP_MS = Number(process.env.POLY_ENDGAME_LOOP_MS ?? 1_000 * 60);
// 触发价格，单位：USDC
const ENTRY_TRIGGER = Number(process.env.POLY_ENDGAME_TRIGGER ?? 0.8);
// 首仓金额，单位：USDC
const BASE_USDC = Number(process.env.POLY_ENDGAME_BASE_SIZE ?? 20);
// 补仓金额，单位：USDC
const ADD_USDC = Number(process.env.POLY_ENDGAME_ADD_SIZE ?? 10);
// 补仓间隔，单位：USDC
const ADD_INTERVAL = Number(process.env.POLY_ENDGAME_ADD_INTERVAL ?? 0.05);
// 最大补仓次数
const MAX_ADDS = Number(process.env.POLY_ENDGAME_MAX_ADDS ?? 3);
// 止盈价格，单位：USDC
const TAKE_PROFIT_PRICE = Number(process.env.POLY_ENDGAME_TP ?? 0.99);
// 最大剩余时间，单位：小时
const MAX_HOURS_TO_END = Number(process.env.POLY_ENDGAME_MAX_HOURS ?? 4);
// 请求超时时间，单位：毫秒
const HTTP_TIMEOUT = Number(process.env.POLY_ENDGAME_HTTP_TIMEOUT ?? 10_000);
// 是否测试模式
const TEST = Boolean(process.env.POLY_ENDGAME_TEST ?? false);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class EndgameStrategy {
    constructor() {
        this.client = new PolyClient();
        this.marketHost = this.client.marketHost;
        this.loopMs = LOOP_MS;
        this.entryTrigger = ENTRY_TRIGGER;
        this.baseUsdc = BASE_USDC;
        this.addUsdc = ADD_USDC;
        this.addInterval = ADD_INTERVAL;
        this.maxAdds = MAX_ADDS;
        this.takeProfitPrice = TAKE_PROFIT_PRICE;
        this.maxHoursToEnd = MAX_HOURS_TO_END;
        this.httpTimeout = HTTP_TIMEOUT;
        this.test = TEST;
        console.log(`[终局策略] 配置：执行周期间隔=${this.loopMs}ms，触发价格=${this.entryTrigger}，首仓金额=${this.baseUsdc}USDC，补仓金额=${this.addUsdc}USDC，补仓间隔=${this.addInterval}USDC，最大补仓次数=${this.maxAdds}，止盈价格=${this.takeProfitPrice}，最大剩余时间=${this.maxHoursToEnd}小时，请求超时时间=${this.httpTimeout}ms，是否测试模式=${this.test}`);
        try {
            const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
            this.stateFileData = { slugList: data.slugList || [], runtime: data.runtime || [] };
            this.whitelist = this.stateFileData.slugList;
        } catch (err) {
            this.stateFileData = { slugList: [], runtime: [] };
            this.whitelist = [];
        }
    }

    async start() {
        console.log(`[终局策略] 启动，白名单=${this.whitelist.join(",")}`);
        while (true) {
            try {
                await this.tick();
            } catch (err) {
                console.error("[终局策略] 执行周期失败", err);
            }
            await sleep(this.loopMs);
        }
    }

    async tick() {
        for (const slug of this.whitelist) {
            console.log(`[执行周期] 事件标识=${slug}`);
            await this.processSlug(slug);
        }
    }

    // 请求单个 slug 的事件详情，再逐一检查旗下市场
    async processSlug(slug) {
        const url = `${this.marketHost}/events/slug/${slug}`;
        const response = await axios.get(url, { timeout: this.httpTimeout });
        const event = response?.data;
        const markets = event?.markets || [];
        if (!markets.length) {
            console.log(`[${slug}] 未找到开放市场`);
            return;
        }
        console.log(`[${slug}] 市场数量=${markets.length}`);
        for (const market of markets) {
            try {
                console.log(`[${market.slug}] 开始检查`);
                const signal = await this.buildSignal(event, market);
                if (signal) {
                    await this.handleSignal(signal);
                }
            } catch (err) {
                console.error(`[${slug}] 获取失败`, err?.message ?? err);
            }
        }

    }

    // 构建交易信号：限定剩余时间，并找出概率 >= entryTrigger 的方向
    async buildSignal(event, market) {
        const timeMs = Date.parse(market.endDate) - Date.now();
        const hoursToEnd = timeMs / 3_600_000;
        console.log(`[${market.slug}] 剩余时间=${Math.round(hoursToEnd)}小时`);
        if (hoursToEnd > this.maxHoursToEnd) {
            console.log(`[${market.slug}] 剩余时间超过最大时间，不处理`);
            return null;
        }
        const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);

        const [yesPrice, noPrice] = await Promise.all([this.fetchBestAsk(yesTokenId), this.fetchBestAsk(noTokenId),]);
        const topPrice = Math.max(yesPrice, noPrice);
        const candidate = yesPrice >= noPrice ? {
            tokenId: yesTokenId, price: yesPrice, outcome: "yes",
        } : {
            tokenId: noTokenId, price: noPrice, outcome: "no",
        };

        console.log(`[${market.slug}] 顶部价格=${topPrice.toFixed(2)} 触发价格=${this.entryTrigger.toFixed(3)}`);
        if (topPrice < this.entryTrigger) {
            console.log(`[${market.slug}] 顶部价格低于触发价格，不处理`);
            return null;
        }
        console.log(`[信号] ${market.slug} 选择=${candidate.outcome.toUpperCase()} 价格=${candidate.price.toFixed(3)} 是=${yesPrice.toFixed(3)} 否=${noPrice.toFixed(3)} 剩余小时=${hoursToEnd.toFixed(2)}`);

        return {
            eventSlug: event.slug, marketSlug: market.slug, chosen: candidate, yesPrice, noPrice, hoursToEnd,
        };
    }


    async fetchBestAsk(tokenId) {
        const orderBook = await this.client.getOrderBook(tokenId).catch((err) => {
            console.error(`[${tokenId}] 订单簿获取失败`, err?.message ?? err);
            return null;
        });
        if (!orderBook) {
            return null;
        }
        const asks = orderBook.asks;
        return asks.length ? Number(asks[asks.length - 1].price) : 0;
    }

    // 依据当前 token 状态决定是否首仓或补仓
    async handleSignal(signal) {
        console.log(`[${signal.marketSlug}] 处理信号`);
        const tokenId = signal.chosen.tokenId;
        const price = signal.chosen.price;
        const state = this.stateFileData.runtime.find(e => e.tokenId === tokenId) ?? {
            tokenId, count: 0, lastEntryPrice: null
        };
        // count 表示已建仓次数：0=未建仓, 1=首仓, 2=首仓+1次补仓, 3=首仓+2次补仓...
        // addCount 表示已补仓次数（不包括首仓）
        const addCount = Math.max(0, state.count - 1);

        if (state.count === 0) {
            console.log(`[${signal.marketSlug}] 首仓`);
            await this.openPosition({
                tokenId, price, sizeUsd: this.baseUsdc, entryType: "base", signal,
            });
            return;
        }

        if (addCount >= this.maxAdds) {
            console.log(`[${signal.marketSlug}] 补仓次数超过最大次数，不处理`);
            return;
        }

        const prevPrice = state.lastEntryPrice ?? price; // 参照上一次建仓价，判断是否满足补仓触发条件
        // 如果价格下跌超过 addInterval，则触发补仓
        if (prevPrice - price < this.addInterval) {
            console.log(`[${signal.marketSlug}] 价格下跌未超过补仓间隔，不处理`);
            return;
        }

        console.log(`[${signal.marketSlug}] 补仓`);
        await this.openPosition({
            tokenId, price, sizeUsd: this.addUsdc, entryType: `add-${addCount + 1}`, signal,
        });
    }


    // 负责下买单 + 对应止盈卖单，并记录状态
    async openPosition({ tokenId, price, sizeUsd, entryType, signal }) {
        if (this.test) {
            console.log(`[测试] ${signal.marketSlug} ${entryType} 建仓 -> ${signal.chosen.outcome.toUpperCase()} 价格=${price.toFixed(2)} 金额=${sizeUsd}`);
            return 1;
        }
        const sizeShares = Math.round(sizeUsd / price);
        if (sizeShares <= 0) {
            console.error(`[${signal.marketSlug}] 无效的份额数量=${sizeShares} 金额=${sizeUsd} 价格=${price}`);
            return;
        }
        console.log(`[${signal.marketSlug}] ${entryType} 建仓 -> ${signal.chosen.outcome.toUpperCase()} 价格=${price.toFixed(2)} 数量=${sizeShares}`);

        const entryOrder = await this.client.placeOrder(price, sizeShares, PolySide.BUY, tokenId).catch((err) => {
            console.error(`[${signal.marketSlug}] 建仓订单失败`, err?.message ?? err);
            return null;
        });

        if (!entryOrder?.success) {
            console.log(`[${signal.marketSlug}] 建仓被拒绝:`, entryOrder);
            return;
        }
        console.log(`[${signal.marketSlug}] 建仓成交，订单号=${entryOrder.orderID || entryOrder.id}`);

        await this.client.placeOrder(this.takeProfitPrice, sizeShares, PolySide.SELL, tokenId).catch((err) => {
            console.error(`[${signal.marketSlug}] 止盈订单失败`, err?.message ?? err);
        });
        console.log(`[${signal.marketSlug}] 止盈订单已排队 @${this.takeProfitPrice}`);

        const state = this.stateFileData.runtime.find(e => e.tokenId === tokenId);
        if (state) {
            state.count += 1;
            state.lastEntryPrice = price;
        } else {
            this.stateFileData.runtime.push({ tokenId, count: 1, lastEntryPrice: price });
        }
        await this.saveState();
    }

    async saveState() {
        const payload = {
            slugList: this.stateFileData.slugList.length > 0 ? this.stateFileData.slugList : Array.from(this.whitelist),
            runtime: this.stateFileData.runtime
        };
        await writeFile(STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
    }
}

const bot = new EndgameStrategy();
bot.start().catch((err) => {
    console.error("[终局策略] 致命错误", err);
});
