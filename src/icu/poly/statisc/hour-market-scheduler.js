import logger from '../core/Logger.js';
import { getPolyClient } from '../core/poly-client-manage.js';
import { resolveSlugList } from '../bots/tail-convergence/common.js';
import {
    initializeHourMarket,
    recordMinuteSample,
    finalizeHourMarket,
    getCurrentMinute,
} from './hour-market-recorder.js';
import { getHourOverview } from '../db/statisc-repository.js';

// 配置
const CONFIG = {
    symbol: 'ETH',
    eventSlugTemplate: 'ethereum-up-or-down-november-${day}-${hour}${am_pm}-et',
    scheduleIntervalMs: 60 * 1000, // 每分钟调度一次
};

// 状态追踪
const state = {
    currentMarketSlug: null,      // 当前小时市场的slug
    upTokenId: null,               // UP token ID
    downTokenId: null,             // DOWN token ID
    initialized: false,            // 是否已初始化
    lastRecordedMinute: -1,        // 上次录入的分钟数
};

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
            logger.info('[小时数据调度] 当前没有活跃的小时市场');
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

/**
 * 录入上一分钟的市场数据
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
 * 主调度逻辑 - 每分钟执行一次
 */
async function scheduleTask() {
    const currentMinute = getCurrentMinute();
    logger.info(`[小时数据调度] ======== 当前UTC+8分钟数: ${currentMinute} ========`);

    if (currentMinute === 0) {
        // 整点时刻：
        // 1. 先录入上一小时的第59分钟数据（如果有追踪的市场）
        if (state.initialized && state.currentMarketSlug) {
            logger.info('[小时数据调度] 整点：录入上一小时第59分钟数据');
            await recordPreviousMinute(59);
        }

        // 2. 完成上一小时市场的数据录入
        logger.info('[小时数据调度] 整点：完成上一小时市场数据录入');
        await finalizePreviousHourMarket();

        // 3. 初始化新的小时市场
        logger.info('[小时数据调度] 整点：初始化新的小时市场');
        await tryInitializeMarket();
    } else {
        // 非整点时刻：
        // 1. 尝试初始化市场（如果还未初始化）
        if (!state.initialized) {
            logger.info('[小时数据调度] 市场未初始化，尝试初始化...');
            await tryInitializeMarket();
        }

        // 2. 录入上一分钟的数据
        // 例如：当前是 10:03，录入 10:02 的数据（minute_idx = 2）
        const previousMinute = currentMinute - 1;
        if (previousMinute >= 0) {
            await recordPreviousMinute(previousMinute);
        }
    }

    logger.info('[小时数据调度] ======== 本次调度完成 ========\n');
}

/**
 * 启动调度器
 */
export async function startScheduler() {
    logger.info('[小时数据调度] ==========================================');
    logger.info('[小时数据调度] 小时市场数据录入调度器启动');
    logger.info('[小时数据调度] 资产符号: ' + CONFIG.symbol);
    logger.info('[小时数据调度] 事件模板: ' + CONFIG.eventSlugTemplate);
    logger.info('[小时数据调度] 调度间隔: 每分钟');
    logger.info('[小时数据调度] ==========================================\n');

    // 立即执行一次
    await scheduleTask().catch(error => {
        logger.error('[小时数据调度] 首次调度执行失败:', error);
    });

    // 每分钟执行一次
    setInterval(async () => {
        await scheduleTask().catch(error => {
            logger.error('[小时数据调度] 调度执行失败:', error);
        });
    }, CONFIG.scheduleIntervalMs);

    logger.info('[小时数据调度] 调度器已启动，等待下一次执行...\n');
}

// 如果直接执行此文件，启动调度器
startScheduler().catch(error => {
    logger.error('[小时数据调度] 调度器启动失败:', error);
    process.exit(1);
});
