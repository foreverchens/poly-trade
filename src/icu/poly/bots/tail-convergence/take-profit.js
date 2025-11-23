import dayjs from "dayjs";
import cron from "node-cron";
import { PolySide } from "../../core/PolyClient.js";

export class TakeProfitManager {
    constructor(client, config, updateOrderCallback) {
        this.client = client;
        this.cronTimeZone = config.cronTimeZone;
        this.takeProfitPrice = config.takeProfitPrice;
        this.updateOrderCallback = updateOrderCallback; // 回调用于更新主策略的 state

        this.takeProfitOrders = [];
        this.takeProfitCronTask = null;
    }

    addOrder(order) {
        this.takeProfitOrders.push(order);
        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")} ${order.signal.marketSlug}] 已加入止盈队列,当前止盈队列长度=${this.takeProfitOrders.length}`,
        );
    }

    /**
     * 启动止盈监控：每小时0-20分钟，每分钟执行一次
     */
    startTakeProfitMonitor() {
        if (this.takeProfitCronTask) {
            console.log(`[扫尾盘策略] 止盈监控已启动，跳过重复启动`);
            return; // 已启动
        }

        // Cron表达式：每小时0-20分钟，每3分钟执行一次 (0-20/3 * * * *)
        const takeProfitCronExpression = "0-20/3 * * * *";
        console.log(
            `[扫尾盘策略] 止盈任务已启动，Cron表达式=${takeProfitCronExpression} (时区: ${this.cronTimeZone})`,
        );

        this.takeProfitCronTask = cron.schedule(
            takeProfitCronExpression,
            async () => {
                try {
                    await this.processTakeProfitOrders();
                } catch (err) {}
            },
            {
                timezone: this.cronTimeZone,
            },
        );
    }

    /**
     * 简化止盈逻辑：事件结束后，直接查询订单成交情况，成交多少止盈多少
     * 使用最优bid价格直接成交，不做其他多余处理
     */
    async processTakeProfitOrders() {
        const pendingOrders = this.takeProfitOrders.filter((order) => !order.takeProfitOrderId);
        const errorOrders = this.takeProfitOrders.filter((order) => order.error);
        if (pendingOrders.length == errorOrders.length) {
            // pendingOrders 永远包含 errorOrders 中的订单 以及一些新提交的订单
            // 如果当前止盈订单队列 都为异常订单，结束调度、此时待处理止盈订单肯定为0
            if (this.takeProfitOrders.length) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] 无待处理止盈订单、结束调度\n`,
                );
                console.log(this.takeProfitOrders);
            }
            this.takeProfitOrders = errorOrders;
            return;
        }
        let processedCount = 0;
        let cancelledCount = 0;
        let takeProfitCount = 0;
        let errorCount = 0;
        let skippedCount = 0;
        for (const takeProfitOrder of pendingOrders) {
            if (takeProfitOrder.error) {
                // 跳过已有错误的订单，避免重复执行
                continue;
            }
            const orderKey = takeProfitOrder.signal.marketSlug;
            try {
                // 查询建仓订单状态
                const order = await this.client.getOrder(takeProfitOrder.entryOrderId);
                if (!order) {
                    console.log(
                        `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 订单不存在(可能已完全成交或取消)，跳过`,
                    );
                    skippedCount++;
                    processedCount++;
                    continue;
                }

                const matchedSize = Number(order.size_matched) || 0;
                const originalSize = Number(order.original_size) || 0;
                const remainingSize = originalSize - matchedSize;

                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 订单状态: 原始数量=${originalSize}, 已成交=${matchedSize}, 剩余=${remainingSize}`,
                );

                if (matchedSize === 0 || matchedSize < originalSize) {
                    // 未成交，或者部分成交 撤单
                    try {
                        await this.client.cancelOrder(takeProfitOrder.entryOrderId);
                        cancelledCount++;
                    } catch (cancelErr) {
                        errorCount++;
                    }
                    processedCount++;
                    continue;
                }

                // 完全成交，执行止盈
                const rlt = await this.executeTakeProfit(takeProfitOrder, matchedSize);
                processedCount++;
                if (!rlt) {
                    skippedCount++;
                    continue;
                }
                takeProfitCount++;
            } catch (err) {
                console.error(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 止盈执行异常`,
                    err?.message ?? err,
                );
                errorCount++;
                processedCount++;
                takeProfitOrder.error = err?.message ?? err;
            }
        }

        console.log(
            `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] 处理完成: 总计=${processedCount}, 已止盈=${takeProfitCount}, 已撤单=${cancelledCount}, 跳过=${skippedCount}, 错误=${errorCount}`,
        );
    }

    /**
     * 执行止盈：使用最优bid价格直接成交
     */
    async executeTakeProfit(takeProfitOrder, size) {
        const orderKey = takeProfitOrder.signal.marketSlug;
        try {
            // 获取最优bid价格
            const [bestBid, bestAsk] = await this.client.getBestPrice(takeProfitOrder.tokenId);
            const bestBidPrice = typeof bestBid === "number" && bestBid > 0 ? bestBid : 0;
            // 先检查价格是否有效
            if (bestBidPrice <= 0) {
                return false;
            }

            // 再检查是否满足止盈价格要求
            if (bestBidPrice < this.takeProfitPrice) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 最优买价=${bestBidPrice} 小于止盈价格=${this.takeProfitPrice}，跳过 @${takeProfitOrder.tokenId}`,
                );
                return false;
            }

            const expectedRevenue = bestBidPrice * size;
            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 准备提交止盈订单: SELL price=${bestBidPrice.toFixed(3)} size=${size} 预期收益=${expectedRevenue.toFixed(2)}`,
            );

            const takeProfitOrderResp = await this.client.placeOrder(
                bestBidPrice,
                size,
                PolySide.SELL,
                takeProfitOrder.tokenId,
            );

            if (!takeProfitOrderResp?.success) {
                console.log(
                    `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 止盈订单被拒绝`,
                    takeProfitOrderResp?.message ?? takeProfitOrderResp.errorMsg,
                );
                throw new Error(`止盈订单被拒绝: ${takeProfitOrderResp?.message ?? takeProfitOrderResp.errorMsg}`);
            }

            const takeProfitOrderId = takeProfitOrderResp.orderID;
            takeProfitOrder.takeProfitOrderId = takeProfitOrderId;

            // 调用回调更新外部状态
            this.updateOrderCallback(
                takeProfitOrder.signal,
                takeProfitOrder.entryOrderId,
                takeProfitOrderId,
            );

            console.log(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} ✅ 止盈订单已成功提交, 订单号=${takeProfitOrderId}`,
            );
            return true;
        } catch (err) {
            console.error(
                `[@${dayjs().format("YYYY-MM-DD HH:mm:ss")}] [止盈] ${orderKey} 止盈执行异常`,
                err?.message ?? err,
            );
            throw new Error(`止盈执行异常: ${err?.message ?? err}`);
        }
    }
}

