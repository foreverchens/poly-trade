import "dotenv/config";
import dayjs from "dayjs";
import cron from "node-cron";
import {buildClient, nextClient} from "../../core/poly-client-manage.js";
import {threshold, listLimitKlines, get1HourAmp} from "./common.js";
import {TakeProfitManager} from "./take-profit.js";
import {UpBotCache} from "./up-bot-cache.js";
import {saveOrder} from "../../db/repository.js";
import logger from "../../core/Logger.js";
import {loadConvergenceTaskConfigs} from "../../data/convergence-up.config.js";
import {getZ} from "../../core/z-score.js";
import {PolySide} from "../../core/PolyClient.js";
import {checkDirectionStability, checkPricePositionAndTrend, getBias} from "./up-bot-risk.js";
import {submitMakerSignal} from "./up-bot-maker.js";
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
        // 每小时更新下配置
        // 从导入的配置中获取指定任务
        const config = this.flattenConfig(taskConfig);

        this.taskName = config.name;
        this.test = config.test;

        logger.info(
            `[扫尾盘策略] 加载任务配置: 名称=${this.taskName}, 测试模式=${this.test ? "开启" : "关闭"}`,
        );

        this.initializeConfig(config);
        this.initializeRuntimeState();

        this.pkIdx = config.pkIdx;
        this.creds = config.creds;
        this.client = buildClient(this.pkIdx, this.creds);
        logger.info(
            `[扫尾盘策略] 初始化PolyClient实例: #${this.pkIdx}  ${this.client.funderAddress}`,
        );

        // 初始化缓存层 (UpBot专用)
        this.cache = new UpBotCache({
            slug: this.slugTemplate,
            maxMinutesToEnd: this.maxMinutesToEnd,
            maxSizeUsdc: this.extraSizeUsdc + this.positionSizeUsdc,
            cronExpression: "* 0-59 * * * *",
            client: this.client,
            pkIdx: this.pkIdx,
        });

        // 初始化止盈管理器
        this.tpManager = new TakeProfitManager({
            cronTimeZone: this.cronTimeZone,
            client: this.client,
        });

        this.validateCronConfig();
        this.logBootstrapSummary();
    }

    /**
     * 将嵌套配置展平为一级对象（向后兼容现有代码逻辑）
     */
    flattenConfig(taskConfig) {
        const {task, schedule, position, riskControl, extra} = taskConfig;

        // 解析 extra 字段（JSON 字符串）
        let extraConfig = {};
        if (extra && typeof extra === 'string' && extra.trim()) {
            try {
                extraConfig = JSON.parse(extra);
            } catch (error) {
                logger.warn(`[扫尾盘策略] 解析 extra 配置失败: ${error.message}, 使用默认值`);
            }
        }

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

            // 从 extra 字段提取的风险检查参数
            weightedThreshold: extraConfig.weightedThreshold,
            pricePositionThreshold: extraConfig.pricePositionThreshold,
            liquiditySignalWeight: extraConfig.liquiditySignalWeight,
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
         * - weightedThreshold：方向稳定性检查的加权平均价格阈值 (默认 0.75)。
         * - pricePositionThreshold：价格位置检查的阈值 (默认 0.2)。
         * - liquiditySignalWeight：流动性信号的加权值 (默认 0.05)。
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
            weightedThreshold,
            pricePositionThreshold,
            liquiditySignalWeight = 0.05,
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
            weightedThreshold,
            pricePositionThreshold,
            liquiditySignalWeight,
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

        // 本地维护可用USDC余额（用于规避链上/接口余额延迟导致的超额下单）
        this.localUsdcEBalance = null;

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
        // 0 普通模式、1 额外买入已成交、等待信号提交maker单
        this.makerMode = 0;
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
            流动性信号加权值=${this.liquiditySignalWeight},
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
    async startHourlyLoop(source = "cron") {
        if (this.loopActive) {
            return;
        }
        this.loopActive = true;
        this.currentLoopHour = dayjs().hour();
        logger.info(`[扫尾盘策略] 启动小时循环(${source}),当前小时=${this.currentLoopHour}`);
        // 更新taskConfig
        // 检查client是否可用
        if (!this.client) {
            logger.error(`[扫尾盘策略] client不可用、无法更新任务配置、结束小时循环`);
            return;
        }
        await this.updateTaskConfig();
        await this.refreshLocalUsdcEBalance();
        this.runTickLoop();
    }

    async updateTaskConfig() {
        const taskConfigs = await loadConvergenceTaskConfigs({refresh: true});
        const taskConfig = taskConfigs.find((config) => config.task.slug === this.slugTemplate);
        if (!taskConfig) {
            logger.error(`[扫尾盘策略] 未找到任务配置: ${this.slugTemplate}`);
            return;
        }
        const config = this.flattenConfig(taskConfig);
        this.initializeConfig(config);
        logger.info(`[扫尾盘策略] 任务配置更新完毕: ${this.slugTemplate}`);
    }

    async refreshLocalUsdcEBalance() {
        if (!this.client) {
            this.localUsdcEBalance = null;
            return;
        }
        try {
            const usdcEBalance = Number(await this.client.getUsdcEBalance());
            if (!Number.isFinite(usdcEBalance)) {
                throw new Error(`invalid usdc eBalance: ${usdcEBalance}`);
            }
            this.localUsdcEBalance = usdcEBalance;
        } catch (err) {
            logger.error(`[扫尾盘策略] 获取USDC余额失败: ${err?.message ?? err}`);
            this.localUsdcEBalance = null;
        }
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
        // 重置maker模式
        this.makerMode = 0;
        this.localUsdcEBalance = null;
        logger.info(`[扫尾盘策略] 小时循环已结束\n`);
    }

    /**
     * 循环执行、检查是否需要停止循环
     */
    async runTickLoop() {
        if (!this.loopActive) {
            return;
        }
        if (dayjs().hour() !== this.currentLoopHour || dayjs().hour() === 4 || dayjs().hour() === 22) {
            // 美股闭盘时间不做
            this.stopHourlyLoop();
            return;
        }
        // 如果额外买入成功、会设置makerMode为1、此时等待机会提交maker单
        // if (this.initialEntryDone && (this.extraEntryDone || !this.allowExtraEntryAtCeiling)) {
        //     // 初始建仓 且 额外买入、则提前结束小时循环
        //     logger.info(
        //         `[扫尾盘策略] 所有预期建仓均已完成(额外买入=${this.allowExtraEntryAtCeiling}), 提前结束小时循环`,
        //     );
        //     this.stopHourlyLoop();
        //     return;
        // }
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
            // 统一在 handleSignal 执行完毕后输出日志
            if (signal.logArr && signal.logArr.length > 0) {
                if (!signal.completed && this.lastLogTime && dayjs().unix() - this.lastLogTime < 10) {
                    // 10秒内不重复输出日志、如果信号已完成、则不输出日志
                    return;
                }
                this.lastLogTime = dayjs().unix();
                // 输出日志
                logger.info('\n\t' + signal.logArr.join("\n\t"));
            }
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
            // 市场为空、结束小时循环
            logger.error(`[${this.symbol}-${this.currentLoopHour}时] 市场为空、结束小时循环`);
            this.stopHourlyLoop();
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
        // 先默认yes方向为top方向
        // 如果yesAsk大于0.99、或者 yesAsk为0、且yesBid>=0.98 表明高确定事件、以maker单入场
        const isMakerSignal = (bid, ask, outcome, tokenId) => {
            if (ask > 0.99 || (ask === 0 && bid >= 0.95)) {
                // 如果大于0.99、且小于0.998、说明tickSize为0.001、marker价格为 bestBid+0.001、否则为0.99
                return {
                    isMaker: true,
                    price: ask > 0.99 && ask < 0.998 ? bid + 0.001 : 0.99,
                    tokenId: tokenId,
                    outcome: outcome,
                    symbol: this.symbol,
                    currentLoopHour: this.currentLoopHour,
                    client: this.client,
                };
            }
            return null;
        }
        // 先检查maker单信号
        const makerSignal = isMakerSignal(yesBid, yesAsk, "UP", yesTokenId) || isMakerSignal(noBid, noAsk, "DOWN", noTokenId);
        if (this.makerMode || makerSignal) {
            // 如果是maker模式、说明额外买入已成交、此时等待信号提交maker单
            // 如果是maker单、兼容度影响、暂还是通过高频tick处理、直接返回
            // 新修改、如果产生maker单信号、则直接提交maker单、不通过高频tick处理、同时结束小时循环
            if (makerSignal) {
                await submitMakerSignal(makerSignal, this.localUsdcEBalance);
                this.stopHourlyLoop();
            }
            return null;
        }
        // 如果都不是、和0.5比较、高于0.5则yes方向、低于0.5则no方向
        const topPrice = yesAsk >= 0.5 ? yesAsk : noAsk;
        const topTokenId = yesAsk >= 0.5 ? yesTokenId : noTokenId;

        /**
         *  正常情况下、时间超过50分钟、会进入监控模式、提高tick频率
         *  在以下场合时、则提前进入监控模式、提高tick频率
         *  1. 高波动发生、价格不低于最高触发价格、或者zVal不低于高波动阈值、并且插针保护计数器已经超过阈值
         */
        if (this.loopState === 0) {
            // 时间是否低于监控模式分钟阈值
            const isBeforeMonitorThreshold = dayjs().minute() < this.monitorModeMinuteThreshold;
            // 价格是否低于最高触发价格
            const isPriceNotTriggered = topPrice !== 1 && topPrice < this.triggerPriceGt;
            // zVal是否低于高波动阈值
            const isZValBelowHighVolatility = zVal < this.highVolatilityZThreshold;
            // 高波动发生
            const isHighVolatilityOccurred = !isZValBelowHighVolatility || !isPriceNotTriggered;
            // 插针保护计数器是否小于阈值
            const isSpikeProtectionActive = this.highCnt < this.spikeProtectionCount;

            // 指定分钟之前、价格未触发、zVal小于高波动阈值、继续等待
            if (isBeforeMonitorThreshold && isPriceNotTriggered && isZValBelowHighVolatility) {
                // 非高波动场合、价格未触发、继续等待
                if (topPrice > 0.95) {
                    logger.info(
                        `[${this.symbol}-${this.currentLoopHour}时] yesAsk=${yesAsk} noAsk=${noAsk} zVal=${zVal} pending... `,
                    );
                }
                return null;
            }
            // 高波动发生且插针保护计数器小于阈值、则防止插针误触发、检查持续性
            if (isHighVolatilityOccurred && isSpikeProtectionActive) {
                // 防止插针误触发、检查持续性
                logger.info(
                    `[${this.symbol}-${this.currentLoopHour}时] 预防插针、检查持续性、计数器=${this.highCnt} < ${this.spikeProtectionCount}`,
                );
                this.highCnt += 1;
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

        // 日志记录 日志输出
        let logArr = [];
        logArr.push(`[${this.symbol}-${this.currentLoopHour}时]卖方流动性=${asksLiq} 下次tick间隔=${this.tickIntervalMs}ms yesAsk=${yesAsk},noAsk=${noAsk} zVal=${zVal}`);

        // 检查卖方流动性是否充足
        const isLiquiditySufficient = asksLiq >= this.liquiditySufficientThreshold;
        // 流动性信号标记
        let isLiquiditySignal = false;
        if (isLiquiditySufficient) {
            // 流动性充足、校验Z-Score是否达标
            if (zVal < this.zMin) {
                if (topPrice > 0.97 && zVal > this.zMin * 0.8) {
                    logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 常规信号-zVal不达标、asksLiq=${asksLiq}、zVal=${zVal} < ${this.zMin}`);
                    logger.info('\n\t' + logArr.join("\n\t"));
                }
                return null;
            }
            // Z-Score达标、继续执行 (isLiquiditySignal 保持 false，走正常风控)
            logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 常规信号-zVal达标、asksLiq=${asksLiq}、zVal=${zVal} >= ${this.zMin}`);
        } else {
            // 流动性不足、触发流动性信号
            logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 流动性信号触发、Z-Score:${zVal}, 卖方流动性:${asksLiq}, 剩余时间:${secondsToEnd}s 价格:${topPrice} 继续执行`);
            // 触发流动性信号、设置流动性信号标记
            isLiquiditySignal = true;
        }

        // 先检查价格是否在触发价格范围内
        const priceThreshold = threshold(secondsToEnd, 0.1, 0.95, 0.03);
        // 价格不能超出 triggerPriceGt (0.99) 和 priceThreshold 的范围
        if (topPrice > this.triggerPriceGt || topPrice < priceThreshold) {
            if (topPrice > 0.97) {
                logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 入场价格检查失败-topPrice=${topPrice} not in range [${priceThreshold}, ${this.triggerPriceGt}]`);
                logger.info('\n\t' + logArr.join("\n\t"));
            }
            return null;
        }
        logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 入场价格检查通过-topPrice=${topPrice} in range [${priceThreshold}, ${this.triggerPriceGt}]`);

        // UpDown事件：波动率检查
        // 常规信号、检查波动率是否大于 ampMin、流动性信号则跳过
        const amp = await get1HourAmp(this.symbol);
        const eAmpMin = isLiquiditySignal ? this.ampMin / 2 : this.ampMin;
        if (amp < eAmpMin) {
            logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 常规信号-波动率不达标、amp=${amp.toFixed(4)} < ${eAmpMin}`);
            logger.info(logArr.join("\n\t"));
            return null;
        }
        if (isLiquiditySignal && zVal < 1) {
            // 即使流动性信号、zVal小于0.5、也继续等待
            logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 流动性信号-zVal不达标、amp=${amp.toFixed(4)} < ${this.ampMin}、zVal=${zVal} < 1`);
            logger.info(logArr.join("\n\t"));
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

        // 增加风控检查
        // 方向稳定性、价格位置、价格趋势检查
        let avgWeiPrice = await checkDirectionStability({
            client: this.client,
            tokenId: candidate.tokenId,
            secondsToEnd: secondsToEnd,
        });
        logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 方向稳定性检查-avgWeiPrice=${avgWeiPrice}`);
        if (avgWeiPrice === 0) {
            logger.info('\n\t' + logArr.join("\n\t"));
            return null;
        }
        // 基于剩余时间进行非线性加权
        // 最后3分钟（180秒）时加权系数为0.03，最后1分钟（60秒）时加权系数为0.1
        // 60秒之后保持0.1不再增加
        if (secondsToEnd > 0 && secondsToEnd < 180) {
            const minWeight = 0.03;
            const maxWeight = 0.1;
            const x = (180 - secondsToEnd) / 120;
            // 最后60秒时、加权系数为0.1、其他时间、使用平方函数非线性增长
            const timeWeight =
                secondsToEnd <= 60 ? maxWeight : minWeight + x * x * (maxWeight - minWeight);
            avgWeiPrice = avgWeiPrice + timeWeight;
        }
        // 针对流动性信号进行加权（提高通过率）
        if (isLiquiditySignal) {
            avgWeiPrice = avgWeiPrice + this.liquiditySignalWeight;
        }
        if (avgWeiPrice < this.weightedThreshold) {
            logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 方向稳定性检查不通过-avgWeiPrice=${avgWeiPrice} < ${this.weightedThreshold}`);
            logger.info('\n\t' + logArr.join("\n\t"));
            return null;
        }

        const priceCheck = await checkPricePositionAndTrend({
            symbol: this.symbol,
            outcome: candidate.outcome,
            // 暂不做流动性信号的额外加权处理
            pricePositionThreshold: this.pricePositionThreshold,
        });
        logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 价格位置和趋势检查-${priceCheck.reason}`);
        if (!priceCheck.allowed) {
            logger.info('\n\t' + logArr.join("\n\t"));
            return null;
        }

        // 乖离率检查
        const bias = await getBias(this.symbol);
        const biasThreshold = 0.05;
        const isBiasApproved = candidate.outcome === "UP"
            ? bias > biasThreshold  // UP信号要求正乖离率
            : bias < -biasThreshold; // DOWN信号要求负乖离率
        if (bias !== 0 && !isBiasApproved) {
            // logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 乖离率检查不通过-bias=${bias} < ${biasThreshold}`);
            // logger.info('\n\t'+logArr.join("\n\t"));
            // return null;
        }
        logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 乖离率检查通过-bias=${bias} >= ${biasThreshold}`);

        // 判断是否使用了maker价格（价格与ask不同说明是maker单）
        const isMaker =
            candidate.outcome === "UP" ? candidate.price !== yesAsk : candidate.price !== noAsk;
        const orderType = isMaker ? "MAKER" : "TAKER";

        logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 选择=${candidate.outcome.toUpperCase()}@${candidate.price} [${orderType}] ${isLiquiditySignal ? "流动性信号触发" : "常规信号触发"}`);

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
            // 加权平均价格 后续、额外买入时、更高通过门槛、用于风控检查
            avgWeiPrice: avgWeiPrice,
            logArr,
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
            return {allowed: false, reason: "配置不允许额外买入"};
        }

        // 2. 只允许一次额外买入
        if (this.extraEntryDone) {
            return {allowed: false, reason: "已用过额外买入"};
        }

        // 先检查检查流动性和价格、在进行其他复杂检查
        // 只要流动性尚且充沛或者价格未抵达最高触发价格、就不进行额外买入
        const chosenAsksLiq = await this.cache.getAsksLiq(signal.chosen.tokenId);
        if (chosenAsksLiq < 1) {
            return {allowed: false, reason: "卖方流动性为0,结束信号"};
        }
        // 美盘时间 为0.99、其他时间为0.98、美盘时间范围为22:00-05:00
        const isAmericanTime = dayjs().hour() >= 22 || dayjs().hour() <= 5;
        const triggerPriceGt = isAmericanTime ? 0.99 : 0.98;
        if (price < triggerPriceGt || chosenAsksLiq > this.liquiditySufficientThreshold) {
            // 流动性大于阈值、就还能再等等
            return {
                allowed: false,
                reason: `价格${price}<${triggerPriceGt} 或流动性充足(${chosenAsksLiq}>${this.liquiditySufficientThreshold})，等待更佳时机`,
            };
        }

        // 方向稳定性、价格位置、价格趋势检查
        // 风控已前置、暂时注释、后续在进行严格化
        // 额外买入、对加权平均价格要求更高、需要检查加权平均价格是否大于信号的加权平均价格、
        // 默认是0.75、额外买入的话 要求高于阈值的1.1倍
        const weiAvgPriceThreshold = Number((this.weightedThreshold * 1.1).toFixed(4));
        if (signal.avgWeiPrice && signal.avgWeiPrice < weiAvgPriceThreshold) {
            return {
                allowed: false,
                reason: `加权平均价格${signal.avgWeiPrice}小于阈值${weiAvgPriceThreshold}，不进行额外买入`
            };
        }

        // const priceCheck = await checkPricePositionAndTrend({
        //     symbol: this.symbol,
        //     outcome: signal.chosen.outcome,
        //     currentLoopHour: this.currentLoopHour,
        // });
        // if (!priceCheck.allowed) {
        //     return priceCheck;
        // }

        // 3. 流动性信号：直接通过所有检查
        if (signal.liquiditySignal) {
            return {allowed: true, reason: "流动性信号触发,跳过常规风控检查"};
        }

        signal.logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 风控检查通过: 价格${price}>=${triggerPriceGt} 或流动性已经不足(chosenAsksLiq=${chosenAsksLiq} <= ${this.liquiditySufficientThreshold})`);

        return {
            allowed: true,
            reason: `价格>=0.99 或流动性已经不足(chosenAsksLiq=${chosenAsksLiq} <= ${this.liquiditySufficientThreshold})  风控检查通过`,
        };
    }

    /**
     * 处理交易信号、执行建仓或额外买入
     * @param {Object} signal
     */
    async handleSignal(signal) {
        let logArr = signal.logArr;
        // 二次检查价格、如果最新价格 小于信号价格、直接返回
        const [yesBid, yesAsk] = await this.cache.getBestPrice(signal.chosen.tokenId);
        if (yesAsk < signal.chosen.price) {
            // 如果只是短暂波动造成价格小于信号价格、还有二次信号
            // 如果是尾部反转、则可避免风险
            // 如果价格相等、则无影响
            // 如果价格大于信号价格、则可能错过机会、需要修改为最新价格
            logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 最新价格${yesAsk}小于信号价格${signal.chosen.price}，直接返回`);
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

        // todo 基于指标动态买入金额
        // 已建仓、执行额外买入逻辑
        const extraEntryCheck = await this.checkExtraEntry(signal);
        if (!extraEntryCheck.allowed) {
            logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 额外买入:${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price} ${extraEntryCheck.reason}，结束处理`);
            return;
        }

        // 额外买入金额
        const sizeUsd = this.extraSizeUsdc;
        // 执行额外买入
        logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 额外买入 --> ${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price} ${sizeUsd}USDC`);
        // 必须等待额外买入完成、再进行下一轮tick
        await this.openPosition({
            tokenId: signal.chosen.tokenId,
            price: signal.chosen.price,
            sizeUsd,
            signal,
            isExtra: true,
        });
        // 如果额外买入成功、则设置taker为true
        this.makerMode = 1;
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
    async openPosition({tokenId, price, sizeUsd, signal, isExtra}) {
        let logArr = signal.logArr;
        const sizeShares = Math.floor(sizeUsd / price);
        logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 建仓 ->
            方向->${signal.chosen.outcome.toUpperCase()}
            price->${price}
            数量->${sizeShares}
            sizeUsd->${sizeUsd}
            tokenId->${tokenId}`);
        const entryOrder = await this.client
            .placeOrder(price, sizeShares, PolySide.BUY, tokenId)
            .catch((err) => {
                logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 建仓订单失败: ${err?.message ?? err}`);
                return null;
            });
        if (!entryOrder?.success) {
            // 建仓被拒绝:not enough balance / allowance
            const errorMsg =
                typeof entryOrder.error === "string"
                    ? entryOrder.error
                    : entryOrder.error?.message || "";
            if (errorMsg.includes("not enough balance / allowance")) {
                logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 建仓被拒绝: not enough balance / allowance`);
                // 暂停任务
                this.stopHourlyLoop();
                return;
            }
            // 建仓被拒绝:address in closed only mode
            if (errorMsg.includes("address in closed only mode")) {
                logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 建仓被拒绝: address in closed only mode`);
                // 切换到下一个PolyClient实例
                this.client = await nextClient(this.pkIdx, this.client);
                if (!this.client) {
                    logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 切换到下一个PolyClient实例失败，结束任务`);
                    logger.info('\n\t' + logArr.join("\n\t"));
                    this.stopHourlyLoop();
                    return;
                }
                this.pkIdx = this.pkIdx + 1;
                this.tpManager.client = this.client;
                this.cache.client = this.client;
                await this.refreshLocalUsdcEBalance();
                // 切换后重新建仓
                await this.openPosition({tokenId, price, sizeUsd, signal, isExtra});
                return;
            }
            logArr.push(`[${this.symbol}-${this.currentLoopHour}时] 建仓被拒绝:${entryOrder.error}`);
            return null;
        }
        const orderId = entryOrder.orderID;
        logArr.push(`[${this.symbol}-${this.currentLoopHour}时] ✅ 建仓成功,订单号=${orderId}`);
        signal.completed = true;

        if (Number.isFinite(this.localUsdcEBalance)) {
            this.localUsdcEBalance = Math.max(0, this.localUsdcEBalance - sizeShares);
        }

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
            symbol: this.symbol,
            outcome: signal.chosen.outcome.toUpperCase(),
            entryOrderId: orderId,
            entryPrice: price,
            size: sizeShares,

            tokenId: tokenId,
            zScore: signal.zVal,
            secondsToEnd: signal.secondsToEnd,
            priceChange: signal.amp,
            isLiquiditySignal: signal.liquiditySignal,
            avgWeiPrice: signal.avgWeiPrice,
        }).catch((err) => {
            logger.error(`[${this.symbol}-${this.currentLoopHour}时] 建仓订单保存失败: ${err?.message ?? err}`);
        });

    }
}

export {TailConvergenceStrategy};
