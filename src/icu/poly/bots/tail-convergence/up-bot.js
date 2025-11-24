import "dotenv/config";
import dayjs from "dayjs";
import cron from "node-cron";
import { PolyClient, PolySide } from "../../core/PolyClient.js";
import { getZ } from "../../core/z-score.js";
import { loadStateFile, fetchBestAsk, threshold, get1HourAmp } from "./common.js";
import { TakeProfitManager } from "./take-profit.js";
import { UpBotCache } from "./up-bot-cache.js";
import { saveOrder } from "../../db/repository.js";
import logger from "../../core/Logger.js";

class TailConvergenceStrategy {
    constructor(stateFilePath) {
        this.stateFilePath = stateFilePath;

        const { config } = loadStateFile(this.stateFilePath);
        this.test = config.test ?? true;
        this.client = new PolyClient(this.test);
        console.log(
            `[扫尾盘策略] 读取状态文件=${this.stateFilePath},测试模式=${this.test ? "开启" : "关闭"}`,
        );

        this.initializeConfig(config);
        this.initializeRuntimeState();

        // 初始化缓存层 (UpBot专用)
        this.cache = new UpBotCache({
            slug: this.slugTemplate,
            maxMinutesToEnd: this.maxMinutesToEnd,
        });

        // 初始化止盈管理器
        this.tpManager = new TakeProfitManager(this.client, {
            cronTimeZone: this.cronTimeZone,
            takeProfitPrice: this.takeProfitPrice,
        });

        this.validateCronConfig();
        this.logBootstrapSummary();
    }

