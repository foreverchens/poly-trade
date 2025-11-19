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
import { writeFile } from "fs/promises";
import { readFileSync } from "fs";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";
import dayjs from "dayjs";
import cron from "node-cron";
import { PolyClient, PolySide } from "../../core/PolyClient.js";
import {
    loadStateFile,
    resolveSlugList,
    fetchMarketsWithinTime,
    fetchBestAsk,
    threshold,
} from "./common.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_STATE_FILE = path.resolve(__dirname, "./data/convergence-up.data.json");

class TailConvergenceStrategy {
    constructor(stateFilePath = DEFAULT_STATE_FILE) {
        this.stateFilePath = stateFilePath;

        const { config, orders } = loadStateFile(this.stateFilePath);
        this.test = config.test ?? true;
        this.client = new PolyClient(this.test);
        console.log(
            `[扫尾盘策略] 读取状态文件=${this.stateFilePath},测试模式=${this.test ? "开启" : "关闭"}`,
        );

        this.initializeConfig(config);
        this.initializeRuntimeState(orders);
        this.validateCronConfig();
        this.logBootstrapSummary();
    }

    /**
     * 初始化策略配置：覆盖策略规模、触发条件以及调度节奏。
     * 统一在此处设置默认值,方便后续维护。
     */
    initializeConfig(config) {
        /**
         * config 字段说明：
         * - positionSizeUsdc：单次建仓的美元金额。
         * - maxMinutesToEnd：离市场截止的剩余分钟数阈值,过期市场会被过滤。
         * - takeProfitPrice：止盈挂单价格。
         * - ampMin：最近 1 小时振幅下限,波动太小忽略。
         * - tickIntervalSeconds：主循环 tick 间隔秒数。
         * - takeProfitIntervalSeconds：止盈监视器轮询间隔秒数。
         * - cronExpression / cronTimeZone：调度 cron 表达式及时区。
         * - slugList：日内跟踪的事件 slug 模板,可包含 ${day} 占位符。
         * - triggerPriceGt：触发信号的最高价格(超过该价格不建仓)。
         */
        const {
            positionSizeUsdc,
            maxMinutesToEnd,
            takeProfitPrice,
            ampMin = 0.001,
            tickIntervalSeconds = 30,
            takeProfitIntervalSeconds = 10,
            cronExpression,
            cronTimeZone,
            slugList,
            triggerPriceGt,
        } = config;

        Object.assign(this, {
            positionSizeUsdc,
            maxMinutesToEnd,
            takeProfitPrice,
            ampMin,
            tickIntervalSeconds,
            takeProfitIntervalSeconds,
            cronExpression,
            cronTimeZone,
            triggerPriceGt,
        });

        this.httpTimeout = 10000;
        /**
         * 主循环 tick 间隔（毫秒）。
         */
        this.tickIntervalMs = tickIntervalSeconds * 1000;
        /**
         * 止盈轮询间隔（毫秒）。
         */
        this.takeProfitIntervalMs = takeProfitIntervalSeconds * 1000;

        // 保存原始 slug 列表模板（包含 ${day} 占位符）,每个 tick 重新解析即可支持日滚动。
        this.rawSlugList = slugList;
        this.whitelist = resolveSlugList(this.rawSlugList);
    }

    /**
     * 初始化运行态字段：负责保存订单状态、循环控制句柄等。
     * orders：策略历史订单记录,来自 state 文件。
     * takeProfitOrders：待提交的止盈订单队列。
     * loopTimer：主循环 setTimeout 句柄。
     * loopActive：主循环是否正在运行。
     * currentLoopHour：当前 tick 循环对应的小时数,用于跨小时重置。
     * takeProfitCronTask：止盈监控 cron 任务句柄。
     */
    initializeRuntimeState(orders) {
        this.orders = orders;
        this.takeProfitOrders = [];
        this.loopTimer = null;
        this.loopActive = false;
        this.currentLoopHour = null;
        this.takeProfitCronTask = null;
    }

