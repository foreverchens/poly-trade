
/**
 * 检查指定价格（0.99）的卖方流动性是否枯竭
 *
 * 逻辑：
 * 1. 检查 OrderBook 是否有 Asks。
 * 2. 检查最优卖单（Ask 1）的价格是否严格等于 0.99。
 *    - 如果 Ask 1 < 0.99（如 0.98），说明还没到最后关头，返回 false。
 *    - 如果 Ask 1 > 0.99（理论上不存在，除非是 1.0），返回 false。
 * 3. 如果 Ask 1 是 0.99，计算该价格档位的总流动性。
 * 4. 如果总流动性 < threshold，返回 true（触发买入信号）。
 *
 * @param {Object} client - PolyClient 实例
 * @param {string} tokenId - 目标 Token ID
 * @param {number} threshold - 流动性阈值，默认 1000
 * @returns {Promise<boolean>}
 */
export async function checkLiquidityDepletion(client, tokenId, threshold = 1000) {
    try {
        const orderBook = await client.getOrderBook(tokenId);

        // 如果没有卖单，无法买入，返回 false
        if (!orderBook?.asks?.length) {
            return false;
        }

        // 获取最优卖单（卖一）
        const bestAsk = orderBook.asks[orderBook.asks.length - 1];
        const bestPrice = Number(bestAsk.price);

        // 检查卖一价格是否严格等于 0.99
        // 允许微小误差处理浮点数 (0.99 ± 0.001)
        if (Math.abs(bestPrice - 0.99) > 0.001) {
            // 如果卖一不是 0.99 (e.g. 0.98)，说明还有更便宜的筹码，不触发“0.99枯竭”信号
            return false;
        }

        // 统计 0.99 这一档的流动性是否小于阈值
        return Number(bestAsk.size) < threshold;
    } catch (err) {
        console.error("[LiquidityCheck] Error:", err?.message ?? err);
        return false;
    }
}
