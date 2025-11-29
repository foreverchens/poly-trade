import logger from '../core/Logger.js';
import { getPolyClient } from '../core/poly-client-manage.js';
import { resolveSlugList } from '../bots/tail-convergence/common.js';
import {
    initializeHourMarket,
    recordMinuteSample,
    finalizeHourMarket,
} from './hour-market-recorder.js';
import { getHourOverview, deleteHourDataBefore } from '../db/statisc-repository.js';

// 配置
const CONFIG = {
    symbol: 'ETH',
    eventSlugTemplate: 'ethereum-up-or-down-november-${day}-${hour}${am_pm}-et',
    scheduleIntervalMs: 1000, // 每秒调度一次，便于精确到 :30
    sampleSecond: 30, // 每分钟第30秒采样
};

const UTC8_OFFSET = 8 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// 状态追踪
const state = {
    currentMarketSlug: null,      // 当前小时市场的slug
    upTokenId: null,               // UP token ID
    downTokenId: null,             // DOWN token ID
    initialized: false,            // 是否已初始化
    lastRecordedMinute: -1,        // 上次录入的分钟数
};

let isScheduling = false;
let lastNoMarketLogTs = 0;
let lastCleanupHourKey = null;

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

/**
 * 获取当前活跃的小时市场
 * @returns {Promise<Object|null>}
 */
async function getCurrentHourMarket() {
    try {
        const eventSlug = resolveSlugList(CONFIG.eventSlugTemplate);
        const client = getPolyClient();
        const event = await client.getEventBySlug(eventSlug);

        if (!event || !event.markets || event.markets.length === 0) {
            return null;
        }

        // 通常事件只有一个市场
        return event.markets[0];
    } catch (error) {
        logger.error('[小时数据调度] 获取当前小时市场失败:', error);
        return null;
    }
}

/**
 * 尝试初始化当前小时市场
 */
async function tryInitializeMarket() {
    try {
        const market = await getCurrentHourMarket();
        if (!market) {
            const now = Date.now();
            if (now - lastNoMarketLogTs > 60 * 1000) {
                logger.info('[小时数据调度] 当前没有活跃的小时市场');
                lastNoMarketLogTs = now;
            }
            return;
        }

        const marketSlug = market.marketSlug || market.slug;

        // 如果已经在追踪这个市场，不重复初始化
        if (state.currentMarketSlug === marketSlug && state.initialized) {
            return;
        }

        // 检查数据库是否已存在
        const existing = await getHourOverview(marketSlug);
        if (existing) {
            logger.info(`[小时数据调度] 市场 ${marketSlug} 已初始化，加载到状态`);
        } else {
            // 初始化新市场
            await initializeHourMarket(market, CONFIG.symbol, CONFIG.eventSlugTemplate);
        }

        // 提取token IDs
        const tokens = JSON.parse(market.clobTokenIds) || [];
        const upToken =tokens[0];
        const downToken = tokens[1];

        if (!upToken || !downToken) {
            logger.error(`[小时数据调度] 市场 ${marketSlug} 缺少UP或DOWN token`);
            return;
        }

        // 更新状态
        state.currentMarketSlug = marketSlug;
        state.upTokenId = upToken;
        state.downTokenId = downToken;
        state.initialized = true;
        state.lastRecordedMinute = -1; // 重置录入记录

        logger.info(`[小时数据调度] ✓ 市场 ${marketSlug} 已就绪 (UP: ${upToken.slice(0, 8)}..., DOWN: ${downToken.slice(0, 8)}...)`);
    } catch (error) {
        logger.error('[小时数据调度] 初始化市场失败:', error);
    }
}

/**
 * 完成上一小时市场的数据录入
 */
async function finalizePreviousHourMarket() {
    try {
        if (!state.currentMarketSlug) {
            logger.info('[小时数据调度] 没有需要完成的市场');
            return;
        }

        logger.info(`[小时数据调度] 准备完成上一小时市场 ${state.currentMarketSlug} 的数据录入`);

        await finalizeHourMarket(state.currentMarketSlug, CONFIG.symbol);

        // 重置状态，准备下一个小时
        state.currentMarketSlug = null;
        state.upTokenId = null;
        state.downTokenId = null;
        state.initialized = false;
        state.lastRecordedMinute = -1;

        logger.info('[小时数据调度] ✓ 上一小时市场数据录入已完成，状态已重置');
    } catch (error) {
        logger.error('[小时数据调度] 完成上一小时市场失败:', error);
    }
}