    /**
     * 构造阶段即校验 Cron 配置,确保定时任务参数有效。
     */
    validateCronConfig() {
        if (!this.cronExpression) {
            throw new Error("未配置 Cron 表达式,无法调度策略");
        }
        if (!cron.validate(this.cronExpression)) {
            throw new Error(`无效的Cron表达式: ${this.cronExpression}`);
        }
    }

    logBootstrapSummary() {
        const maxThreshold = threshold(600);
        const minThreshold = threshold(0);
        console.log(
            `\n[扫尾盘策略-UpDown] \n建仓金额=${this.positionSizeUsdc}USDC\n动态触发价格阈值范围=[${maxThreshold} -->${minThreshold }] (基于剩余秒数)\n静态最高建仓价格=${this.triggerPriceGt}\n
            最大剩余时间=${this.maxMinutesToEnd}分钟,
            最小振幅=${this.ampMin},止盈价格=${this.takeProfitPrice},tick间隔=${this.tickIntervalSeconds}s,是否测试模式=${this.test}`,
        );
        console.log(`[扫尾盘策略] Cron表达式=${this.cronExpression},时区=${this.cronTimeZone}`);
    }

    async start() {
        console.log(`[扫尾盘策略] 启动,白名单=${this.whitelist.join(",")}`);
        console.log(
            `[扫尾盘策略] 使用Cron表达式调度：${this.cronExpression} (时区: ${this.cronTimeZone})`,
        );

        // 使用 cron 调度任务
        this.cronTask = cron.schedule(
            this.cronExpression,
            () => {
                this.startHourlyLoop("cron");
            },
            {
                timezone: this.cronTimeZone,
            },
        );

        console.log(`[扫尾盘策略] Cron任务已启动,等待50分触发...`);

        // 启动止盈监控（每小时0-20分钟执行）
        this.startTakeProfitMonitor();

        // 测试模式下立即启动循环
        if (this.test) {
            console.log(`[扫尾盘策略] 测试模式：立即启动tick循环`);
            this.startHourlyLoop("test");
        }
    }

    startHourlyLoop(source = "cron") {
        if (this.loopActive) {
            console.log(`[扫尾盘策略] 当前小时循环仍在执行,跳过本次触发(${source})`);
            return;
        }
        this.loopActive = true;
        this.currentLoopHour = dayjs().hour();
        console.log(`[扫尾盘策略] 启动小时循环(${source}),当前小时=${this.currentLoopHour}`);
        this.runTickLoop();
    }

    stopHourlyLoop() {
        if (this.loopTimer) {
            clearTimeout(this.loopTimer);
            this.loopTimer = null;
        }
        this.loopActive = false;
        this.currentLoopHour = null;
        console.log(`[扫尾盘策略] 小时循环已结束`);
    }

    async runTickLoop() {
        if (!this.loopActive) {
            return;
        }
        if (dayjs().hour() !== this.currentLoopHour) {
            console.log("[扫尾盘策略] 小时已结束,停止当前tick循环");
            this.stopHourlyLoop();
            return;
        }
        try {
            await this.tick();
        } catch (err) {
            console.error("[扫尾盘策略] tick执行失败", err);
        }
        this.loopTimer = setTimeout(() => {
            this.runTickLoop();
        }, this.tickIntervalMs);
    }

