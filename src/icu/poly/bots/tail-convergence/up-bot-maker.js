import { PolySide } from "../../core/PolyClient.js";
import logger from "../../core/Logger.js";
import dayjs from "dayjs";
/**
 * 在以下两种场景发生时、提交0.99的maker单、等待成交
 * 1. 高概率事件、TOP方概率早早抵达0.99、且卖方流动性为0、此时tickSize若为0.01、则提交0.99的maker单、若为0.001、则提交0.991的maker单
 * 2. 末期信号、当事件剩余时间不足10秒时、提交0.99的maker单、等待成交
 */
/**
 * 提交maker单、等待成交
 *  当最优bid 高于marker price 超过0.002、取消挂单
 *  当挂单时间即将抵达次时20分钟、取消挂单
 * @param {Object} signal
 * @param {string} signal.tokenId
 * @param {number} signal.price
 * @param {string} signal.outcome
 * @param {import("../../core/PolyClient.js").PolyClient} signal.client
 * @returns {Promise<void>}
 */
export async function submitMakerSignal(signal) {
    const { tokenId, price, outcome, client, symbol } = signal;

    const size = Math.floor(await client.getUsdcEBalance());
    if (size <= 10) {
        logger.error(`[submitMakerSignal] ${symbol}余额为${size}USDC、不足10USDC、无法提交maker单`);
        return;
    }
    logger.info(
        `[submitMakerSignal] ${symbol}提交maker单、price=${price}、size=${size}、outcome=${outcome}、tokenId=${tokenId.slice(0, 6)}...、`,
    );
    const order = await client.placeOrder(price, size, PolySide.BUY, tokenId).catch((err) => {
        logger.error(`[submitMakerSignal] ${symbol}提交maker单失败、error=${err?.message ?? err}`);
        return null;
    });
    if (!order?.success) {
        logger.error(
            `[submitMakerSignal] ${symbol}提交maker单失败、error=${order?.error?.message ?? order?.error}`,
        );
        return;
    }
    signal.orderId = order.orderID;
    logger.info(`[submitMakerSignal] ${symbol}提交maker单成功、orderId=${signal.orderId}`);
    // 异步处理挂单、等待成交
    handleMakerOrder(signal);
}

async function handleMakerOrder(signal) {
    const { tokenId, price, outcome, client, orderId, currentLoopHour, symbol } = signal;
    while (true) {
        const order = await client.getOrder(orderId);
        // 如果订单不存在、直接结束
        if (!order) {
            logger.info(`[handleMakerOrder] ${symbol}挂单不存在`);
            return;
        }

        const matchedSize = Number(order.size_matched) || 0;
        const originalSize = Number(order.original_size) || 0;
        if (matchedSize === originalSize) {
            logger.info(`[handleMakerOrder] ${symbol}挂单已完全成交、提交止盈`);
            // 异步处理止盈
            signal.matchedSize = Math.floor(matchedSize);
            handleTakeProfit(signal).catch((err) => {
                logger.error(`[handleMakerOrder] ${symbol}提交止盈失败、error=${err?.message ?? err}`);
            });
            break;
        }
        if (matchedSize > 0) {
            logger.info(`[handleMakerOrder] ${symbol}挂单部分成交、${matchedSize}/${originalSize}`);
        }
        // 挂单完全未成交
        // 查询最优bid、如果最优bid高于marker price超过0.002、取消挂单
        const [yesBid] = await client.getBestPrice(tokenId);
        if (yesBid > price + 0.002) {
            logger.info(`[handleMakerOrder] ${symbol}落后最优bid超过0.002、取消挂单`);
            await client.cancelOrder(orderId);
            if(matchedSize > 0) {
                signal.matchedSize = Math.floor(matchedSize);
                handleTakeProfit(signal).catch((err) => {
                    logger.error(`[handleMakerOrder] ${symbol}提交止盈失败、error=${err?.message ?? err}`);
                });
            }
            return;
        }
        // 如果挂单时间即将抵达次时20分钟、取消挂单
        // 获取当前分钟数、如果当前分钟数大于等于20、且小于等于29、则取消挂单
        const currentHour = dayjs().hour();
        const currentMinute = dayjs().minute();
        if (currentHour !== currentLoopHour && currentMinute >= 20) {
            // 如果当前小时不等于挂单小时（跨小时）、且当前分钟数大于等于20、则取消挂单
            logger.info(
                `[handleMakerOrder] ${symbol}当前小时不等于挂单小时、且当前分钟数大于等于20、取消挂单`,
            );
            await client.cancelOrder(orderId);
            return;
        }
        // 挂单未完全成交、继续查询
        logger.info(`[handleMakerOrder] ${symbol}挂单未完全成交、继续查询`);
        await new Promise((resolve) => setTimeout(resolve, 30000));
    }
}

async function handleTakeProfit(signal) {
    const { tokenId, price, outcome, client, orderId, currentLoopHour, symbol, matchedSize } = signal;
    while (true) {
        const [yesBid] = await client.getBestPrice(tokenId);
        if (yesBid < 0.997) {
            logger.info(
                `[handleTakeProfit] ${symbol}最优bid价格低于0.997、等待最优bid价格高于0.997、才提交止盈`,
            );
            await new Promise((resolve) => setTimeout(resolve, 30000));
            continue;
        }
        const takeProfitOrder = await client.placeOrder("0.999", Math.floor(matchedSize), PolySide.SELL, tokenId);
        if (!takeProfitOrder?.success) {
            logger.error(
                `[handleTakeProfit] ${symbol}提交止盈单失败、error=${takeProfitOrder?.error?.message ?? takeProfitOrder.errorMsg}`,
            );
            continue;
        }
        logger.info(
            `[handleTakeProfit] ${symbol}提交止盈单成功、orderId=${takeProfitOrder.orderID}`,
        );
        return;
    }
}