async function cleanupOldHourData(currentDay, currentHour) {
    const hourKey = `${currentDay}-${currentHour}`;
    if (lastCleanupHourKey === hourKey) {
        return;
    }
    lastCleanupHourKey = hourKey;

    try {
        const cutoffTs = Date.now() - TWENTY_FOUR_HOURS_MS;
        const { day: thresholdDay, hour: thresholdHour } = getUtc8DayHourFromTimestamp(cutoffTs);
        const result = await deleteHourDataBefore(thresholdDay, thresholdHour);

        if (result.overviews || result.samples) {
            logger.info(
                `[小时数据调度] 清理24小时前数据: 主表 ${result.overviews} 条, 附表 ${result.samples} 条` +
                ` (阈值 ${thresholdDay} ${String(thresholdHour).padStart(2, '0')}:00)`
            );
        }
    } catch (error) {
        logger.error('[小时数据调度] 清理旧数据失败:', error);
    }
}

/**
 * 按分钟索引录入市场数据（在该分钟的第30秒触发）
 * @param {number} minuteIdx - 要录入的分钟索引 (0-59)
 */
async function recordPreviousMinute(minuteIdx) {
    try {
        if (!state.initialized || !state.currentMarketSlug) {
            logger.warn('[小时数据调度] 市场未初始化，跳过分钟数据录入');
            return;
        }

        if (!state.upTokenId || !state.downTokenId) {
            logger.error('[小时数据调度] 缺少token ID，无法录入数据');
            return;
        }

        // 避免重复录入
        if (state.lastRecordedMinute === minuteIdx) {
            logger.debug(`[小时数据调度] 第 ${minuteIdx} 分钟数据已录入，跳过`);
            return;
        }

        logger.info(`[小时数据调度] 录入第 ${minuteIdx} 分钟数据...`);

        await recordMinuteSample(
            state.currentMarketSlug,
            CONFIG.symbol,
            state.upTokenId,
            state.downTokenId,
            minuteIdx
        );

        state.lastRecordedMinute = minuteIdx;

        logger.info(`[小时数据调度] ✓ 第 ${minuteIdx} 分钟数据已录入`);
    } catch (error) {
        logger.error(`[小时数据调度] 录入第 ${minuteIdx} 分钟数据失败:`, error);
    }
}

/**
 * 主调度逻辑 - 每秒执行一次
 */
async function scheduleTask() {
    const { day, hour, minute, second } = getUtc8Clock();
    const inHourWarmupWindow = minute === 0 && second < CONFIG.sampleSecond;

    if (inHourWarmupWindow) {
        // 新的小时刚开始，先补齐上一小时主表
        if (state.initialized && state.currentMarketSlug) {
            logger.info(`[小时数据调度] ${hour.toString().padStart(2, '0')}:00 到来，完成上一小时市场 ${state.currentMarketSlug} 的剩余字段录入`);
            await finalizePreviousHourMarket();
        }

        await cleanupOldHourData(day, hour);

        // 然后尝试初始化新的小时市场（可能需要多次尝试直至市场出现）
        if (!state.initialized) {
            await tryInitializeMarket();
        }
        return;
    }

    // 非整点窗口，如果市场尚未就绪则持续尝试
    if (!state.initialized) {
        await tryInitializeMarket();
        if (!state.initialized) {
            return;
        }
    }

    // 在每分钟第sampleSecond秒生成当分钟的数据，如 10:05:30 生成 minuteIdx=5
    if (second >= CONFIG.sampleSecond && state.lastRecordedMinute !== minute) {
        await recordPreviousMinute(minute);
    }
}

/**
 * 启动调度器
 */
export async function startScheduler() {
    logger.info('[小时数据调度] ==========================================');
    logger.info('[小时数据调度] 小时市场数据录入调度器启动');
    logger.info('[小时数据调度] 资产符号: ' + CONFIG.symbol);
    logger.info('[小时数据调度] 事件模板: ' + CONFIG.eventSlugTemplate);
    logger.info('[小时数据调度] 调度间隔: 每秒');
    logger.info('[小时数据调度] ==========================================\n');

    async function safeRun(context = '') {
        if (isScheduling) {
            return;
        }
        isScheduling = true;
        try {
            await scheduleTask();
        } catch (error) {
            const prefix = context ? `[小时数据调度] ${context}` : '[小时数据调度]';
            logger.error(`${prefix} 调度执行失败:`, error);
        } finally {
            isScheduling = false;
        }
    }

    // 立即执行一次
    await safeRun('首次');

    // 每秒执行一次
    setInterval(() => {
        safeRun();
    }, CONFIG.scheduleIntervalMs);

    logger.info('[小时数据调度] 调度器已启动，等待下一次执行...\n');
}

// 如果直接执行此文件，启动调度器
startScheduler().catch(error => {
    logger.error('[小时数据调度] 调度器启动失败:', error);
    process.exit(1);
});