    async tick() {
        console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] 开始执行tick`);
        // 每次tick时重新解析slugList,确保使用当天的日期
        this.whitelist = resolveSlugList(this.rawSlugList);

        let signals = [];
        // 获取信号 若信号已存在则跳过
        for (const slug of this.whitelist) {
            const signal = await this.processSlug(slug);
            if (!signal) {
                console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${slug}] 无信号`);
                continue;
            }
            signals.push(signal);
        }

        if (!signals.length) {
            console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] 无待处理信号`);
            return;
        }
        signals = signals.sort((a, b) => a.chosen.price - b.chosen.price).slice(0, 4);
        console.table(signals);
        // 处理信号 若订单已存在则跳过
        for (const signal of signals) {
            console.log(
                `\n[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                    signal.marketSlug
                }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                    3,
                )} ] 开始处理信号`,
            );
            await this.handleSignal(signal);
        }
    }

    /**
     * 简化止盈逻辑：事件结束后，直接查询订单成交情况，成交多少止盈多少
     * 使用最优bid价格直接成交，不做其他多余处理
     */
    async processTakeProfitOrders() {
        const pendingOrders = this.takeProfitOrders.filter((order) => !order.orderId);
        if (!pendingOrders.length) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] 无待处理止盈订单`,
            );
            return;
        }

        console.log(
            `\n[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] 开始处理，待处理订单数=${pendingOrders.length}`,
        );

        let processedCount = 0;
        let skippedCount = 0;
        let cancelledCount = 0;
        let takeProfitCount = 0;
        let errorCount = 0;

        for (const takeProfitOrder of pendingOrders) {
            const orderKey = `${takeProfitOrder.signal.eventSlug}-${takeProfitOrder.signal.marketSlug}`;
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] 处理订单: ${orderKey}, 建仓订单ID=${takeProfitOrder.entryOrderId}`,
            );

            try {
                // 查询建仓订单状态
                const order = await this.client.getOrder(takeProfitOrder.entryOrderId);
                if (!order) {
                    console.log(
                        `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] ${orderKey} 订单不存在(可能已完全成交或取消)，跳过`,
                    );
                    skippedCount++;
                    continue;
                }

                const matchedSize = Number(order.size_matched) || 0;
                const originalSize = Number(order.original_size) || 0;
                const remainingSize = originalSize - matchedSize;

                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] ${orderKey} 订单状态: 原始数量=${originalSize}, 已成交=${matchedSize}, 剩余=${remainingSize}`,
                );

                if (matchedSize === 0 || matchedSize < originalSize) {
                    // 未成交，或者部分成交 撤单
                    try {
                        await this.client.cancelOrder(takeProfitOrder.entryOrderId);
                        console.log(
                            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] ${orderKey} 已撤单 (未成交=${matchedSize === 0 ? "是" : "否"}, 部分成交=${matchedSize > 0 && matchedSize < originalSize ? "是" : "否"})`,
                        );
                        cancelledCount++;
                    } catch (cancelErr) {
                        console.error(
                            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] ${orderKey} 撤单失败`,
                            cancelErr?.message ?? cancelErr,
                        );
                        errorCount++;
                    }
                    processedCount++;
                    continue;
                }

                // 完全成交，执行止盈
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] ${orderKey} 订单已完全成交，开始止盈 (数量=${matchedSize})`,
                );
                const rlt = await this.executeTakeProfit(takeProfitOrder, matchedSize);
                if(!rlt){
                    continue;
                }
                takeProfitCount++;
                processedCount++;
            } catch (err) {
                console.error(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] ${orderKey} 处理失败`,
                    err?.message ?? err,
                );
                errorCount++;
            }
        }

        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈监控] 处理完成: 总计=${processedCount}, 已止盈=${takeProfitCount}, 已撤单=${cancelledCount}, 跳过=${skippedCount}, 错误=${errorCount}`,
        );
    }

    /**
     * 执行止盈：使用最优bid价格直接成交
     */
    async executeTakeProfit(takeProfitOrder, size) {
        const orderKey = `${takeProfitOrder.signal.eventSlug}-${takeProfitOrder.signal.marketSlug}`;

        if (size <= 0) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 止盈数量无效: ${size}，跳过`,
            );
            return false;
        }

        try {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 开始查询最优价格, tokenId=${takeProfitOrder.tokenId}, 止盈数量=${size}`,
            );

            // 获取最优bid价格
            const [bestBid, bestAsk] = await this.client.getBestPrice(takeProfitOrder.tokenId);
            const bestBidPrice = typeof bestBid === "number" && bestBid > 0 ? bestBid : 0;
            const bestAskPrice = typeof bestAsk === "number" && bestAsk > 0 ? bestAsk : 0;

            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 价格查询结果: 最优买价=${bestBidPrice.toFixed(3)}, 最优卖价=${bestAskPrice.toFixed(3)}`,
            );

            // 先检查价格是否有效
            if (bestBidPrice <= 0) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 无有效买单价格，无法止盈`,
                );
                return false;
            }

            // 再检查是否满足止盈价格要求
            if (bestBidPrice < this.takeProfitPrice) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 最优买价=${bestBidPrice.toFixed(3)} 小于止盈价格=${this.takeProfitPrice.toFixed(3)}, 跳过`,
                );
                return false;
            }

            const expectedRevenue = bestBidPrice * size;
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 准备提交止盈订单: SELL token=${takeProfitOrder.tokenId} price=${bestBidPrice.toFixed(3)} size=${size} 预期收益=${expectedRevenue.toFixed(2)}`,
            );

            const takeProfitOrderResp = await this.client
                .placeOrder(bestBidPrice, size, PolySide.SELL, takeProfitOrder.tokenId)
                .catch((err) => {
                    console.error(
                        `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 止盈订单提交失败`,
                        err?.message ?? err,
                    );
                    return null;
                });

            if (!takeProfitOrderResp?.success) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 止盈订单被拒绝`,
                    takeProfitOrderResp,
                );
                return false;
            }

            const orderId = takeProfitOrderResp.orderID;
            takeProfitOrder.orderId = orderId;
            this.updateOrderTakerId(
                takeProfitOrder.signal,
                takeProfitOrder.entryOrderId,
                orderId,
            );

            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} ✅ 止盈订单已成功提交, 订单号=${orderId}, 建仓订单=${takeProfitOrder.entryOrderId}`,
            );
            return true;
        } catch (err) {
            console.error(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈执行] ${orderKey} 止盈执行异常`,
                err?.message ?? err,
            );
            return false;
        }
    }

    /**
     * 启动止盈监控：每小时0-20分钟，每分钟执行一次
     */
    startTakeProfitMonitor() {
        if (this.takeProfitCronTask) {
            console.log(`[扫尾盘策略] 止盈监控已启动，跳过重复启动`);
            return; // 已启动
        }

        // Cron表达式：每小时0-20分钟，每3分钟执行一次 (0-20/3 * * * *)
        const takeProfitCronExpression = "0-20/3 * * * *";
        const pendingCount = this.takeProfitOrders.filter((order) => !order.orderId).length;
        console.log(
            `[扫尾盘策略] 启动止盈监控，Cron表达式=${takeProfitCronExpression} (时区: ${this.cronTimeZone}), 当前待处理订单数=${pendingCount}`,
        );

        this.takeProfitCronTask = cron.schedule(
            takeProfitCronExpression,
            async () => {
                const now = dayjs().format("YYYY-MM-DD HH:mm:ss");
                console.log(`[@${now}] [止盈监控] Cron任务触发，开始执行止盈检查`);
                try {
                    await this.processTakeProfitOrders();
                } catch (err) {
                    console.error(`[@${now}] [止盈监控] Cron任务执行失败`, err?.message ?? err);
                }
            },
            {
                timezone: this.cronTimeZone,
            },
        );

        console.log(`[扫尾盘策略] 止盈监控已成功启动`);
    }

    stopTakeProfitMonitor() {
        if (this.takeProfitCronTask) {
            this.takeProfitCronTask.stop();
            this.takeProfitCronTask = null;
            this.takeProfitOrders = [];
            console.log(`[扫尾盘策略] 止盈监控已停止`);
        }
    }


    /**
     * 请求单个涨跌事件slug 的市场列表,再逐一检查旗下市场
     * @param {string} slug
     * @returns
     */
    async processSlug(slug) {
        // 获取事件下可用的市场列表、仅先进行结束时间过滤、后续再基于订单簿价格确认
        const markets = await fetchMarketsWithinTime(slug, this.maxMinutesToEnd);
        if (!markets.length) {
            return null;
        }

        try {
            return await this.buildSignal(slug, markets[0]);
        } catch (err) {
            console.error(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${slug}] 获取失败`,
                err?.message ?? err,
            );
        }
        return null;
    }

    // 构建交易信号：限定剩余时间,并找出概率 >= entryTrigger 的方向
    async buildSignal(eventSlug, market) {
        const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);

        const [yesPrice, noPrice] = await Promise.all([
            fetchBestAsk(this.client, yesTokenId),
            fetchBestAsk(this.client, noTokenId),
        ]);
        const topPrice = Math.max(yesPrice, noPrice);

        const secondsToEnd = Math.max(
            0,
            Math.floor((Date.parse(market.endDate) - Date.now()) / 1000),
        );
        const priceThreshold = threshold(secondsToEnd);
        console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${eventSlug}-${market.slug}] ${secondsToEnd} --> ${priceThreshold}`);
        if (topPrice < priceThreshold) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${eventSlug}-${market.slug}] 顶部价格=${topPrice.toFixed(
                    3,
                )} 小于动态阈值=${priceThreshold} (剩余${Math.ceil(
                    secondsToEnd / 60,
                )}分钟),不处理`,
            );
            return null;
        }
        if (topPrice > this.triggerPriceGt) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${eventSlug}-${market.slug}] 顶部价格=${topPrice.toFixed(
                    3,
                )} 大于静态阈值=${this.triggerPriceGt},不处理`,
            );
            return null;
        }
        // UpDown事件：波动率检查
        // 查询该币对、最近一根小时级别k线、检查波动率是否大于${this.ampMin}
        const amp = await this.get1HourAmp();
        if (amp < this.ampMin) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${eventSlug}-${
                    market.slug
                }] 波动率=${amp.toFixed(3)} 小于最小波动率=${this.ampMin},不处理`,
            );
            return null;
        }
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${eventSlug}-${
                market.slug
            }] 波动率=${amp.toFixed(3)} 大于最小波动率=${this.ampMin},处理`,
        );

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
            }] 选择=${candidate.outcome.toUpperCase()}@${candidate.price.toFixed(3)}`,
        );
        return {
            eventSlug: this.test ? `${eventSlug}-test` : eventSlug,
            marketSlug: market.slug,
            chosen: candidate,
            yesPrice,
            noPrice,
        };
    }
    async get1HourAmp() {
        // 调用binance 现货api获取ETH最近一根小时级别k线、
        const klines = await axios.get(
            `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1h&limit=1`,
        );
        if (!klines?.data?.length) {
            return 0;
        }
        const kline = klines.data[0];
        return Math.abs(kline[1] - kline[4]) / kline[1];

    }

    // 检查是否已建仓,未建仓则执行建仓
    async handleSignal(signal) {
        const eventSlug = signal.eventSlug;
        const marketSlug = signal.marketSlug;

        // 检查该市场是否已有订单
        const eventOrders = this.orders[eventSlug] || [];
        const existingOrder = eventOrders.find((order) => order.marketSlug === marketSlug);

        if (existingOrder) {
            console.log(
                `[@${dayjs().format(
                    "YYYY-MM-DD HH:mm:ss",
                )} ${eventSlug}-${marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                    3,
                )} ] 已建仓,跳过`,
            );
            return;
        }

        console.log(
            `[@${dayjs().format(
                "YYYY-MM-DD HH:mm:ss",
            )} ${eventSlug}-${marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                3,
            )} ] 执行建仓`,
        );
        await this.openPosition({
            tokenId: signal.chosen.tokenId,
            price: signal.chosen.price,
            sizeUsd: this.positionSizeUsdc,
            signal,
        });
    }

    // 负责下买单、并记录状态、同时止盈订单入队列
    async openPosition({ tokenId, price, sizeUsd, signal }) {
        const sizeShares = Math.abs(Math.round(sizeUsd / price));
        if (sizeShares <= 0) {
            console.error(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                    signal.marketSlug
                }] 无效的份额数量=${sizeShares} 金额=${sizeUsd} 价格=${price}`,
            );
            return;
        }

        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${
                signal.eventSlug
            }-${signal.marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                3,
            )} ] 建仓 -> ${signal.chosen.outcome.toUpperCase()} @ ${price.toFixed(3)} 数量=${sizeShares}`,
        );
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${signal.marketSlug}] ${
                this.test ? "测试" : "实盘"
            } 建仓下单准备 -> ${signal.chosen.outcome.toUpperCase()} token=${tokenId} price=${price.toFixed(
                3,
            )} size=${sizeShares}`,
        );
        const entryOrder = await this.client
            .placeOrder(price, sizeShares, PolySide.BUY, tokenId)
            .catch((err) => {
                console.error(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                        signal.marketSlug
                    }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                        3,
                    )} ] 建仓订单失败`,
                    err?.message ?? err,
                );
                return null;
            });
        if (!entryOrder?.success) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${
                    signal.marketSlug
                }-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                    3,
                )} ] 建仓被拒绝:`,
                entryOrder,
            );

            return;
        }
        const orderId = entryOrder.orderID;
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.eventSlug}-${signal.marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(3)} ] 建仓成交,订单号=${orderId}`,
        );

        // UpDown事件：建仓后进入止盈队列,由止盈cron在事件结束后处理
        const takeProfitOrder = {
            tokenId: tokenId,
            size: Number(sizeShares),
            signal,
            entryOrderId: orderId,
            orderId: null, // 止盈订单ID，提交后设置
        };
        this.takeProfitOrders.push(takeProfitOrder);
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [建仓] ${signal.eventSlug}-${signal.marketSlug} 已加入止盈队列, 建仓订单=${orderId}, 数量=${sizeShares}, 当前止盈队列长度=${this.takeProfitOrders.length}`,
        );

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
            takerOrderId: null,
        });
        await this.saveState();
    }

    async saveState() {
        // 读取当前配置,确保保存时保留配置
        let currentConfig = {};
        try {
            const data = JSON.parse(readFileSync(this.stateFilePath, "utf8"));
            currentConfig = data.config || {};
        } catch (err) {
            // 如果读取失败,使用当前实例的配置值
            currentConfig = {};
        }

        currentConfig = {
            ...currentConfig,
            positionSizeUsdc: this.positionSizeUsdc,
            triggerPriceGt: this.triggerPriceGt,
            maxMinutesToEnd: this.maxMinutesToEnd,
            ampMin: this.ampMin,
            takeProfitPrice: this.takeProfitPrice,
            test: this.test,
            slugList: this.rawSlugList,
            cronExpression: this.cronExpression,
            cronTimeZone: this.cronTimeZone,
            tickIntervalSeconds: this.tickIntervalSeconds,
            takeProfitIntervalSeconds: this.takeProfitIntervalSeconds,
        };

        const payload = {
            config: currentConfig,
            orders: this.orders,
        };
        await writeFile(this.stateFilePath, `${JSON.stringify(payload, null, 4)}\n`);
    }

    updateOrderTakerId(signal, entryOrderId, takerOrderId) {
        if (!entryOrderId || !takerOrderId) {
            return;
        }
        const eventOrders = this.orders[signal.eventSlug];
        if (!eventOrders?.length) {
            return;
        }
        const targetOrder = eventOrders.find((order) => order.orderId === entryOrderId);
        if (!targetOrder) {
            return;
        }
        targetOrder.takerOrderId = takerOrderId;
        this.saveState().catch((err) => {
            console.error("[扫尾盘策略] 保存taker订单状态失败", err);
        });
    }
}

export { TailConvergenceStrategy };
