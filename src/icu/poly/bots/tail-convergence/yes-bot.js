/**
 * Example state payload (truncated) for quick reference:
 *
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
import { writeFile } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dayjs from "dayjs";
import cron from "node-cron";
import { PolyClient, PolySide } from "../../core/PolyClient.js";
import {
    loadStateFile,
    resolveSlugList,
    fetchMarketsWithinTime,
    fetchBestAsk,
} from "./common.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_STATE_FILE = path.resolve(__dirname, "./data/convergence-yes.data.json");

/**
 * Yes/No tail convergence strategy.
 * Mirrors the up-bot structure but specializes in YES/NO markets that hug 0 or 1.
 */
class TailConvergenceStrategy {
    /**
     * @param {string} stateFilePath - Persisted state/config file.
     */
    constructor(stateFilePath = DEFAULT_STATE_FILE) {
        this.client = new PolyClient();
        this.stateFilePath = stateFilePath;

        const { config, orders } = loadStateFile(this.stateFilePath);

        /**
         * --- Config bootstrap ------------------------------------------------
         * 1. Position sizing：positionSizeUsdc。
         * 2. 触发区间/波动要求：triggerPriceGt/Lt、maxMinutesToEnd。
         * 3. 调度节奏：cronExpression/cronTimeZone + slugList。
         * 4. 实验控制：test、takeProfitPrice、httpTimeout。
         */
        this.positionSizeUsdc = config.positionSizeUsdc;
        this.triggerPriceGt = config.triggerPriceGt;
        this.triggerPriceLt = config.triggerPriceLt;
        this.takeProfitPrice = config.takeProfitPrice;
        this.maxMinutesToEnd = config.maxMinutesToEnd;
        this.test = config.test ?? true;
        this.httpTimeout = 10000;
        // cron 表达式，默认：美国东部时间 10:00-11:59，每5分钟执行一次
        // 格式：分钟 小时 日 月 星期
        this.cronExpression = config.cronExpression;
        this.cronTimeZone = config.cronTimeZone;

        // 保存原始 slugList 模板（包含 ${day} 占位符）
        this.rawSlugList = config.slugList || [];
        // 初始化时解析一次，后续在 tick 内按需替换
        this.whitelist = resolveSlugList(this.rawSlugList);
        // 待提交的止盈订单
        this.takeProfitOrders = [];

        // 读取订单数据
        this.orders = orders;

        console.log(
            `\n[扫尾盘策略-YesNo] \n建仓金额=${this.positionSizeUsdc}USDC\n触发价格范围=[${this.triggerPriceGt}, ${this.triggerPriceLt}]\n止盈价格=${this.takeProfitPrice}\n最大剩余时间=${this.maxMinutesToEnd}分钟，是否测试模式=${this.test}`
        );
        console.log(`[扫尾盘策略] Cron表达式=${this.cronExpression}，时区=${this.cronTimeZone}`);
    }

    /**
     * Register cron scheduler and optionally kick off an immediate test loop.
     */
    async start() {
        console.log(`[扫尾盘策略] 启动，白名单=${this.whitelist.join(",")}`);
        console.log(
            `[扫尾盘策略] 使用Cron表达式调度：${this.cronExpression} (时区: ${this.cronTimeZone})`
        );

        // 验证 cron 表达式
        if (!cron.validate(this.cronExpression)) {
            throw new Error(`无效的Cron表达式: ${this.cronExpression}`);
        }

        // 使用 cron 调度任务
        cron.schedule(
            this.cronExpression,
            async () => {
                try {
                    await this.tick();
                } catch (err) {
                    console.error("[扫尾盘策略] 执行周期失败", err);
                }
            },
            {
                timezone: this.cronTimeZone,
            }
        );

        console.log(`[扫尾盘策略] Cron任务已启动，等待调度执行...`);

        // 保持进程运行
        if (this.test) {
            // 测试模式下立即执行一次
            console.log(`[扫尾盘策略] 测试模式：立即执行一次`);
            await this.tick();
        }
    }

