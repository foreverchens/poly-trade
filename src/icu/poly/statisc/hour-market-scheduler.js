import logger from '../core/Logger.js';
import { getPolyClient } from '../core/poly-client-manage.js';
import { resolveSlugList } from '../bots/tail-convergence/common.js';
import {
    initializeHourMarket,
    recordMinuteSample,
    finalizeHourMarket,
} from './hour-market-recorder.js';
import { getHourOverview, deleteHourDataBefore } from '../db/statisc-repository.js';
import { loadConvergenceTaskConfigs } from '../data/convergence-up.config.js';

const convergenceTaskConfigs = await loadConvergenceTaskConfigs();

const DEFAULT_SCHEDULE_INTERVAL_MS = 10_000; // 每个任务10秒调度一次
const DEFAULT_SAMPLE_SECOND = 30; // 在30秒附近采样

const UTC8_OFFSET = 8 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function createSchedulerContext(taskConfig) {
    const symbol = taskConfig?.task?.symbol;
    const eventSlugTemplate = taskConfig?.task?.slug;
    const taskName = taskConfig?.task?.name || symbol || 'UNKNOWN';

    if (!symbol || !eventSlugTemplate) {
        throw new Error(`[小时数据调度] 任务 ${taskName} 缺少 symbol 或 slug 配置`);
    }

    const config = {
        name: taskName,
        symbol,
        eventSlugTemplate,
        scheduleIntervalMs: DEFAULT_SCHEDULE_INTERVAL_MS,
        sampleSecond: DEFAULT_SAMPLE_SECOND,
    };

    return {
        config,
        state: {
            currentMarketSlug: null,
            upTokenId: null,
            downTokenId: null,
            initialized: false,
            lastRecordedMinute: -1,
        },
        isScheduling: false,
        lastNoMarketLogTs: 0,
        lastCleanupHourKey: null,
    };
}

function schedulerPrefix(context) {
    return `[小时数据调度][${context.config.symbol}]`;
}

function calcUtc8Components(timestamp) {
    const utc8Date = new Date(timestamp + UTC8_OFFSET);
    const year = utc8Date.getUTCFullYear();
    const month = String(utc8Date.getUTCMonth() + 1).padStart(2, '0');
    const date = String(utc8Date.getUTCDate()).padStart(2, '0');
    const day = Number(`${year}${month}${date}`);
    const hour = utc8Date.getUTCHours();
    const minute = utc8Date.getUTCMinutes();
    const second = utc8Date.getUTCSeconds();
    return { day, hour, minute, second };
}

function getUtc8Clock() {
    return calcUtc8Components(Date.now());
}

function getUtc8DayHourFromTimestamp(timestamp) {
    const { day, hour } = calcUtc8Components(timestamp);
    return { day, hour };
}

async function getCurrentHourMarket(context) {
    try {
        const eventSlug = resolveSlugList(context.config.eventSlugTemplate);
        const client = getPolyClient();
        const event = await client.getEventBySlug(eventSlug);

        if (!event || !event.markets || event.markets.length === 0) {
            return null;
        }

        return event.markets[0];
    } catch (error) {
        logger.error(`${schedulerPrefix(context)} 获取当前小时市场失败:`, error);
        return null;
    }
}

async function tryInitializeMarket(context) {
    const prefix = schedulerPrefix(context);
    try {
        const market = await getCurrentHourMarket(context);
        if (!market) {
            const now = Date.now();
            if (now - context.lastNoMarketLogTs > 60 * 1000) {
                logger.info(`${prefix} 当前没有活跃的小时市场`);
                context.lastNoMarketLogTs = now;
            }
            return;
        }

        const marketSlug = market.marketSlug || market.slug;

        if (context.state.currentMarketSlug === marketSlug && context.state.initialized) {
            return;
        }

        const existing = await getHourOverview(marketSlug);
        if (existing) {
            logger.info(`${prefix} 市场 ${marketSlug} 已初始化，加载到状态`);
        } else {
            await initializeHourMarket(market, context.config.symbol, context.config.eventSlugTemplate);
        }

        const tokens = JSON.parse(market.clobTokenIds) || [];
        const upToken = tokens[0];
        const downToken = tokens[1];

        if (!upToken || !downToken) {
            logger.error(`${prefix} 市场 ${marketSlug} 缺少UP或DOWN token`);
            return;
        }

        context.state.currentMarketSlug = marketSlug;
        context.state.upTokenId = upToken;
        context.state.downTokenId = downToken;
        context.state.initialized = true;
        context.state.lastRecordedMinute = -1;

        logger.info(`${prefix} ✓ 市场 ${marketSlug} 已就绪 (UP: ${upToken.slice(0, 8)}..., DOWN: ${downToken.slice(0, 8)}...)`);
    } catch (error) {
        logger.error(`${prefix} 初始化市场失败:`, error);
    }
}

async function finalizePreviousHourMarket(context) {
    const prefix = schedulerPrefix(context);
    try {
        if (!context.state.currentMarketSlug) {
            logger.info(`${prefix} 没有需要完成的市场`);
            return;
        }

        logger.info(`${prefix} 准备完成上一小时市场 ${context.state.currentMarketSlug} 的数据录入`);

        await finalizeHourMarket(context.state.currentMarketSlug, context.config.symbol);

        context.state.currentMarketSlug = null;
        context.state.upTokenId = null;
        context.state.downTokenId = null;
        context.state.initialized = false;
        context.state.lastRecordedMinute = -1;

        logger.info(`${prefix} ✓ 上一小时市场数据录入已完成，状态已重置`);
    } catch (error) {
        logger.error(`${prefix} 完成上一小时市场失败:`, error);
    }
}

