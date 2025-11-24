import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dayjs from "dayjs";
import cron from "node-cron";
import { PolyClient, PolySide } from "../../core/PolyClient.js";
import { getZ } from "../../core/z-score.js";
import {
    loadStateFile,
    resolveSlugList,
    fetchMarkets,
    fetchBestAsk,
    threshold,
    get1HourAmp,
    checkSellerLiquidity,
    resolvePositionSize,
} from "./common.js";
import { TakeProfitManager } from "./take-profit.js";
import { UpBotCache } from "./up-bot-cache.js";
import { saveOrder } from "../../db/repository.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_STATE_FILE = path.resolve(__dirname, "./data/convergence-up.data.json");

class TailConvergenceStrategy {
    constructor(stateFilePath = DEFAULT_STATE_FILE) {
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
            maxMinutesToEnd: this.maxMinutesToEnd
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
        // this.targetSlug = resolveSlugList(this.slugTemplate); // [删除] 改由 cache 动态获取
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
    initializeRuntimeState() {
        // 内存中的状态位
        this.initialEntryDone = false;
        this.extraEntryDone = false;

        this.loopTimer = null;
        this.loopActive = false;
        this.currentLoopHour = null;

        /**
         * 0 30~50分钟且流动性充足、待机
         * 1 50~60分钟或者流动性枯竭、监控
         */
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
        // this.startTakeProfitMonitor();
        this.tpManager.startTakeProfitMonitor();

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
        // 重置循环状态
        this.loopState = 0;
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
        if(this.initialEntryDone && (this.extraEntryDone || !this.allowExtraEntryAtCeiling) && dayjs().minute() >= 52) {
            // 初始建仓 且 额外买入 且 时间大于52分钟、则提前结束小时循环
            console.log(`[扫尾盘策略] 所有预期建仓均已完成(额外买入=${this.allowExtraEntryAtCeiling}), 提前结束小时循环`);
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
        // this.targetSlug = resolveSlugList(this.slugTemplate); // [删除]
        this.targetSlug = this.cache.getTargetSlug(); // [修改] 使用缓存

        // 获取信号
        const signal = await this.processSlug(this.targetSlug);
        if (!signal) {
            return;
        }
        await this.handleSignal(signal);
    }

    /**
     * 请求单个涨跌事件slug 的市场列表,再逐一检查旗下市场
     * @param {string} slug
     * @returns
     */
    async processSlug(slug) {
        // 获取事件下可用的市场列表、仅先进行结束时间过滤、后续再基于订单簿价格确认
        // false 表示不进行时间过滤
        // const markets = await fetchMarkets(slug, this.maxMinutesToEnd, false); // [删除]

        // [修改] 直接从缓存获取唯一的 Market 对象
        const market = await this.cache.getMarket();

        if (!market) {
            return null;
        }
        /**
         *  在小时高波动场合、波动后概率往往以及接近95左右、后续会不断收敛到1、
         *  在收敛过程中、如果趋势不变、流动性会更早的进入枯竭状态、此时可能都没有过50分
         *  所以、如果在30分到50分之间、发生流动性匮乏、则可以提前买入、
         *  主任务新增30到50分的触发逻辑、修改为 30分开始触发、每5分钟一次、
         *  如果中途发生流动性匮乏、则提前进入高频节奏、进行买入监控
         */
        if(this.loopState === 0) {
            // 30~50分钟、流动性充足、待机
            // const market = markets[0]; // [删除] 不需要了，上方已直接获取 market
            if(dayjs().minute()  < 50 && await this.checkAllLiquiditySufficient(market)) {
                // 流动性充足、待机
                return null;
            }
            // 超过50分钟、或者流动性枯竭、监控买入
            this.loopState = 1;
            this.tickIntervalMs = 1000 * 10;
        }

        try {
            return await this.buildSignal(slug, market);
        } catch (err) {
            console.error(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${slug}] 获取失败`,
                err?.message ?? err,
            );
        }
        return null;
    }

    async checkAllLiquiditySufficient(market) {
        // // 流动性匮乏信号
        const [yesTokenId, noTokenId] = JSON.parse(market.clobTokenIds);
        // const yesOk = await checkSellerLiquidity(this.client, yesTokenId); // [删除]
        // const noOk = await checkSellerLiquidity(this.client, noTokenId);   // [删除]
        const yesOk = await this.cache.checkLiquidity(this.client, yesTokenId); // [修改]
        const noOk = await this.cache.checkLiquidity(this.client, noTokenId);   // [修改]
        return yesOk && noOk;
    }

    // 构建交易信号：限定剩余时间,并找出概率 >= entryTrigger 的方向
    async buildSignal(eventSlug, market) {
        const secondsToEnd = Math.abs(Math.floor((Date.parse(market.endDate) - Date.now()) / 1000));
        const zVal = await getZ(this.symbol, secondsToEnd);

        let isLiquiditySignal = false;
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
        // 55分钟 = 剩余 300秒
        const isLateStage = secondsToEnd < 300;
        // 使用默认阈值 (通常是1000) 检查基础流动性
        // const isLiquiditySufficient = await checkSellerLiquidity(this.client, topTokenId); // [删除]
        const isLiquiditySufficient = await this.cache.checkLiquidity(this.client, topTokenId); // [修改]

        if (!isLateStage && isLiquiditySufficient) {
            // === 常规阶段：时间早且流动性好 ===
            // 严格遵守 Z-Score
            if (zVal < this.zMin) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 流动性好但统计信号不好(Z=${zVal} < ${this.zMin}),不处理`,
                );
                return null;
            }
        } else {
            // === 尾部/低流动性阶段 ===
            // 触发低波动率信号、等待流动性匮乏信号, 加速 tick 频率
            this.tickIntervalMs = Math.max(1000, this.tickIntervalMs / 2);

            if (isLiquiditySufficient) {
                // === 场景：晚期但流动性依然充足 ===
                // 只要 Z-Score 达标就买
                if (zVal < this.zMin) {
                    // 流动性好但统计信号不好 -> 放弃
                    console.log(
                        `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 流动性好但统计信号不好(Z=${zVal} < ${this.zMin}),不处理`,
                    );
                    return null;
                }
                // 流动性好且Z-Score好 -> 继续执行 (isLiquiditySignal 保持 false，走正常风控)
            } else {
                // === 场景：流动性枯竭 (无论早晚) ===
                // 触发尾端流动性追踪信号
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${market.slug}] 触发尾端流动性追踪信号 (Z=${zVal}, Time=${secondsToEnd}s, LiquidityInsufficient)`,
                );
                isLiquiditySignal = true;
            }
        }

        const priceThreshold = threshold(secondsToEnd);
        // 检查价格是否在触发价格范围内
        // 统一检查：无论是否流动性信号，价格都不能超过 triggerPriceGt (0.99)
        if (topPrice > this.triggerPriceGt || topPrice < priceThreshold) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 顶部价格=${topPrice} 不在触发价格范围=[${priceThreshold}, ${this.triggerPriceGt}],不处理`,
            );
            return null;
        }
        // UpDown事件：波动率检查
        // 查询该币对、最近一根小时级别k线、检查波动率是否大于${this.ampMin}
        // const amp = await this.get1HourAmp(); // 改为调用 common
        const amp = await get1HourAmp(this.symbol);
        // 如果是 Liquidity Signal，跳过波动率检查
        if (!isLiquiditySignal && amp < this.ampMin) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 波动率=${amp.toFixed(4)} 小于最小波动率=${this.ampMin},不处理`,
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
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${market.slug}] 选择=${candidate.outcome.toUpperCase()}@${candidate.price.toFixed(3)}`,
        );
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
                isExtra: false,
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
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 不允许额外买入，结束处理`,
                );
                return;
            }
            // 在检查是否已用过额外买入
            if (this.extraEntryDone) {
                return;
            }

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
            // if (dayjs().minute() < 55 && price < 0.97 && (await this.checkSellerLiquidity(signal.chosen.tokenId))) { // 改为调用 common
            if (
                dayjs().minute() < 55 &&
                price < 0.97 &&
                // (await checkSellerLiquidity(this.client, signal.chosen.tokenId)) // [删除]
                (await this.cache.checkLiquidity(this.client, signal.chosen.tokenId)) // [修改]
            ) {
                console.log(
                    `[@${dayjs().format(
                        "YYYY-MM-DD HH:mm:ss",
                    )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 未到收敛尾端、当前时间小于55分钟且价格小于0.97且卖方流动性充足，结束处理`,
                );
                return;
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
                    // this.checkSellerLiquidity(signal.chosen.tokenId)
                    // (await checkSellerLiquidity(this.client, signal.chosen.tokenId)) // [删除]
                    (await this.cache.checkLiquidity(this.client, signal.chosen.tokenId)) // [修改]
                ) {
                    // price >= 0.97 && price < 0.98
                    // 当价格为0.97的场合、入场条件、时间大于57分钟、且波动率大于0.008
                    requiredAmp = 0.008;
                } else {
                   console.log(`[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 价格 ${price.toFixed(3)} 波动率 ${requiredAmp.toFixed(3)} 不满足要求,结束处理`);
                    return;
                }
                // const amp = await this.get1HourAmp();
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

        // const sizeUsd = await resolvePositionSize(this.client); // [删除]
        const sizeUsd = await this.cache.getBalance(this.client); // [修改]
        if(sizeUsd <= 0) {
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] 建仓预算不足,结束处理`,
            );
            return;
        }
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@额外买入] -> ${signal.chosen.outcome.toUpperCase()}  price@${signal.chosen.price.toFixed(3)} 数量@${sizeUsd}`,
        );
        await this.openPosition({
            tokenId: signal.chosen.tokenId,
            price: signal.chosen.price,
            sizeUsd,
            signal,
            isExtra: true,
        });
        console.log(
            `[@${dayjs().format(
                "YYYY-MM-DD HH:mm:ss",
            )} ${marketSlug}-${signal.chosen.outcome.toUpperCase()}@${signal.chosen.price.toFixed(
                3,
            )} ] 已建仓,跳过`,
        );
    }

    // async resolvePositionSize() { ... } // 已移动到 common.js

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

        // this.takeProfitOrders.push(takeProfitOrder); // 改为调用 tpManager
        this.tpManager.addOrder(takeProfitOrder);

        // 已由 tpManager 内部打印日志, 但原逻辑是在这里打印, tpManager.addOrder里也有一行日志
        // 原日志: 已加入止盈队列,当前止盈队列长度=...
        // 保持原逻辑: tpManager.addOrder 里的日志与原逻辑一致即可。

        // 更新状态
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