    /**
     * 单次 tick：刷新白名单、提交止盈、收集信号并尝试建仓。
     */
    async tick() {
        console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] 开始执行tick`);
        // 每次tick时重新解析slugList，确保使用当天的日期
        this.whitelist = resolveSlugList(this.rawSlugList);
        // 提交止盈订单 若订单已存在则跳过
        // 统一在结算10分钟之后再提交止盈订单
        for (const takeProfitOrder of this.takeProfitOrders) {
            if (takeProfitOrder.orderId) {
                continue;
            }
            console.log(
                `\n[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${takeProfitOrder.signal.eventSlug}-${
                    takeProfitOrder.signal.marketSlug
                }-${takeProfitOrder.signal.chosen.outcome.toUpperCase()}@${takeProfitOrder.signal.chosen.price.toFixed(
                    3
                )} ] 开始处理止盈订单`
            );
            const orderId = await this.placeTakeProfitOrder(takeProfitOrder);
            takeProfitOrder.orderId = orderId;
        }

        let signals = [];
        // 获取信号 若信号已存在则跳过
        for (const slug of this.whitelist) {
            const curSignals = await this.processSlug(slug);
            if (!curSignals.length) {
                console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${slug}] 无信号`);
                continue;
            }
            signals.push(...curSignals);
        }

        signals = signals.sort((a, b) => a.chosen.price - b.chosen.price).slice(0, 4);
        console.table(signals);
        // 处理信号 若订单已存在则跳过
        for (const signal of signals) {
            console.log(
                `\n[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                    signal.marketSlug
                }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                    3
                )} ] 开始处理信号`
            );
            await this.handleSignal(signal);
        }
    }

    async placeTakeProfitOrder(takeProfitOrder) {
        const { tokenId, price, size, signal } = takeProfitOrder;
        const { orderID } = await this.client.placeOrder(price, size, PolySide.SELL, tokenId);
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                signal.marketSlug
            }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                3
            )} ] 止盈订单已提交 @${price} orderId=${orderID}`
        );
        return orderID;
    }

    /**
     * 请求单个 slug 的事件详情，再逐一检查旗下市场。
     */
    async processSlug(slug) {
        const markets = await this.listMarkets(slug);
        if (!markets.length) {
            // console.log(`[${slug} @${dayjs().format('YYYY-MM-DD HH:mm:ss')}] 事件尚早或无合适市场`);
            return [];
        }
        // console.log(
        //     `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${slug}] 市场数量=${markets.length}`
        // );

        const signals = [];
        for (const market of markets) {
            try {
                const signal = await this.buildSignal(slug, market);
                if (signal) {
                    signals.push(signal);
                }
            } catch (err) {
                console.error(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${slug}] 获取失败`,
                    err?.message ?? err
                );
            }
        }
        return signals;
    }

    /**
     * 获取事件下可用的市场列表、以进行结束时间过滤和基于lastTradePrice的简单价格过滤、后续才基于订单簿价格确认
     * @param {} slug
     * @returns
     */
    async listMarkets(slug) {
        const markets = await fetchMarketsWithinTime(slug, this.maxMinutesToEnd);
        if (!markets.length) {
            return [];
        }
        // YesNo事件：基于lastTradePrice进行价格预检查
        return markets.filter((market) => {
            const lastTradePrice = market.lastTradePrice ?? 0.5;
            if (
                (lastTradePrice > 0.01 && lastTradePrice < 0.1) ||
                (lastTradePrice > 0.9 && lastTradePrice < 0.99)
            ) {
                return true;
            }
            return false;
        });
    }

    /**
     * 构建交易信号：限定剩余时间，并找出概率 >= entryTrigger 的方向。
     */
    async buildSignal(eventSlug, market) {
        const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);

        const [yesPrice, noPrice] = await Promise.all([
            fetchBestAsk(this.client, yesTokenId),
            fetchBestAsk(this.client, noTokenId),
        ]);
        const topPrice = Math.max(yesPrice, noPrice);

        if (topPrice < this.triggerPriceGt || topPrice > this.triggerPriceLt) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${eventSlug}-${
                    market.slug
                }] 顶部价格=${topPrice.toFixed(3)} 触发价格范围=[${this.triggerPriceGt}, ${
                    this.triggerPriceLt
                }],不处理`
            );
            return null;
        }

        const candidate =
            yesPrice >= noPrice
                ? {
                      tokenId: yesTokenId,
                      price: yesPrice,
                      outcome: "yes",
                  }
                : {
                      tokenId: noTokenId,
                      price: noPrice,
                      outcome: "no",
                  };
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${eventSlug}-${
                market.slug
            }] 选择=${candidate.outcome.toUpperCase()}@${candidate.price.toFixed(3)}`
        );
        return {
            eventSlug: eventSlug,
            marketSlug: market.slug,
            chosen: candidate,
            yesPrice,
            noPrice,
        };
    }

    /**
     * 检查是否已建仓，未建仓则执行建仓。
     */
    async handleSignal(signal) {
        const eventSlug = signal.eventSlug;
        const marketSlug = signal.marketSlug;

        // 检查该市场是否已有订单
        const eventOrders = this.orders[eventSlug] || [];
        const existingOrder = eventOrders.find((order) => order.marketSlug === marketSlug);

        if (existingOrder) {
            console.log(
                `[@${dayjs().format(
                    "YYYY-MM-DD HH:mm:ss"
                )} ${eventSlug}-${marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                    3
                )} ] 已建仓，跳过`
            );
            return;
        }

        console.log(
            `[@${dayjs().format(
                "YYYY-MM-DD HH:mm:ss"
            )} ${eventSlug}-${marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                3
            )} ] 执行建仓`
        );
        await this.openPosition({
            tokenId: signal.chosen.tokenId,
            price: signal.chosen.price,
            sizeUsd: this.positionSizeUsdc,
            signal,
        });
    }

    /**
     * 负责下买单、并记录状态、同时止盈订单入队列。
     */
    async openPosition({ tokenId, price, sizeUsd, signal }) {
        const sizeShares = Math.abs(Math.round(sizeUsd / price));
        if (sizeShares <= 0) {
            console.error(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                    signal.marketSlug
                }] 无效的份额数量=${sizeShares} 金额=${sizeUsd} 价格=${price}`
            );
            return;
        }

        let orderId;
        if (this.test) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} 测试] ${signal.eventSlug}-${
                    signal.marketSlug
                }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                    3
                )} ] 建仓 -> ${signal.chosen.outcome.toUpperCase()} @ ${price.toFixed(
                    3
                )} 数量=${sizeShares}`
            );
            return;
        }
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                signal.marketSlug
            }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                3
            )} ] 建仓 -> ${signal.chosen.outcome.toUpperCase()} @ ${price.toFixed(
                3
            )} 数量=${sizeShares}`
        );
        const entryOrder = await this.client
            .placeOrder(price, sizeShares, PolySide.BUY, tokenId)
            .catch((err) => {
                console.error(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                        signal.marketSlug
                    }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                        3
                    )} ] 建仓订单失败`,
                    err?.message ?? err
                );
                return null;
            });

        if (!entryOrder?.success) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                    signal.marketSlug
                }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                    3
                )} ] 建仓被拒绝:`,
                entryOrder
            );

            return;
        }
        orderId = entryOrder.orderID || entryOrder.id;
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                signal.marketSlug
            }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                3
            )} ] 建仓成交，订单号=${orderId}`
        );

        // YesNo事件：待止盈订单入队列
        this.takeProfitOrders.push({
            tokenId: tokenId,
            price: this.takeProfitPrice,
            size: sizeShares,
            signal: signal,
            orderId: null,
        });

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
            size: sizeShares,
        });
        await this.saveState();
    }

    async saveState() {
        // 读取当前配置，确保保存时保留配置
        let currentConfig = {};
        try {
            const data = JSON.parse(readFileSync(this.stateFilePath, "utf8"));
            currentConfig = data.config || {};
        } catch (err) {
            // 如果读取失败，使用当前实例的配置值
            currentConfig = {
                positionSizeUsdc: this.positionSizeUsdc,
                triggerPriceGt: this.triggerPriceGt,
                triggerPriceLt: this.triggerPriceLt,
                takeProfitPrice: this.takeProfitPrice,
                maxMinutesToEnd: this.maxMinutesToEnd,
                test: this.test,
                slugList: this.rawSlugList,
                cronExpression: this.cronExpression,
                cronTimeZone: this.cronTimeZone,
            };
        }

        const payload = {
            config: currentConfig,
            orders: this.orders,
        };
        await writeFile(this.stateFilePath, `${JSON.stringify(payload, null, 4)}\n`);
    }
}

export { TailConvergenceStrategy };
