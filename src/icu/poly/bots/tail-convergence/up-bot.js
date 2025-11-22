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
import { getZ } from "../../core/z-score.js";
import {
    loadStateFile,
    resolveSlugList,
    fetchMarketsWithinTime,
    fetchBestAsk,
    threshold,
} from "./common.js";
import { checkLiquidityDepletion } from "./liquidity-check.js";

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
         * - cronExpression / cronTimeZone：调度 cron 表达式及时区。
         * - slug：日内跟踪的事件 slug 模板,可包含 ${day} 占位符 (单值)。
         * - triggerPriceGt：触发信号的最高价格(超过该价格不建仓)。
         */
        const {
            positionSizeUsdc,
            maxMinutesToEnd,
            takeProfitPrice,
            ampMin = 0.001,
            tickIntervalSeconds = 30,
            cronExpression,
            cronTimeZone,
            slug,
            triggerPriceGt,
            allowExtraEntryAtCeiling = false,
            zMin,
            symbol = "ETH/USDT",
        } = config;

        Object.assign(this, {
            positionSizeUsdc,
            maxMinutesToEnd,
            takeProfitPrice,
            ampMin,
            tickIntervalSeconds,
            cronExpression,
            cronTimeZone,
            triggerPriceGt,
            allowExtraEntryAtCeiling,
            zMin,
            symbol,
        });

        this.httpTimeout = 10000;
        /**
         * 主循环 tick 间隔（毫秒）。
         */
        this.tickIntervalMs = tickIntervalSeconds * 1000;

        // 保存原始 slug 模板
        this.slugTemplate = slug;
        // 解析当天的 slug
        this.targetSlug = resolveSlugList(this.slugTemplate);
    }

    /**
     * 初始化运行态字段：负责保存订单状态、循环控制句柄等。
     * orders：策略历史订单记录,来自 state 文件。
     * takeProfitOrders：待提交的止盈订单队列。
     * loopTimer：主循环 setTimeout 句柄。
     *
     * loopActive：主循环是否正在运行。
     * currentLoopHour：当前 tick 循环对应的小时数,用于跨小时重置。
     * takeProfitCronTask：止盈监控 cron 任务句柄。
     */
    initializeRuntimeState(orders) {
        this.orders = orders || {};
        // 内存中的状态位
        this.initialEntryDone = false;
        this.extraEntryDone = false;

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
            `[扫尾盘策略-UpDown]
            建仓金额=${this.positionSizeUsdc}USDC
            动态触发价格阈值范围=[${maxThreshold} -->${minThreshold}] (基于剩余秒数)
            静态最高建仓价格=${this.triggerPriceGt}
            最大剩余时间=${this.maxMinutesToEnd}分钟,
            最小振幅=${this.ampMin},
            最小Z-Score=${this.zMin},
            最小止盈价格=${this.takeProfitPrice},
            tick间隔=${this.tickIntervalSeconds}s,
            是否测试模式=${this.test},
            Cron表达式=${this.cronExpression},时区=${this.cronTimeZone}`,
        );
    }

    async start() {
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
        console.log(`[扫尾盘策略] 主任务已启动,等待50分触发...Slug=${this.targetSlug}`);

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
            console.log(`[扫尾盘策略] 当前小时循环执行中,跳过本次触发(${source})`);
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
        // 循环结束时重置状态位
        this.initialEntryDone = false;
        this.extraEntryDone = false;
        // 重置 tick 间隔为初始配置值
        this.tickIntervalMs = this.tickIntervalSeconds * 1000;
        console.log(`[扫尾盘策略] 小时循环已结束\n`);
    }

    async runTickLoop() {
        if (!this.loopActive) {
            return;
        }
        if (dayjs().hour() !== this.currentLoopHour) {
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
        // 每次tick时重新解析slug,确保使用当天的日期
        this.targetSlug = resolveSlugList(this.slugTemplate);

        // 获取信号
        const signal = await this.processSlug(this.targetSlug);
        if (!signal) {
            return;
        }

        console.table([signal]);
        await this.handleSignal(signal);
    }

    /**
     * 简化止盈逻辑：事件结束后，直接查询订单成交情况，成交多少止盈多少
     * 使用最优bid价格直接成交，不做其他多余处理
     */
    async processTakeProfitOrders() {
        const pendingOrders = this.takeProfitOrders.filter((order) => !order.takeProfitOrderId);
        const errorOrders = this.takeProfitOrders.filter((order) => order.error);
        if (pendingOrders.length == errorOrders.length) {
            // pendingOrders 永远包含 errorOrders 中的订单 以及一些新提交的订单
            // 如果当前止盈订单队列 都为异常订单，结束调度、此时待处理止盈订单肯定为0
            if (this.takeProfitOrders.length) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] 无待处理止盈订单、结束调度\n`,
                );
                console.log(this.takeProfitOrders);
            }
            this.takeProfitOrders = errorOrders;
            return;
        }
        let processedCount = 0;
        let cancelledCount = 0;
        let takeProfitCount = 0;
        let errorCount = 0;
        let skippedCount = 0;
        for (const takeProfitOrder of pendingOrders) {
            if (takeProfitOrder.error) {
                // 跳过已有错误的订单，避免重复执行
                continue;
            }
            const orderKey = takeProfitOrder.signal.marketSlug;
            try {
                // 查询建仓订单状态
                const order = await this.client.getOrder(takeProfitOrder.entryOrderId);
                if (!order) {
                    console.log(
                        `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 订单不存在(可能已完全成交或取消)，跳过`,
                    );
                    skippedCount++;
                    processedCount++;
                    continue;
                }

                const matchedSize = Number(order.size_matched) || 0;
                const originalSize = Number(order.original_size) || 0;
                const remainingSize = originalSize - matchedSize;

                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 订单状态: 原始数量=${originalSize}, 已成交=${matchedSize}, 剩余=${remainingSize}`,
                );

                if (matchedSize === 0 || matchedSize < originalSize) {
                    // 未成交，或者部分成交 撤单
                    try {
                        await this.client.cancelOrder(takeProfitOrder.entryOrderId);
                        cancelledCount++;
                    } catch (cancelErr) {
                        errorCount++;
                    }
                    processedCount++;
                    continue;
                }

                // 完全成交，执行止盈
                const rlt = await this.executeTakeProfit(takeProfitOrder, matchedSize);
                if (!rlt) {
                    continue;
                }
                takeProfitCount++;
                processedCount++;
            } catch (err) {
                console.error(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 止盈执行异常`,
                    err?.message ?? err,
                );
                errorCount++;
                processedCount++;
                takeProfitOrder.error = err?.message ?? err;
            }
        }

        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] 处理完成: 总计=${processedCount}, 已止盈=${takeProfitCount}, 已撤单=${cancelledCount}, 跳过=${skippedCount}, 错误=${errorCount}`,
        );
    }

    /**
     * 执行止盈：使用最优bid价格直接成交
     */
    async executeTakeProfit(takeProfitOrder, size) {
        const orderKey = takeProfitOrder.signal.marketSlug;
        try {
            // 获取最优bid价格
            const [bestBid, bestAsk] = await this.client.getBestPrice(takeProfitOrder.tokenId);
            const bestBidPrice = typeof bestBid === "number" && bestBid > 0 ? bestBid : 0;
            // 先检查价格是否有效
            if (bestBidPrice <= 0) {
                return false;
            }

            // 再检查是否满足止盈价格要求
            if (bestBidPrice < this.takeProfitPrice) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 最优买价=${bestBidPrice} 小于止盈价格=${this.takeProfitPrice}，跳过 @${takeProfitOrder.tokenId}`,
                );
                return false;
            }

            const expectedRevenue = bestBidPrice * size;
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 准备提交止盈订单: SELL price=${bestBidPrice.toFixed(3)} size=${size} 预期收益=${expectedRevenue.toFixed(2)}`,
            );

            const takeProfitOrderResp = await this.client.placeOrder(
                bestBidPrice,
                size,
                PolySide.SELL,
                takeProfitOrder.tokenId,
            );

            if (!takeProfitOrderResp?.success) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 止盈订单被拒绝`,
                    takeProfitOrderResp?.message ?? takeProfitOrderResp.errorMsg,
                );
                throw new Error(`止盈订单被拒绝: ${takeProfitOrderResp?.message ?? takeProfitOrderResp.errorMsg}`);
            }

            const takeProfitOrderId = takeProfitOrderResp.orderID;
            takeProfitOrder.takeProfitOrderId = takeProfitOrderId;
            this.updateOrderTakerId(
                takeProfitOrder.signal,
                takeProfitOrder.entryOrderId,
                takeProfitOrderId,
            );

            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} ✅ 止盈订单已成功提交, 订单号=${takeProfitOrderId}`,
            );
            return true;
        } catch (err) {
            console.error(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 止盈执行异常`,
                err?.message ?? err,
            );
            throw new Error(`止盈执行异常: ${err?.message ?? err}`);
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
        console.log(
            `[扫尾盘策略] 止盈任务已启动，Cron表达式=${takeProfitCronExpression} (时区: ${this.cronTimeZone})`,
        );

        this.takeProfitCronTask = cron.schedule(
            takeProfitCronExpression,
            async () => {
                try {
                    await this.processTakeProfitOrders();
                } catch (err) {}
            },
            {
                timezone: this.cronTimeZone,
            },
        );
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
        const secondsToEnd = Math.abs(Math.floor((Date.parse(market.endDate) - Date.now()) / 1000));
        const zVal = await getZ(this.symbol, secondsToEnd);
        console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] Z-Score=${zVal}`);

        let isLiquiditySignal = false;
        const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);

        const [yesPrice, noPrice] = await Promise.all([
            fetchBestAsk(this.client, yesTokenId),
            fetchBestAsk(this.client, noTokenId),
        ]);
        const topPrice = Math.max(yesPrice, noPrice);

        if (zVal < this.zMin) {
            // 检查是否满足尾端流动性追踪条件：时间 > 57 分钟
            if (topPrice > 0.98 && dayjs().minute() > 58) {
                // 触发低波动率信号、等待流动性匮乏信号, 加速 tick 频率
                this.tickIntervalMs = Math.max(1000, this.tickIntervalMs / 2);

                const candidateTokenId = yesPrice >= noPrice ? yesTokenId : noTokenId;
                // 检查 0.99 流动性是否枯竭
                const isDepleted = await checkLiquidityDepletion(this.client, candidateTokenId);

                if (isDepleted) {
                    console.log(
                        `[@${dayjs().format(
                            "YYYY-MM-DD HH:mm:ss",
                        )} ${market.slug}] 触发尾端流动性追踪信号 (Z=${zVal} < ${this.zMin}, Time>57, LiquidityDepleted=true)`,
                    );
                    isLiquiditySignal = true;
                } else {
                    return null;
                }
            } else {
                return null;
            }
        }



        const priceThreshold = threshold(secondsToEnd);
        // 检查价格是否在触发价格范围内
        // 如果是流动性信号，跳过 triggerPriceGt 上限检查（因为目标是追 0.99）
        if (!isLiquiditySignal && (topPrice < priceThreshold || topPrice > this.triggerPriceGt)) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 顶部价格=${topPrice} 不在触发价格范围=[${priceThreshold}, ${this.triggerPriceGt}],不处理`,
            );
            return null;
        }
        // UpDown事件：波动率检查
        // 查询该币对、最近一根小时级别k线、检查波动率是否大于${this.ampMin}
        const amp = await this.get1HourAmp();
        // 如果是 Liquidity Signal，跳过波动率检查
        if (!isLiquiditySignal && amp < this.ampMin) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 波动率=${amp.toFixed(3)} 小于最小波动率=${this.ampMin},不处理`,
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
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 选择=${candidate.outcome.toUpperCase()}@${candidate.price.toFixed(3)}`,
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
        const symbol = this.symbol.replace("/", "");
        const klines = await axios.get(
            `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1`,
        );
        if (!klines?.data?.length) {
            return 1;
        }
        const kline = klines.data[0];
        return Math.abs(kline[1] - kline[4]) / kline[1];
    }

    /**
     * 检查卖方流动性是否充沛
     * @param {string} tokenId - token ID
     * @param {number} threshold - 流动性阈值，默认500
     * @returns {Promise<boolean>}
     */
    async checkSellerLiquidity(tokenId, threshold = 1000) {
        try {
            const orderBook = await this.client.getOrderBook(tokenId);
            if (!orderBook?.asks?.length) {
                return false;
            }
            // 计算所有卖方订单的总流动性（size总和）
            const totalLiquidity = orderBook.asks.reduce((sum, ask) => {
                const size = Number(ask.size) || 0;
                return sum + size;
            }, 0);
            return totalLiquidity >= threshold;
        } catch (err) {
            return false;
        }
    }

    // 检查是否已建仓,未建仓则执行建仓
    async handleSignal(signal) {
        const marketSlug = signal.marketSlug;

        if (!this.initialEntryDone) {
            // 未建仓则执行建仓
            await this.openPosition({
                tokenId: signal.chosen.tokenId,
                price: signal.chosen.price,
                sizeUsd: this.positionSizeUsdc,
                signal,
                isExtra: false
            });
            return;
        }

        // 已建仓则执行额外买入逻辑
        do {
            // 先检查配置开关
            if (!this.allowExtraEntryAtCeiling) {
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 不允许额外买入，跳过`,
                );
                break;
            }
            // 在检查是否已用过额外买入
            if (this.extraEntryDone) {
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 额外买入次数已达上限，跳过`,
                );
                break;
            }
            const price = Number(signal.chosen.price);
            // 再检查是否满足额外时间和流动性条件
            if (
                dayjs().minute() < 55 &&
                price < 0.97 &&
                (await this.checkSellerLiquidity(signal.chosen.tokenId))
            ) {
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 未到收敛尾端、当前时间小于55分钟且价格小于0.97且卖方流动性充足，跳过`,
                );
                break;
            }
            // 在检查价格和amp是否满足条件
            // 单纯价格控制 还不够贪、如果此时amp已经远大于ampMin、则可以稍微激进、尝试入场0.98 0.97 附近的流动性
            // 价格0.99 则amp大于0.001 则可以入场
            // 价格0.98 则amp大于0.002 则可以入场
            // 价格0.97 则amp大于0.004 则可以入场
            if (price >= 0.97) {
                let requiredAmp;
                if (price >= 0.99) {
                    // 当价格为0.99的场合、入场条件、时间大于50分钟、且波动率大于0.002
                    requiredAmp = 0.002;
                } else if (price >= 0.98 && dayjs().minute() > 55) {
                    // 当价格为0.98的场合、入场条件、时间大于55分钟、且波动率大于0.004
                    requiredAmp = 0.004;
                } else if (
                    price >= 0.97 &&
                    dayjs().minute() > 57 &&
                    this.checkSellerLiquidity(signal.chosen.tokenId)
                ) {
                    // price >= 0.97 && price < 0.98
                    // 当价格为0.97的场合、入场条件、时间大于57分钟、且波动率大于0.008
                    requiredAmp = 0.008;
                } else {
                    console.log(
                        `[@${dayjs().format(
                            "YYYY-MM-DD HH:mm:ss",
                        )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 价格=${price.toFixed(3)} 不在额外买入时间范围内,不处理`,
                    );
                    break;
                }
                const amp = await this.get1HourAmp();
                try {
                    const secondsRemaining = Math.max(
                        0,
                        3600 - (dayjs().minute() * 60 + dayjs().second()),
                    );
                    const zVal = await getZ(this.symbol, secondsRemaining);
                    console.log(
                        `[@${dayjs().format(
                            "YYYY-MM-DD HH:mm:ss",
                        )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] [观察] Z-Score=${zVal.toFixed(
                            4,
                        )} (amp=${amp.toFixed(4)})`,
                    );
                } catch (err) {
                    console.error(`[观察] 获取Z-Score失败:`, err.message);
                }
                if (amp < requiredAmp) {
                    console.log(
                        `[@${dayjs().format(
                            "YYYY-MM-DD HH:mm:ss",
                        )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 价格=${price.toFixed(3)} 波动率=${amp.toFixed(3)} 小于要求波动率=${requiredAmp},不处理`,
                    );
                    break;
                }
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 价格=${price.toFixed(3)} 波动率=${amp.toFixed(3)} 满足要求波动率=${requiredAmp},继续`,
                );
            }
            // this.extraEntryUsed = true;
            const sizeUsd = await this.resolvePositionSize();
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] -> ${signal.chosen.outcome.toUpperCase()}  price@${signal.chosen.price.toFixed(3)} 数量@${sizeUsd}`,
            );
            await this.openPosition({
                tokenId: signal.chosen.tokenId,
                price: signal.chosen.price,
                sizeUsd,
                signal,
                isExtra: true
            });
            return;
        } while (false);
        console.log(
            `[@${dayjs().format(
                "YYYY-MM-DD HH:mm:ss",
            )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                3,
            )} ] 已建仓,跳过`,
        );
    }

    async resolvePositionSize() {
        try {
            const balanceRaw = await this.client.getUsdcEBalance();
            const balance = Math.floor(Number(balanceRaw));
            if (Number.isFinite(balance) && balance > 0) {
                return balance;
            }
            console.log(
                `[@${dayjs().format(
                    "YYYY-MM-DD HH:mm:ss",
                )}] [建仓预算] USDC.e 余额无效(${balanceRaw}),使用默认建仓金额=${this.positionSizeUsdc}`,
            );
        } catch (err) {
            console.error(
                `[@${dayjs().format(
                    "YYYY-MM-DD HH:mm:ss",
                )}] [建仓预算] 获取USDC.e余额失败,使用默认建仓金额`,
                err?.message ?? err,
            );
        }
        return this.positionSizeUsdc;
    }

    // 负责下买单、并记录状态、同时止盈订单入队列
    async openPosition({ tokenId, price, sizeUsd, signal, isExtra }) {
        const sizeShares = Math.floor(sizeUsd / price);
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.marketSlug} ${
                this.test ? "测试" : "实盘"
            }] 建仓 ->
                ${signal.chosen.outcome.toUpperCase()}
                price@${price.toFixed(3)}
                数量@${sizeShares}
                sizeUsd@${sizeUsd}
                tokenId@${tokenId}`,
        );
        const entryOrder = await this.client
            .placeOrder(price, sizeShares, PolySide.BUY, tokenId)
            .catch((err) => {
                console.error(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                        3,
                    )} ] 建仓订单失败`,
                    err?.message ?? err,
                );
                return null;
            });
        if (!entryOrder?.success) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                    3,
                )} ] 建仓被拒绝:`,
                entryOrder,
            );

            return;
        }
        const orderId = entryOrder.orderID;
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.marketSlug}] ✅ 建仓成交,订单号=${orderId}`,
        );

        // UpDown事件：建仓后进入止盈队列,由止盈cron在事件结束后处理
        const takeProfitOrder = {
            tokenId: tokenId,
            size: Number(sizeShares),
            signal,
            entryOrderId: orderId,
            takeProfitOrderId: null, // 止盈订单ID，提交后设置
        };
        this.takeProfitOrders.push(takeProfitOrder);
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.marketSlug}] 已加入止盈队列,当前止盈队列长度=${this.takeProfitOrders.length}`,
        );

        // 更新状态
        if (isExtra) {
            this.extraEntryDone = true;
        } else {
            this.initialEntryDone = true;
        }

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
            takeProfitOrderId: null,
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
            zMin: this.zMin,
            symbol: this.symbol,
            takeProfitPrice: this.takeProfitPrice,
            test: this.test,
            slug: this.slugTemplate,
            cronExpression: this.cronExpression,
            cronTimeZone: this.cronTimeZone,
            tickIntervalSeconds: this.tickIntervalSeconds,
            allowExtraEntryAtCeiling: this.allowExtraEntryAtCeiling,
        };
        delete currentConfig.slugList;

        // 限制orders对象最多拥有5个字段（5个市场），保存时只保留最后5个
        const MAX_MARKETS = 5;
        const entries = Object.entries(this.orders);
        let limitedOrders = {};
        if (entries.length > MAX_MARKETS) {
            const limitedEntries = entries.slice(-MAX_MARKETS);
            limitedOrders = Object.fromEntries(limitedEntries);
        } else {
            limitedOrders = this.orders;
        }

        const payload = {
            config: currentConfig,
            orders: limitedOrders,
        };
        await writeFile(this.stateFilePath, `${JSON.stringify(payload, null, 4)}\n`);
    }

    updateOrderTakerId(signal, entryOrderId, takeProfitOrderId) {
        if (!entryOrderId || !takeProfitOrderId) {
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
        targetOrder.takeProfitOrderId = takeProfitOrderId;
        this.saveState().catch((err) => {
            console.error("[扫尾盘策略] 保存taker订单状态失败", err);
        });
    }
}

export { TailConvergenceStrategy };
