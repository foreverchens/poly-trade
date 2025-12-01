import "dotenv/config";
import dayjs from "dayjs";
import cron from "node-cron";
import { PolySide } from "../../core/PolyClient.js";
import { buildClient, nextClient } from "../../core/poly-client-manage.js";
import { getZ } from "../../core/z-score.js";
import { fetchBestPrice, threshold, get1HourAmp } from "./common.js";
import { TakeProfitManager } from "./take-profit.js";
import { UpBotCache } from "./up-bot-cache.js";
import { saveOrder } from "../../db/repository.js";
import logger from "../../core/Logger.js";

// 基于流动性计算下次tick 时间间隔
const delay = (liq, t = 100) => {
    const m = liq / t;
    return m <= 2
        ? 1000
        : m >= 10
          ? 10000
          : 1000 + (9000 * Math.log(1 + 4 * ((m - 2) / 8))) / Math.log(5);
};

class TailConvergenceStrategy {
    constructor(taskConfig) {
        // 从导入的配置中获取指定任务
        const config = this.flattenConfig(taskConfig);

        this.taskName = config.name;
        this.test = config.test;

        logger.info(
            `[扫尾盘策略] 加载任务配置: 名称=${this.taskName}, 测试模式=${this.test ? "开启" : "关闭"}`,
        );

        this.initializeConfig(config);
        this.initializeRuntimeState();

        // 初始化缓存层 (UpBot专用)
        this.cache = new UpBotCache({
            slug: this.slugTemplate,
            maxMinutesToEnd: this.maxMinutesToEnd,
            maxSizeUsdc: this.extraSizeUsdc + this.positionSizeUsdc,
            cronExpression: "* 30-59 * * * *",
        });

        // 初始化止盈管理器
        this.tpManager = new TakeProfitManager({
            cronTimeZone: this.cronTimeZone,
            takeProfitPrice: this.takeProfitPrice,
        });

        this.pkIdx = config.pkIdx;
        this.creds = config.creds;
        this.client = buildClient(this.pkIdx,this.creds);

        this.validateCronConfig();
        this.logBootstrapSummary();
    }

    /**
     * 将嵌套配置展平为一级对象（向后兼容现有代码逻辑）
     */
    flattenConfig(taskConfig) {
        const { task, schedule, position, riskControl } = taskConfig;

        return {
            // 任务基础
            name: task.name,
            slug: task.slug,
            symbol: task.symbol,
            pkIdx: task.pkIdx,
            creds: task.creds,
            test: task.test,

            // 调度配置
            cronExpression: schedule.cronExpression,
            cronTimeZone: schedule.cronTimeZone,
            tickIntervalSeconds: schedule.tickIntervalSeconds,

            // 建仓配置
            positionSizeUsdc: position.positionSizeUsdc,
            extraSizeUsdc: position.extraSizeUsdc,
            allowExtraEntryAtCeiling: position.allowExtraEntryAtCeiling,

            // 风控配置
            triggerPriceGt: riskControl.price.triggerPriceGt,
            takeProfitPrice: riskControl.price.takeProfitPrice,
            maxMinutesToEnd: riskControl.time.maxMinutesToEnd,
            monitorModeMinuteThreshold: riskControl.time.monitorModeMinuteThreshold,
            zMin: riskControl.statistics.zMin,
            ampMin: riskControl.statistics.ampMin,
            highVolatilityZThreshold: riskControl.statistics.highVolatilityZThreshold,
            liquiditySufficientThreshold: riskControl.liquidity.sufficientThreshold,
            spikeProtectionCount: riskControl.spikeProtection.count,
        };
    }