async function cleanupOldHourData(context, currentDay, currentHour) {
    const hourKey = `${currentDay}-${currentHour}`;
    if (context.lastCleanupHourKey === hourKey) {
        return;
    }
    context.lastCleanupHourKey = hourKey;

    try {
        const cutoffTs = Date.now() - TWENTY_FOUR_HOURS_MS;
        const { day: thresholdDay, hour: thresholdHour } = getUtc8DayHourFromTimestamp(cutoffTs);
        const result = await deleteHourDataBefore(thresholdDay, thresholdHour);

        if (result.overviews || result.samples) {
            logger.info(
                `${schedulerPrefix(context)} 清理24小时前数据: 主表 ${result.overviews} 条, 附表 ${result.samples} 条 ` +
                `(阈值 ${thresholdDay} ${String(thresholdHour).padStart(2, '0')}:00)`
            );
        }
    } catch (error) {
        logger.error(`${schedulerPrefix(context)} 清理旧数据失败:`, error);
    }
}

async function recordPreviousMinute(context, minuteIdx) {
    const prefix = schedulerPrefix(context);
    try {
        if (!context.state.initialized || !context.state.currentMarketSlug) {
            logger.warn(`${prefix} 市场未初始化，跳过分钟数据录入`);
            return;
        }

        if (!context.state.upTokenId || !context.state.downTokenId) {
            logger.error(`${prefix} 缺少token ID，无法录入数据`);
            return;
        }

        if (context.state.lastRecordedMinute === minuteIdx) {
            logger.debug(`${prefix} 第 ${minuteIdx} 分钟数据已录入，跳过`);
            return;
        }

        logger.info(`${prefix} 录入第 ${minuteIdx} 分钟数据...`);

        await recordMinuteSample(
            context.state.currentMarketSlug,
            context.config.symbol,
            context.state.upTokenId,
            context.state.downTokenId,
            minuteIdx
        );

        context.state.lastRecordedMinute = minuteIdx;

        logger.info(`${prefix} ✓ 第 ${minuteIdx} 分钟数据已录入`);
    } catch (error) {
        logger.error(`${prefix} 录入第 ${minuteIdx} 分钟数据失败:`, error);
    }
}

async function scheduleTask(context) {
    const prefix = schedulerPrefix(context);
    const { day, hour, minute, second } = getUtc8Clock();
    const inHourWarmupWindow = minute === 0 && second < context.config.sampleSecond;

    if (inHourWarmupWindow) {
        if (context.state.initialized && context.state.currentMarketSlug) {
            logger.info(`${prefix} ${hour.toString().padStart(2, '0')}:00 到来，完成上一小时市场 ${context.state.currentMarketSlug} 的剩余字段录入`);
            await finalizePreviousHourMarket(context);
        }

        await cleanupOldHourData(context, day, hour);

        if (!context.state.initialized) {
            await tryInitializeMarket(context);
        }
        return;
    }

    if (!context.state.initialized) {
        await tryInitializeMarket(context);
        if (!context.state.initialized) {
            return;
        }
    }

    if (second >= context.config.sampleSecond && context.state.lastRecordedMinute !== minute) {
        await recordPreviousMinute(context, minute);
    }
}

async function safeRun(context, runLabel = '') {
    if (context.isScheduling) {
        return;
    }
    context.isScheduling = true;
    try {
        await scheduleTask(context);
    } catch (error) {
        const prefix = schedulerPrefix(context);
        const label = runLabel ? `${prefix} ${runLabel}` : prefix;
        logger.error(`${label} 调度执行失败:`, error);
    } finally {
        context.isScheduling = false;
    }
}

async function startSchedulerForTask(taskConfig) {
    const context = createSchedulerContext(taskConfig);
    const prefix = schedulerPrefix(context);

    logger.info(`${prefix} ==========================================`);
    logger.info(`${prefix} 小时市场数据录入调度器启动 (${context.config.name})`);
    logger.info(`${prefix} 资产符号: ${context.config.symbol}`);
    logger.info(`${prefix} 事件模板: ${context.config.eventSlugTemplate}`);
    logger.info(`${prefix} 调度间隔: 每 ${context.config.scheduleIntervalMs / 1000} 秒`);
    logger.info(`${prefix} 采样秒数: ${context.config.sampleSecond}`);
    logger.info(`${prefix} ==========================================\n`);

    await safeRun(context, '首次');

    setInterval(() => {
        safeRun(context);
    }, context.config.scheduleIntervalMs);

    logger.info(`${prefix} 调度器已启动，等待下一次执行...\n`);
}

export async function startScheduler() {
    const activeTaskConfigs = convergenceTaskConfigs.filter(taskConfig => taskConfig?.task?.active);

    if (!activeTaskConfigs.length) {
        logger.warn('[小时数据调度] 没有激活的任务，调度器不会启动');
        return;
    }

    for (const taskConfig of activeTaskConfigs) {
        try {
            await startSchedulerForTask(taskConfig);
        } catch (error) {
            const taskName = taskConfig?.task?.name || taskConfig?.task?.symbol || 'UNKNOWN';
            logger.error(`[小时数据调度] 启动任务 ${taskName} 失败:`, error);
        }
    }
}

startScheduler().catch(error => {
    logger.error('[小时数据调度] 调度器启动失败:', error);
    process.exit(1);
});
