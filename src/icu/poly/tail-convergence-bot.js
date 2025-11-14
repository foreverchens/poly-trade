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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class EndgameStrategy {
    constructor() {
        this.client = new PolyClient();
        this.marketHost = this.client.marketHost;

        // 从状态文件读取配置
        try {
            const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
            const config = data.config || {};

            // 读取配置
            this.positionSizeUsdc = config.positionSizeUsdc ?? 10;
            this.triggerPriceGt = config.triggerPriceGt ?? 0.90;
            this.triggerPriceLt = config.triggerPriceLt ?? 0.99;
            this.takeProfitPrice = config.takeProfitPrice ?? 0.998;
            this.maxHoursToEnd = config.maxHoursToEnd ?? 2;
            this.test = config.test ?? true;
            this.httpTimeout = 10000;

            // 保存原始slugList模板（包含${day}占位符）
            this.rawSlugList = config.slugList || [];
            // 初始化时解析一次
            this.whitelist = this.resolveSlugList(this.rawSlugList);

            // 读取订单数据
            this.orders = data.orders || {};
        } catch (err) {
            throw err;
        }

        console.log(`[扫尾盘策略] 配置：建仓金额=${this.positionSizeUsdc}USDC，触发价格范围=[${this.triggerPriceGt}, ${this.triggerPriceLt}]，止盈价格=${this.takeProfitPrice}，最大剩余时间=${this.maxHoursToEnd}小时，是否测试模式=${this.test}`);
    }

    /**
     * 检查当前美国东部时间是否在运行时间窗口内（10:00-12:00）
     * @returns {boolean} 是否在运行时间窗口内
     */
    isInRunningWindow() {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            hour12: false
        });
        const hour = parseInt(formatter.format(now), 10);
        // 10:00-11:59
        return hour >= 10 && hour < 12;
    }

    /**
     * 解析slug列表，将${day}占位符替换为美国东部时间的当天日期
     * @param {string[]} slugList 原始slug列表
     * @returns {string[]} 解析后的slug列表
     */
    resolveSlugList(slugList) {
        // 获取美国东部时间的日期
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            day: 'numeric'
        });
        const day = parseInt(formatter.format(now), 10);

        return slugList.map(slug => {
            if (slug.includes('${day}')) {
                return slug.replace(/\$\{day\}/g, day.toString());
            }
            return slug;
        });
    }

    async start() {
        console.log(`[扫尾盘策略] 启动，白名单=${this.whitelist.join(",")}`);
        console.log(`[扫尾盘策略] 运行时间窗口：美国东部时间 10:00-12:00`);
        while (true) {
            try {
                if (this.isInRunningWindow()) {
                    await this.tick();
                    await sleep(1000 * 60); // 运行期间每分钟执行一次
                } else {
                    // 不在运行时间窗口内，休眠等待
                    const now = new Date();
                    const formatter = new Intl.DateTimeFormat('en-US', {
                        timeZone: 'America/New_York',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false
                    });
                    const currentTime = formatter.format(now);
                    console.log(`[扫尾盘策略] 当前美国东部时间=${currentTime}，不在运行窗口内，休眠中...`);
                    await sleep(1000 * 60 * 10); // 休眠期间每10分钟检查一次
                }
            } catch (err) {
                console.error("[扫尾盘策略] 执行周期失败", err);
                await sleep(1000 * 60);
            }
        }
    }

    async tick() {
        // 每次tick时重新解析slugList，确保使用当天的日期
        this.whitelist = this.resolveSlugList(this.rawSlugList);
        for (const slug of this.whitelist) {
            console.log(`[执行周期] 事件标识=${slug}`);
            await this.processSlug(slug);
        }
    }

    // 请求单个 slug 的事件详情，再逐一检查旗下市场
    async processSlug(slug) {
        const markets = await this.listMarkets(slug);
        if (!markets.length) {
            console.log(`[${slug}] 事件尚早或无合适市场`);
            return;
        }
        console.log(`[${slug}] 市场数量=${markets.length}`);
        for (const market of markets) {
            try {
                console.log(`[${market.slug}] 开始检查`);
                const signal = await this.buildSignal(slug, market);
                if (signal) {
                    await this.handleSignal(signal);
                }
            } catch (err) {
                console.error(`[${slug}] 获取失败`, err?.message ?? err);
            }
        }

    }

    /**
     * 获取事件下可用的市场列表、以进行结束时间过滤和基于lastTradePrice的简单价格过滤、后续才基于订单簿价格确认
     * @param {} slug 
     * @returns 
     */
    async listMarkets(slug) {
        const url = `${this.marketHost}/events/slug/${slug}`;
        const response = await axios.get(url, { timeout: this.httpTimeout });
        const event = response?.data;
        const markets = event?.markets || [];
        if (!markets.length) {
            console.log(`[${slug}] 未找到开放市场`);
            return [];
        }
        const timeMs = Date.parse(event.endDate) - Date.now();
        const hoursToEnd = timeMs / 3_600_000;
        if (hoursToEnd > this.maxHoursToEnd) {
            console.log(`[${slug}] 事件剩余时间=${Math.round(hoursToEnd)}小时 超过最大时间=${this.maxHoursToEnd}小时，不处理`);
            return [];
        }
        return markets.filter(market => {
            const lastTradePrice = market.lastTradePrice ?? 0.5;
            if ((lastTradePrice > 0.01 && lastTradePrice < 0.1) || (lastTradePrice > 0.9 && lastTradePrice < 0.999)) {
                return true;
            }
            return false;
        });
    }

    // 构建交易信号：限定剩余时间，并找出概率 >= entryTrigger 的方向
    async buildSignal(eventSlug, market) {

        const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);

        const [yesPrice, noPrice] = await Promise.all([this.fetchBestAsk(yesTokenId), this.fetchBestAsk(noTokenId),]);
        const topPrice = Math.max(yesPrice, noPrice);

        if (topPrice < this.triggerPriceGt || topPrice > this.triggerPriceLt) {
            console.log(`[${market.slug}] 顶部价格=${topPrice.toFixed(3)} 触发价格范围=[${this.triggerPriceGt}, ${this.triggerPriceLt}],不处理`);
            return null;
        }
        const candidate = yesPrice >= noPrice ? {
            tokenId: yesTokenId, price: yesPrice, outcome: "yes",
        } : {
            tokenId: noTokenId, price: noPrice, outcome: "no",
        };
        console.log(`[信号] ${market.slug} 选择=${candidate.outcome.toUpperCase()} 价格=${candidate.price.toFixed(3)}`);
        return {
            eventSlug: eventSlug, marketSlug: market.slug, chosen: candidate, yesPrice, noPrice,
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

    // 检查是否已建仓，未建仓则执行建仓
    async handleSignal(signal) {
        console.log(`[${signal.marketSlug}] 处理信号`);
        const eventSlug = signal.eventSlug;
        const marketSlug = signal.marketSlug;

        // 检查该市场是否已有订单
        const eventOrders = this.orders[eventSlug] || [];
        const existingOrder = eventOrders.find(order => order.marketSlug === marketSlug);

        if (existingOrder) {
            console.log(`[${marketSlug}] 已建仓，跳过`);
            return;
        }

        console.log(`[${marketSlug}] 执行建仓`);
        await this.openPosition({
            tokenId: signal.chosen.tokenId,
            price: signal.chosen.price,
            sizeUsd: this.positionSizeUsdc,
            signal,
        });
    }


    // 负责下买单 + 对应止盈卖单，并记录状态
    async openPosition({ tokenId, price, sizeUsd, signal }) {
        const sizeShares = Math.abs(Math.round(sizeUsd / price));
        if (sizeShares <= 0) {
            console.error(`[${signal.marketSlug}] 无效的份额数量=${sizeShares} 金额=${sizeUsd} 价格=${price}`);
            return;
        }

        let orderId;
        if (this.test) {
            console.log(`[测试] ${signal.marketSlug} 建仓 -> ${signal.chosen.outcome.toUpperCase()} 价格=${price.toFixed(3)} 数量=${sizeShares}`);
            orderId = `test-${Date.now()}`;
        } else {
            console.log(`[${signal.marketSlug}] 建仓 -> ${signal.chosen.outcome.toUpperCase()} 价格=${price.toFixed(3)} 数量=${sizeShares}`);

            const entryOrder = await this.client.placeOrder(price, sizeShares, PolySide.BUY, tokenId).catch((err) => {
                console.error(`[${signal.marketSlug}] 建仓订单失败`, err?.message ?? err);
                return null;
            });

            if (!entryOrder?.success) {
                console.log(`[${signal.marketSlug}] 建仓被拒绝:`, entryOrder);
                return;
            }
            orderId = entryOrder.orderID || entryOrder.id;
            console.log(`[${signal.marketSlug}] 建仓成交，订单号=${orderId}`);

            await this.client.placeOrder(this.takeProfitPrice, sizeShares, PolySide.SELL, tokenId).catch((err) => {
                console.error(`[${signal.marketSlug}] 止盈订单失败`, err?.message ?? err);
            });
            console.log(`[${signal.marketSlug}] 止盈订单已排队 @${this.takeProfitPrice}`);
        }

        // 记录订单到orders字段
        const eventSlug = signal.eventSlug;
        if (!this.orders[eventSlug]) {
            this.orders[eventSlug] = [];
        }
        this.orders[eventSlug].push({
            marketSlug: signal.marketSlug,
            side: signal.chosen.outcome.toUpperCase(),
            orderId: orderId,
            price: price,
            size: sizeShares
        });
        await this.saveState();
    }

    async saveState() {
        // 读取当前配置，确保保存时保留配置
        let currentConfig = {};
        try {
            const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
            currentConfig = data.config || {};
        } catch (err) {
            // 如果读取失败，使用当前实例的配置值
            currentConfig = {
                positionSizeUsdc: this.positionSizeUsdc,
                triggerPriceGt: this.triggerPriceGt,
                triggerPriceLt: this.triggerPriceLt,
                takeProfitPrice: this.takeProfitPrice,
                maxHoursToEnd: this.maxHoursToEnd,
                test: this.test,
                slugList: this.whitelist
            };
        }

        const payload = {
            config: currentConfig,
            orders: this.orders
        };
        await writeFile(STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
    }
}
const bot = new EndgameStrategy();
bot.start().catch((err) => {
    console.error("[扫尾盘策略] 致命错误", err);
});