    /**
     * 初始化策略配置
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
    }

    /**
     * 初始化运行态字段
     */
    initializeRuntimeState() {
        // 内存中的状态位 初始建仓完成、额外建仓完成
        this.initialEntryDone = false;
        this.extraEntryDone = false;

        // 主循环 setTimeout 句柄
        this.loopTimer = null;
        // 主循环是否正在运行
        this.loopActive = false;
        // 当前 tick 循环对应的小时数,用于跨小时重置
        this.currentLoopHour = null;

        // 0 30~50分钟且流动性充足、待机
        // 1 50~60分钟或者流动性枯竭、监控
        this.loopState = 0;
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
        const earlyThreshold = threshold(600);
        const lateThreshold = threshold(0);
        console.log(
            `[扫尾盘策略-UpDown]
            建仓金额=${this.positionSizeUsdc}USDC
            动态触发价格阈值范围=[${earlyThreshold}(剩余10分) --> ${lateThreshold}(即将结束)] (基于剩余秒数)
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

    /**
     * 主启动 各种组件启动
     */
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
        console.log(`[扫尾盘策略] 主任务已启动,等待调度触发...`);

        // 启动止盈监控（每小时0-20分钟执行）
        this.tpManager.startTakeProfitMonitor();

        // 测试模式下立即启动循环
        if (this.test) {
            console.log(`[扫尾盘策略] 测试模式：立即启动tick循环`);
            this.startHourlyLoop("test");
        }
    }

    /**
     * 循环调度启动、运行时状态初始化、开始tick循环
     * @param {string} source 启动来源 cron/test
     */
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

    /**
     * 停止循环、重置运行时状态、停止tick循环
     */
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
        // 重置循环状态
        this.loopState = 0;
        console.log(`[扫尾盘策略] 小时循环已结束\n`);
    }

    /**
     * 循环执行、检查是否需要停止循环
     */
    async runTickLoop() {
        if (!this.loopActive) {
            return;
        }
        if (dayjs().hour() !== this.currentLoopHour) {
            this.stopHourlyLoop();
            return;
        }
        if (
            this.initialEntryDone &&
            (this.extraEntryDone || !this.allowExtraEntryAtCeiling) &&
            dayjs().minute() >= 52
        ) {
            // 初始建仓 且 额外买入 且 时间大于52分钟、则提前结束小时循环
            console.log(
                `[扫尾盘策略] 所有预期建仓均已完成(额外买入=${this.allowExtraEntryAtCeiling}), 提前结束小时循环`,
            );
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

    /**
     * 循环执行、获取信号、处理信号
     */
    async tick() {
        this.targetSlug = this.cache.getTargetSlug();
        const signal = await this.processSlug(this.targetSlug);
        if (!signal) {
            return;
        }
        await this.handleSignal(signal);
    }

    /**
     * 分析事件slug、尝试获取信号
     * @param {string} slug
     * @returns {Object} signal
     */
    async processSlug(slug) {
        const market = await this.cache.getMarket();
        if (!market) {
            return null;
        }
        /**
         *  在小时高波动场合、波动后概率往往已经接近95左右、后续会不断收敛到100%、
         *  在收敛过程中、如果趋势不变、流动性会更早的进入枯竭状态、此时可能都没有抵达50分钟
         *  所以、如果在30分到50分之间、发生流动性匮乏、则可以提前进入监控状态
         *  主任务新增30到50分的触发逻辑、修改为 30分开始触发、每5分钟一次、
         *  如果中途发生流动性匮乏、则提前进入监控模式、提高tick频率
         */
        if (this.loopState === 0) {
            // 30~50分钟、流动性充足、待机
            if (dayjs().minute() < 50 && (await this.checkAllLiquiditySufficient(market))) {
                // 流动性充足、继续等待
                return null;
            }
            // 超过50分钟、或者流动性枯竭、转换为监控模式、提高tick频率
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 状态转换: 待机模式 -> 监控模式 (tick间隔: ${this.tickIntervalMs}ms -> 10000ms, 原因: ${dayjs().minute() >= 50 ? "时间超过50分" : "流动性枯竭"})`,
            );
            this.loopState = 1;
            this.tickIntervalMs = 1000 * 10;
        }
        // 构建交易信号
        return await this.buildSignal(slug, market);
    }

    /**
     * 检查双方流动性是否充足
     * @param {*} market
     * @returns
     */
    async checkAllLiquiditySufficient(market) {
        const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);
        const yesOk = await this.cache.checkLiquidity(this.client, yesTokenId);
        const noOk = await this.cache.checkLiquidity(this.client, noTokenId);
        return yesOk && noOk;
    }

    /**
     * 入场信号构建、检查流动性、价格、波动率
     * @param {string} eventSlug
     * @param {*} market
     * @returns {Object} signal
     */
    async buildSignal(eventSlug, market) {
        const secondsToEnd = Math.floor((Date.parse(market.endDate) - Date.now()) / 1000);
        const zVal = await getZ(this.symbol, secondsToEnd);

        const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);

        const [yesPrice, noPrice] = await Promise.all([
            fetchBestAsk(this.client, yesTokenId),
            fetchBestAsk(this.client, noTokenId),
        ]);
        const topPrice = Math.max(yesPrice, noPrice);
        const topTokenId = yesPrice >= noPrice ? yesTokenId : noTokenId;

        /**
         * 逻辑分支优化：
         * 分支A (常规): 时间早 且 流动性充沛 -> 严格校验 Z-Score
         * 分支B (尾部): 时间晚 或 流动性下降 -> 加速扫描，检查 枯竭信号 或 捡漏
         */
        // 剩余时间小于300秒、进入尾部阶段
        const isLateStage = secondsToEnd < 300;
        // 使用默认阈值 (通常是1000) 检查基础流动性 检查卖方流动性是否充足
        const isLiquiditySufficient = await this.cache.checkLiquidity(this.client, topTokenId);

        // 流动性信号标记
        let isLiquiditySignal = false;
        if (!isLateStage && isLiquiditySufficient) {
            // === 常规阶段：时间早且流动性好 ===
            // 严格遵守 Z-Score
            if (zVal < this.zMin) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] Z-Score=${zVal} < ${this.zMin},继续等待`,
                );
                return null;
            }
            // Z-Score好 -> 继续执行 (isLiquiditySignal 保持 false，走正常风控)
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] Z-Score=${zVal} >= ${this.zMin},继续执行`,
            );
        } else {
            // === 尾部/关键性买入阶段 ===
            // 进入关键性买入阶段、加速 tick 频率
            this.tickIntervalMs = Math.max(1000, this.tickIntervalMs / 2);

            if (isLiquiditySufficient) {
                // === 场景：晚期但流动性依然充足 ===
                // 只要 Z-Score 达标就买
                if (zVal < this.zMin) {
                    // 流动性好但统计信号不好 -> 放弃
                    console.log(
                        `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] Z-Score=${zVal} < ${this.zMin},继续等待`,
                    );
                    return null;
                }
                // 流动性好且Z-Score好 -> 继续执行 (isLiquiditySignal 保持 false，走正常风控)
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] Z-Score=${zVal} >= ${this.zMin},继续执行`,
                );
            } else {
                // === 场景：流动性枯竭 (无论早晚) ===
                // 触发尾端流动性追踪信号
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${market.slug}] 触发尾端流动性追踪信号 (Z-Score=${zVal}, endTime=${secondsToEnd}s)`,
                );
                // 触发尾端流动性追踪信号、设置流动性信号标记
                isLiquiditySignal = true;
            }
        }

        const priceThreshold = threshold(secondsToEnd);
        // 检查价格是否在触发价格范围内
        // 统一检查：无论是否流动性信号，价格都不能超出 triggerPriceGt (0.99) 和 priceThreshold 的范围
        if (topPrice > this.triggerPriceGt || topPrice < priceThreshold) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 顶部价格=${topPrice} 超出触发价格范围=[${priceThreshold}, ${this.triggerPriceGt}],继续等待`,
            );
            return null;
        }

        // UpDown事件：波动率检查
        // 常规信号、检查波动率是否大于 ampMin、流动性信号则跳过
        const amp = await get1HourAmp(this.symbol);
        if (!isLiquiditySignal && amp < this.ampMin) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 波动率=${amp.toFixed(4)} 小于最小波动率=${this.ampMin},继续等待`,
            );
            return null;
        }

        const candidate =
            yesPrice >= noPrice
                ? {
                      tokenId: yesTokenId,
                      price: yesPrice,
                      outcome: "UP",
                  }
                : {
                      tokenId: noTokenId,
                      price: noPrice,
                      outcome: "DOWN",
                  };
        console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}]
            选择=${candidate.outcome.toUpperCase()}@${candidate.price.toFixed(3)}
            tokenId=${candidate.tokenId}`);

        // 返回交易信号
        return {
            eventSlug: this.test ? `${eventSlug}-test` : eventSlug,
            marketSlug: market.slug,
            chosen: candidate,
            yesPrice,
            noPrice,
            liquiditySignal: isLiquiditySignal,
            zVal,
            secondsToEnd,
            amp,
        };
    }

    /**
     * 处理交易信号、执行建仓或额外买入
     * @param {Object} signal
     */
    async handleSignal(signal) {
        const marketSlug = signal.marketSlug;

        if (!this.initialEntryDone) {
            // 首次建仓
            await this.openPosition({
                tokenId: signal.chosen.tokenId,
                price: signal.chosen.price,
                sizeUsd: this.positionSizeUsdc,
                signal,
                isExtra: false,
            });
            return;
        }

        // 已建仓、执行额外买入逻辑
        do {
            // 先检查配置开关
            if (!this.allowExtraEntryAtCeiling) {
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 不允许额外买入，结束处理`,
                );
                return;
            }
            // 检查是否已用过额外买入
            if (this.extraEntryDone) {
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 已用过额外买入，结束处理`,
                );
                return;
            }

            // 是否已触发流动性信号
            if (signal.liquiditySignal) {
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 流动性信号已触发，跳过检查`,
                );
                break;
            }

            const price = Number(signal.chosen.price);
            // 再检查是否满足额外时间和流动性条件
            if (
                dayjs().minute() < 55 &&
                price < 0.97 &&
                (await this.cache.checkLiquidity(this.client, signal.chosen.tokenId))
            ) {
                // 未到收敛尾端、当前时间小于55分钟且价格小于0.97且卖方流动性充足，结束处理
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 未到收敛尾端、当前时间小于55分钟且价格小于0.97且卖方流动性充足，结束处理`,
                );
                return;
            }
            // 普通信号、检查价格和amp是否满足条件
            // 价格0.99 则amp大于0.002 则可以入场
            // 价格0.98 则amp大于0.004 则可以入场
            // 价格0.97 则amp大于0.008 则可以入场
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
                    (await this.cache.checkLiquidity(this.client, signal.chosen.tokenId))
                ) {
                    // price >= 0.97 && price < 0.98
                    // 当价格为0.97的场合、入场条件、时间大于57分钟、且波动率大于0.008
                    requiredAmp = 0.008;
                } else {
                    console.log(
                        `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 价格 ${price} 不满足要求,结束处理`,
                    );
                    return;
                }
                const amp = await get1HourAmp(this.symbol);
                if (amp < requiredAmp) {
                    console.log(
                        `[@${dayjs().format(
                            "YYYY-MM-DD HH:mm:ss",
                        )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 价格=${price.toFixed(3)} 波动率=${amp.toFixed(3)} 小于要求波动率=${requiredAmp},结束处理`,
                    );
                    return;
                }
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 价格=${price.toFixed(3)} 波动率=${amp.toFixed(3)} 满足要求波动率=${requiredAmp},继续处理`,
                );
            }
        } while (false);

        const sizeUsd = await this.cache.getBalance(this.client);
        if (sizeUsd <= 5) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 建仓预算不足,结束处理`,
            );
            return;
        }
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入]
            ${signal.chosen.outcome.toUpperCase()}-->price=${signal.chosen.price}@sizeUsd=${sizeUsd}`,
        );
        await this.openPosition({
            tokenId: signal.chosen.tokenId,
            price: signal.chosen.price,
            sizeUsd,
            signal,
            isExtra: true,
        });
    }

    /**
     * 执行建仓
     * @param {Object} param0
     * @param {string} param0.tokenId
     * @param {number} param0.price
     * @param {number} param0.sizeUsd
     * @param {Object} param0.signal
     * @param {boolean} param0.isExtra
     * @returns
     */
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
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${signal.marketSlug}] ✅ 建仓成功,订单号=${orderId}`,
        );

        // 下单成功后、立即本地扣减余额
        this.cache.deductBalance(sizeUsd);

        // 建仓后进入止盈队列、由止盈cron在事件结束后处理
        const takeProfitOrder = {
            tokenId: tokenId,
            size: Number(sizeShares),
            signal,
            entryOrderId: orderId,
            takeProfitOrderId: null, // 止盈订单ID，提交后设置
        };
        // 将止盈订单加入止盈队列
        this.tpManager.addOrder(takeProfitOrder);

        // 更新状态、首次建仓或额外买入完成
        if (isExtra) {
            this.extraEntryDone = true;
        } else {
            this.initialEntryDone = true;
        }

        // 保存建仓订单
        saveOrder({
            eventSlug: signal.eventSlug,
            marketSlug: signal.marketSlug,
            side: "BUY",
            outcome: signal.chosen.outcome.toUpperCase(),
            orderId: orderId,
            price: price,
            size: sizeShares,
            parentOrderId: null,

            tokenId: tokenId,
            zScore: signal.zVal,
            secondsToEnd: signal.secondsToEnd,
            priceChange: signal.amp,
            isLiquiditySignal: signal.liquiditySignal,
        }).catch((err) => console.error("Failed to save entry order to DB", err));
    }
}

export { TailConvergenceStrategy };
