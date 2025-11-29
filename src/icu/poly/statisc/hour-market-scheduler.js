import logger from '../core/Logger.js';
import { getPolyClient } from '../core/poly-client-manage.js';
import { resolveSlugList } from '../bots/tail-convergence/common.js';
import {
    initializeHourMarket,
    recordMinuteSample,
    finalizeHourMarket,
} from './hour-market-recorder.js';
import { getHourOverview } from '../db/statistics-repository.js';

// Configuration
const CONFIG = {
    symbol: 'ETH',
    eventSlugTemplate: 'ethereum-up-or-down-november-${day}-${hour}${am_pm}-e',
    checkIntervalMs: 30 * 1000, // Check every 30 seconds
    minuteRecordIntervalMs: 60 * 1000, // Record every minute
};

// State tracking
const trackedMarkets = new Map(); // marketSlug -> { upTokenId, downTokenId, initialized, finalized }

/**
 * Get current active hour markets
 * @returns {Promise<Array>}
 */
async function getActiveHourMarkets() {
    try {
        const eventSlug = resolveSlugList(CONFIG.eventSlugTemplate);
        const client = getPolyClient();
        const event = await client.getEventBySlug(eventSlug);

        if (!event || !event.markets || event.markets.length === 0) {
            return [];
        }

        return event.markets;
    } catch (error) {
        logger.error('[Scheduler] Failed to get active hour markets:', error);
        return [];
    }
}

/**
 * Check and initialize new markets
 */
async function checkAndInitializeMarkets() {
    try {
        const markets = await getActiveHourMarkets();

        for (const market of markets) {
            const marketSlug = market.marketSlug || market.slug;
            const endDate = new Date(market.endDate);
            const now = Date.now();
            const timeToEnd = endDate.getTime() - now;
            const minutesToEnd = timeToEnd / 60000;

            // Initialize if market just opened (within first 2 minutes of the hour)
            if (minutesToEnd > 58 && minutesToEnd < 62 && !trackedMarkets.has(marketSlug)) {
                // Check if already exists in DB
                const existing = await getHourOverview(marketSlug);
                if (!existing) {
                    await initializeHourMarket(market, CONFIG.symbol, resolveSlugList(CONFIG.eventSlugTemplate));
                }

                // Extract token IDs
                const tokens = market.tokens || [];
                const upToken = tokens.find(t => (t.outcome || '').toUpperCase() === 'YES');
                const downToken = tokens.find(t => (t.outcome || '').toUpperCase() === 'NO');

                trackedMarkets.set(marketSlug, {
                    upTokenId: upToken?.tokenId,
                    downTokenId: downToken?.tokenId,
                    initialized: true,
                    finalized: false,
                });

                logger.info(`[Scheduler] Started tracking market ${marketSlug}`);
            }
        }
    } catch (error) {
        logger.error('[Scheduler] Error in checkAndInitializeMarkets:', error);
    }
}

/**
 * Record minute samples for all tracked markets
 */
async function recordMinuteSamplesForTrackedMarkets() {
    try {
        const markets = await getActiveHourMarkets();

        for (const market of markets) {
            const marketSlug = market.marketSlug || market.slug;
            const tracked = trackedMarkets.get(marketSlug);

            if (!tracked || !tracked.initialized || tracked.finalized) {
                continue;
            }

            const endDate = new Date(market.endDate);
            const now = Date.now();
            const timeToEnd = endDate.getTime() - now;

            // Record minute sample if market is still active
            if (timeToEnd > 0 && timeToEnd < 3600000) {
                await recordMinuteSample(
                    marketSlug,
                    CONFIG.symbol,
                    tracked.upTokenId,
                    tracked.downTokenId,
                );
            }
        }
    } catch (error) {
        logger.error('[Scheduler] Error in recordMinuteSamples:', error);
    }
}

/**
 * Finalize markets that have ended
 */
async function checkAndFinalizeMarkets() {
    try {
        for (const [marketSlug, tracked] of trackedMarkets.entries()) {
            if (tracked.finalized) {
                continue;
            }

            const overview = await getHourOverview(marketSlug);
            if (!overview) {
                continue;
            }

            const endTime = new Date(overview.market_end_time.replace(' ', 'T') + '+08:00');
            const now = Date.now();
            const timeToEnd = endTime.getTime() - now;

            // Finalize if market ended (give 2 minutes grace period)
            if (timeToEnd < -120000) {
                await finalizeHourMarket(marketSlug, CONFIG.symbol);
                tracked.finalized = true;
                logger.info(`[Scheduler] Finalized and stopped tracking ${marketSlug}`);
            }
        }

        // Clean up old tracked markets
        const toDelete = [];
        for (const [marketSlug, tracked] of trackedMarkets.entries()) {
            if (tracked.finalized) {
                toDelete.push(marketSlug);
            }
        }
        toDelete.forEach(slug => trackedMarkets.delete(slug));
    } catch (error) {
        logger.error('[Scheduler] Error in checkAndFinalizeMarkets:', error);
    }
}

/**
 * Main scheduler loop
 */
export async function startScheduler() {
    logger.info('[Scheduler] Starting hour market data recorder...');

    // Check for new markets every 30 seconds
    setInterval(async () => {
        await checkAndInitializeMarkets();
        await checkAndFinalizeMarkets();
    }, CONFIG.checkIntervalMs);

    // Record minute samples every minute
    setInterval(async () => {
        await recordMinuteSamplesForTrackedMarkets();
    }, CONFIG.minuteRecordIntervalMs);

    // Initial check
    await checkAndInitializeMarkets();

    logger.info('[Scheduler] Hour market data recorder started successfully');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    startScheduler().catch(error => {
        logger.error('[Scheduler] Fatal error:', error);
        process.exit(1);
    });
}