    /**
     * 初始化策略配置
     */
    initializeConfig(config) {
        /**
         * config 字段说明：
         * - positionSizeUsdc：单次建仓的美元金额。
         * - extraSizeUsdc：额外买入时的最大余额上限 (默认 100 USDC)。
         * - maxMinutesToEnd：离市场截止的剩余分钟数阈值,过期市场会被过滤。
         * - takeProfitPrice：止盈挂单价格。
         * - ampMin：最近 1 小时振幅下限,波动太小忽略。
         * - tickIntervalSeconds：主循环 tick 间隔秒数。
         * - cronExpression / cronTimeZone：调度 cron 表达式及时区。
         * - slug：日内跟踪的事件 slug 模板,可包含 ${day} 占位符 (单值)。
         * - triggerPriceGt：触发信号的最高价格(超过该价格不建仓)。
         * - monitorModeMinuteThreshold：进入监控模式的分钟阈值 (默认 50)。
         * - highVolatilityZThreshold：判断高波动的 Z-Score 阈值 (默认 3)。
         * - spikeProtectionCount：防止插针的持续性检查计数器阈值 (默认 2)。
         * - liquiditySufficientThreshold：流动性充足的阈值 (默认 2000)。
         */
        const {
            positionSizeUsdc,
            extraSizeUsdc = 100,
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
            symbol = "ETH",
            monitorModeMinuteThreshold = 50,
            highVolatilityZThreshold = 3,
            spikeProtectionCount = 2,
            liquiditySufficientThreshold = 2000,
        } = config;

        Object.assign(this, {
            positionSizeUsdc,
            extraSizeUsdc,
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
            monitorModeMinuteThreshold,
            highVolatilityZThreshold,
            spikeProtectionCount,
            liquiditySufficientThreshold,
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
        // 预防插针、检查持续性
        this.highCnt = 1;
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
        logger.info(
            `[扫尾盘策略-UpDown]
            建仓金额=${this.positionSizeUsdc}USDC
            额外买入最大余额=${this.extraSizeUsdc}USDC
            动态触发价格阈值范围=[${earlyThreshold}(剩余10分) --> ${lateThreshold}(即将结束)] (基于剩余秒数)
            静态最高建仓价格=${this.triggerPriceGt}
            最大剩余时间=${this.maxMinutesToEnd}分钟,
            最小振幅=${this.ampMin},
            最小Z-Score=${this.zMin},
            最小止盈价格=${this.takeProfitPrice},
            监控模式分钟阈值=${this.monitorModeMinuteThreshold},
            高波动Z-Score阈值=${this.highVolatilityZThreshold},
            插针防护计数阈值=${this.spikeProtectionCount},
            流动性充足阈值=${this.liquiditySufficientThreshold},
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
        logger.info(`[扫尾盘策略] 主任务已启动,等待调度触发...`);

        // 启动止盈监控（每小时0-20分钟执行）
        this.tpManager.startTakeProfitMonitor();

        // 测试模式下立即启动循环
        if (this.test) {
            logger.info(`[扫尾盘策略] 测试模式：立即启动tick循环`);
            this.startHourlyLoop("test");
        }
    }

    /**
     * 循环调度启动、运行时状态初始化、开始tick循环
     * @param {string} source 启动来源 cron/test
     */
    startHourlyLoop(source = "cron") {
        if (this.loopActive) {
            return;
        }
        this.loopActive = true;
        this.currentLoopHour = dayjs().hour();
        logger.info(`[扫尾盘策略] 启动小时循环(${source}),当前小时=${this.currentLoopHour}`);
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
        // 重置预防插针、检查持续性
        this.highCnt = 1;
        logger.info(`[扫尾盘策略] 小时循环已结束\n`);
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
        if (this.initialEntryDone && (this.extraEntryDone || !this.allowExtraEntryAtCeiling)) {
            // 初始建仓 且 额外买入、则提前结束小时循环
            logger.info(
                `[扫尾盘策略] 所有预期建仓均已完成(额外买入=${this.allowExtraEntryAtCeiling}), 提前结束小时循环`,
            );
            this.stopHourlyLoop();
            return;
        }
        try {
            await this.tick();
        } catch (err) {
            logger.error("[扫尾盘策略] tick执行失败", err);
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

        // 如果信号存在、则处理信号
        if (signal) {
            await this.handleSignal(signal);
        }
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
        // 构建交易信号
        return await this.buildSignal(slug, market);
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

        const [yesBid, yesAsk] = await this.cache.getBestPrice(yesTokenId);
        const [noBid, noAsk] = await this.cache.getBestPrice(noTokenId);
        if (yesAsk === 0 || noAsk === 0) {
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] yesAsk=${yesAsk} noAsk=${noAsk} 卖方流动性为0, 结束信号`,
            );
            return null;
        }
        const topPrice = Math.max(yesAsk, noAsk);
        const topTokenId = yesAsk >= noAsk ? yesTokenId : noTokenId;

        /**
         *  正常情况下、时间超过50分钟、会进入监控模式、提高tick频率
         *  在以下场合时、则提前进入监控模式、提高tick频率
         *  1. 高波动发生、价格不低于最高触发价格、或者zVal不低于高波动阈值、并且插针保护计数器已经超过阈值
         */
        if (this.loopState === 0) {
            // 时间是否低于监控模式分钟阈值
            const isBeforeMonitorThreshold = dayjs().minute() < this.monitorModeMinuteThreshold;
            // 价格是否低于最高触发价格
            const isPriceNotTriggered = topPrice != 1 && topPrice < this.triggerPriceGt;
            // zVal是否低于高波动阈值
            const isZValBelowHighVolatility = zVal < this.highVolatilityZThreshold;
            // 高波动发生
            const isHighVolatilityOccurred = !isZValBelowHighVolatility || !isPriceNotTriggered;
            // 插针保护计数器是否小于阈值
            const isSpikeProtectionActive = this.highCnt < this.spikeProtectionCount;

            // 指定分钟之前、价格未触发、zVal小于高波动阈值、继续等待
            if (isBeforeMonitorThreshold && isPriceNotTriggered && isZValBelowHighVolatility) {
                // 非高波动场合、价格未触发、继续等待
                if (topPrice > 0.9) {
                    logger.info(
                        `[${this.symbol}-${this.currentLoopHour}时] yesAsk=${yesAsk} noAsk=${noAsk} zVal=${zVal} pending... `,
                    );
                }
                return null;
            }
            // 高波动发生且插针保护计数器小于阈值、则防止插针误触发、检查持续性
            if (isHighVolatilityOccurred && isSpikeProtectionActive) {
                // 防止插针误触发、检查持续性
                this.highCnt += 1;
                logger.info(
                    `[${this.symbol}-${this.currentLoopHour}时] 预防插针、检查持续性、计数器=${this.highCnt}`,
                );
                return null;
            }
            // 超过指定分钟、或者高波动发生、且持续超过插针保护计数器阈值、价格触发、转换为监控模式、提高tick频率
            const transitionReason = !isBeforeMonitorThreshold
                ? `时间超过${this.monitorModeMinuteThreshold}分`
                : "高波动发生";
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 状态转换: 待机模式 -> 监控模式 (tick间隔: ${this.tickIntervalMs}ms -> 10000ms, 原因: ${transitionReason})`,
            );
            this.loopState = 1;
            this.tickIntervalMs = 1000 * 10;
        }

        /**
         * 逻辑分支优化：
         * 分支A (常规): 非尾部行情、且流动性充足、校验Z-Score、满足即为常规信号
         * 分支B (尾部): 尾部行情、流动性下降 -> 加速扫描、校验流动性是否充足、不足则触发流动性信号
         */
        // 使用默认阈值 (通常是1000) 检查基础流动性 检查卖方流动性是否充足
        const asksLiq = await this.cache.getAsksLiq(topTokenId);
        if (asksLiq < 1) {
            logger.error(`[${this.symbol}-${this.currentLoopHour}时] 卖方流动性为0,结束信号`);
            return null;
        }
        // 基于卖方流动性更新下次tick 时间间隔
        this.tickIntervalMs = delay(asksLiq, this.liquiditySufficientThreshold);

        // 检查卖方流动性是否充足
        const isLiquiditySufficient = asksLiq >= this.liquiditySufficientThreshold;
        // 流动性信号标记
        let isLiquiditySignal = false;
        if (isLiquiditySufficient) {
            // 流动性充足、校验Z-Score是否达标
            if (zVal < this.zMin) {
                if (topPrice > 0.9) {
                    logger.info(
                        `[${this.symbol}-${this.currentLoopHour}时] 常规信号、asksLiq:${asksLiq}、Z-Score:${zVal} < ${this.zMin}, 继续等待`,
                    );
                }
                return null;
            }
            // Z-Score达标、继续执行 (isLiquiditySignal 保持 false，走正常风控)
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 常规信号、asksLiq:${asksLiq}、Z-Score:${zVal} >= ${this.zMin}, 继续执行`,
            );
        } else {
            // 流动性不足、触发流动性信号
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 流动性信号触发、Z-Score:${zVal}, 卖方流动性:${asksLiq}, 剩余时间:${secondsToEnd}s 继续执行`,
            );
            // 触发流动性信号、设置流动性信号标记
            isLiquiditySignal = true;
        }

        // 先检查价格是否在触发价格范围内
        const priceThreshold = threshold(secondsToEnd);
        // 价格不能超出 triggerPriceGt (0.99) 和 priceThreshold 的范围
        if (topPrice > this.triggerPriceGt || topPrice < priceThreshold) {
            if (topPrice > 0.9) {
                logger.info(
                    `[${this.symbol}-${this.currentLoopHour}时] topPrice:[${topPrice}] not in range [${priceThreshold}, ${this.triggerPriceGt}]  continue waiting`,
                );
            }
            return null;
        }

        // UpDown事件：波动率检查
        // 常规信号、检查波动率是否大于 ampMin、流动性信号则跳过
        const amp = await get1HourAmp(this.symbol);
        if (!isLiquiditySignal && amp < this.ampMin) {
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 常规信号、波动率:${amp.toFixed(4)} < ${this.ampMin}, 继续等待`,
            );
            return null;
        }
        if (isLiquiditySignal && zVal < 0.5) {
            // 即使流动性信号、zVal小于0.5、也继续等待
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 流动性信号、zVal:${zVal} < 0.5, 继续等待`,
            );
            return null;
        }

        // 如果top方向的askPrice - bidPrice > 0.02、则设置挂单价格为 top方向的askPrice+bidPrice/2、向上取整、保留2位小数
        // 但如果剩余时间不足300秒（5分之后）、则不做maker单、直接用ask价格 且不是流动性信号
        const canUseMaker = secondsToEnd >= 300;
        const candidate =
            yesAsk >= noAsk
                ? {
                      tokenId: yesTokenId,
                      price:
                          canUseMaker && yesAsk - yesBid > 0.02 && !isLiquiditySignal
                              ? Math.ceil(((yesAsk + yesBid) / 2) * 100) / 100 // 价差较大且时间充裕、尝试做maker单
                              : yesAsk, // 价差较小或时间紧迫、直接taker单
                      outcome: "UP",
                  }
                : {
                      tokenId: noTokenId,
                      price:
                          canUseMaker && noAsk - noBid > 0.02 && !isLiquiditySignal
                              ? Math.ceil(((noAsk + noBid) / 2) * 100) / 100 // 价差较大且时间充裕、尝试做maker单
                              : noAsk, // 价差较小或时间紧迫、直接taker单
                      outcome: "DOWN",
                  };

        // 判断是否使用了maker价格（价格与ask不同说明是maker单）
        const isMaker =
            candidate.outcome === "UP" ? candidate.price !== yesAsk : candidate.price !== noAsk;
        const orderType = isMaker ? "MAKER" : "TAKER";

        logger.info(
            `[${this.symbol}-${this.currentLoopHour}时] 选择=${candidate.outcome.toUpperCase()}@${candidate.price} [${orderType}] ${isLiquiditySignal ? "流动性信号触发" : "常规信号触发"}`,
        );

        // 返回交易信号
        return {
            orderKey: `${this.symbol}-${this.currentLoopHour}时`,
            eventSlug: this.test ? `${eventSlug}-test` : eventSlug,
            marketSlug: market.slug,
            chosen: candidate,
            yesAsk,
            noAsk,
            liquiditySignal: isLiquiditySignal,
            zVal,
            secondsToEnd,
            amp,
        };
    }

    /**
     * 额外买入风控逻辑
     * @param {Object} signal - 交易信号
     * @returns {Promise<{allowed: boolean, reason: string}>}
     */
    async checkExtraEntry(signal) {
        const price = Number(signal.chosen.price);

        // 1. 配置开关检查
        if (!this.allowExtraEntryAtCeiling) {
            return { allowed: false, reason: "配置不允许额外买入" };
        }

        // 2. 只允许一次额外买入
        if (this.extraEntryDone) {
            return { allowed: false, reason: "已用过额外买入" };
        }

        // 3. 流动性信号：直接通过所有检查
        if (signal.liquiditySignal) {
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 流动性信号触发，跳过常规风控检查`,
            );
            return { allowed: true, reason: "流动性信号触发" };
        }

        // 4. 简化风控：只允许价格>=0.99时额外买入
        // 理由：价格到0.99本身就是强烈的收敛信号，不需要额外的时间和波动率检查
        // 若流动性尚且充足、等待匮乏机会
        const chosenAsksLiq = await this.cache.getAsksLiq(signal.chosen.tokenId);
        if (chosenAsksLiq < 1) {
            logger.error(`[${this.symbol}-${this.currentLoopHour}时] 卖方流动性为0,结束信号`);
            return { allowed: false, reason: "卖方流动性为0,结束信号" };
        }
        if (price < this.triggerPriceGt || chosenAsksLiq >= this.liquiditySufficientThreshold) {
            // price < 0.99
            // 流动性大于阈值、就还能再等等
            return {
                allowed: false,
                reason: `价格${price}<0.99 或流动性充足(${chosenAsksLiq}>=${this.liquiditySufficientThreshold})，等待更佳时机`,
            };
        }

        logger.info(
            `[${this.symbol}-${this.currentLoopHour}时] 风控检查通过: 价格${price}>=0.99 或流动性已经不足(chosenAsksLiq=${chosenAsksLiq} < ${this.liquiditySufficientThreshold})`,
        );

        return {
            allowed: true,
            reason: `价格>=0.99 或流动性已经不足(chosenAsksLiq=${chosenAsksLiq} < ${this.liquiditySufficientThreshold})  风控通过`,
        };
    }

    /**
     * 处理交易信号、执行建仓或额外买入
     * @param {Object} signal
     */
    async handleSignal(signal) {
        // 二次检查价格、如果最新价格 小于信号价格、直接返回
        const [yesBid, yesAsk] = await this.cache.getBestPrice(signal.chosen.tokenId);
        if (yesAsk < signal.chosen.price) {
            // 如果只是短暂波动造成价格小于信号价格、还有二次信号
            // 如果是尾部反转、则可避免风险
            // 如果价格相等、则无影响
            // 如果价格大于信号价格、则可能错过机会、需要修改为最新价格
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 最新价格${yesAsk}小于信号价格${signal.chosen.price}，直接返回`,
            );
            return;
        }
        signal.chosen.price = yesAsk;

        // 首次建仓
        if (!this.initialEntryDone) {
            await this.openPosition({
                tokenId: signal.chosen.tokenId,
                price: signal.chosen.price,
                sizeUsd: this.positionSizeUsdc,
                signal,
                isExtra: false,
            });
            // 如果初始建仓成功、继续进行额外买入逻辑
        }
        // 如果额外买入已经完成、则结束处理
        if (this.extraEntryDone) {
            return;
        }

        // 已建仓、执行额外买入逻辑
        const extraEntryCheck = await this.checkExtraEntry(signal);
        if (!extraEntryCheck.allowed) {
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 额外买入:${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price} ${extraEntryCheck.reason}，结束处理`,
            );
            return;
        }

        // 额外买入金额
        const sizeUsd = this.extraSizeUsdc;
        // 执行额外买入
        logger.info(
            `[${this.symbol}-${this.currentLoopHour}时] 额外买入 --> ${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price} ${sizeUsd}USDC`,
        );
        // 必须等待额外买入完成、再进行下一轮tick
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
        logger.info(
            `[${this.symbol}-${this.currentLoopHour}时] 建仓 ->
                方向->${signal.chosen.outcome.toUpperCase()}
                price->${price}
                数量->${sizeShares}
                sizeUsd->${sizeUsd}
                tokenId->${tokenId}`,
        );
        const entryOrder = await this.client
            .placeOrder(price, sizeShares, PolySide.BUY, tokenId)
            .catch((err) => {
                logger.error(
                    `[${this.symbol}-${this.currentLoopHour}时] 建仓订单失败`,
                    err?.message ?? err,
                );
                return null;
            });
        if (!entryOrder?.success) {
            logger.info(
                `[${this.symbol}-${this.currentLoopHour}时] 建仓被拒绝:${entryOrder.error}`,
            );
            const errorMsg =
                typeof entryOrder.error === "string"
                    ? entryOrder.error
                    : entryOrder.error?.message || "";
            if (errorMsg.includes("address in closed only mode")) {
                logger.error(
                    `[${this.symbol}-${this.currentLoopHour}时] 建仓被拒绝: address in closed only mode`,
                );
                // 切换到下一个PolyClient实例
                this.client = await nextClient(this.pkIdx,this.client);
                if(!this.client){
                    logger.error(`[${this.symbol}-${this.currentLoopHour}时] 切换到下一个PolyClient实例失败，结束进程`);
                    process.exit(1);
                }
                this.pkIdx = this.pkIdx + 1;
                // 切换后重新建仓
                await this.openPosition({ tokenId, price, sizeUsd, signal, isExtra });
            }
            return null;
        }
        const orderId = entryOrder.orderID;
        logger.info(`[${this.symbol}-${this.currentLoopHour}时] ✅ 建仓成功,订单号=${orderId}`);

        // 建仓后进入止盈队列、由止盈cron在事件结束后处理
        const takeProfitOrder = {
            orderKey: signal.orderKey,
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
        }).catch((err) => logger.error("Failed to save entry order to DB", err));
    }
}

export { TailConvergenceStrategy };
