import dayjs from "dayjs";
import cron from "node-cron";
import { PolySide } from "../../core/PolyClient.js";
import { updateOrderMatchedAndProfit, updateTakeProfit } from "../../db/repository.js";
import logger from "../../core/Logger.js";

export class TakeProfitManager {
    constructor(config) {
        this.cronTimeZone = config.cronTimeZone;
        this.takeProfitPrice = config.takeProfitPrice;
        this.client = config.client;

        this.takeProfitOrders = [];
        this.takeProfitCronTask = null;
        this.takeProfitTimeoutId = null;
    }

    addOrder(order) {
        this.takeProfitOrders.push(order);
        logger.info(
            `[${order.signal.marketSlug}] 已加入止盈队列,当前止盈队列长度=${this.takeProfitOrders.length}`,
        );
    }

    /**
     * 启动止盈监控：每小时0分和1分启动一次，之后改为setTimeout调度（30秒），直到没有待止盈任务
     */
    startTakeProfitMonitor() {
        if (this.takeProfitCronTask) {
            logger.info(`[扫尾盘策略] 止盈监控已启动，跳过重复启动`);
            return; // 已启动
        }

        // Cron表达式：每小时0分和1分执行一次
        const takeProfitCronExpression = "10 0,1 * * * *";
        logger.info(
            `[扫尾盘策略] 止盈任务已启动，Cron表达式=${takeProfitCronExpression} (时区: ${this.cronTimeZone})`,
        );

        this.takeProfitCronTask = cron.schedule(
            takeProfitCronExpression,
            async () => {
                try {
                    // Cron触发后，启动setTimeout循环调度
                    this.startTakeProfitLoop();
                } catch (err) {
                    logger.error(`[扫尾盘策略] Cron触发异常`, err?.message ?? err);
                }
            },
            {
                timezone: this.cronTimeZone,
            },
        );
    }

    /**
     * 启动setTimeout循环调度：每30秒执行一次，直到没有待止盈任务
     */
    startTakeProfitLoop() {
        // 如果已有循环在运行，直接返回
        if (this.takeProfitTimeoutId) {
            return;
        }

        const scheduleNext = async () => {
            try {
                const hasPendingOrders = await this.processTakeProfitOrders();

                if (hasPendingOrders) {
                    // 还有待处理订单，30秒后继续
                    this.takeProfitTimeoutId = setTimeout(scheduleNext, 30000);
                } else {
                    // 没有待处理订单，停止调度
                    this.takeProfitTimeoutId = null;
                }
            } catch (err) {
                logger.error(`[扫尾盘策略] 止盈循环调度异常`, err?.message ?? err);
                // 即使出错也继续调度，避免遗漏
                this.takeProfitTimeoutId = setTimeout(scheduleNext, 30000);
            }
        };

        // 立即执行一次
        scheduleNext();
    }

    /**
     * 简化止盈逻辑：事件结束后，直接查询订单成交情况，成交多少止盈多少
     * 使用最优bid价格直接成交，不做其他多余处理
     * @returns {Promise<boolean>} 返回是否有待处理的订单
     */
    async processTakeProfitOrders() {
        const pendingOrders = this.takeProfitOrders.filter((order) => !order.takeProfitOrderId);
        const errorOrders = this.takeProfitOrders.filter((order) => order.error);
        if (pendingOrders.length == errorOrders.length) {
            // pendingOrders 永远包含 errorOrders 中的订单 以及一些新提交的订单
            // 如果当前止盈订单队列 都为异常订单，结束调度、此时待处理止盈订单肯定为0
            this.takeProfitOrders = errorOrders;
            return false; // 没有待处理订单
        }
        let processedCount = 0;
        let cancelledCount = 0;
        let takeProfitCount = 0;
        let errorCount = 0;
        let skippedCount = 0;
        //  合并止盈不可行、基础建仓和额外建仓买入参数可能不一致、无法合并
        for (const takeProfitOrder of pendingOrders) {
            if (takeProfitOrder.error) {
                // 跳过已有错误的订单，避免重复执行
                continue;
            }
            const orderKey = takeProfitOrder.orderKey;
            try {
                // 查询建仓订单状态
                const order = await this.client.getOrder(takeProfitOrder.entryOrderId);
                if (!order) {
                    logger.info(
                        `[止盈] ${orderKey} 订单不存在(可能已完全成交或取消)，跳过`,
                    );
                    skippedCount++;
                    processedCount++;
                    continue;
                }

                const matchedSize = Number(order.size_matched) || 0;
                const originalSize = Number(order.original_size) || 0;

                logger.info(
                    `[止盈] ${orderKey} 成交情况: ${order.outcome.toUpperCase()}@${matchedSize}/${originalSize}`,
                );

                if (matchedSize === 0 || matchedSize < originalSize) {
                    // 未成交，或者部分成交 撤单
                    const [yesBid] = await this.client.getBestPrice(takeProfitOrder.tokenId);
                    logger.info(
                        `[止盈] ${orderKey} 当前最优买价=${yesBid}、当前挂单价格=${order.price}`,
                    );
                    if(yesBid <= order.price) {
                        logger.info(
                            `[止盈] ${orderKey} 当前最优买价=${yesBid} 小于等于当前挂单价格=${order.price}、跳过撤单`,
                        );
                        continue;
                    }
                    try {
                        await this.client.cancelOrder(takeProfitOrder.entryOrderId);
                        cancelledCount++;
                    } catch (cancelErr) {
                        errorCount++;
                    }
                    // 更新建仓订单的matched字段（建仓订单的profit保持为0）
                    // 如果matchedSize小于1，未成交、视为订单已取消、修改status为cancelled
                    try {
                        const status = matchedSize < 1 ? 'cancelled' : undefined;
                        await updateOrderMatchedAndProfit(
                            takeProfitOrder.entryOrderId,
                            matchedSize, // 实际撮合数量
                            0, // 建仓订单的profit保持为0
                            status // 如果matchedSize小于1，更新status为cancelled
                        );
                        logger.info(
                            `[止盈] ${orderKey} 已更新建仓订单matched: ${matchedSize}/${originalSize}${status ? `, 状态已更新为${status}` : ''}`,
                        );
                    } catch (updateErr) {
                        logger.error(
                            `[止盈] ${orderKey} 更新建仓订单matched失败`,
                            updateErr?.message ?? updateErr,
                        );
                    }
                    processedCount++;
                    if(matchedSize < 1) {
                        // 事件结束、未成交、视为错误
                        takeProfitOrder.error = "未成交";
                        continue;
                    }
                    // 部分成交、继续处理
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
                logger.error(
                    `[止盈] ${orderKey} 止盈执行异常`,
                    err?.message ?? err,
                );
                errorCount++;
                processedCount++;
                takeProfitOrder.error = err?.message ?? err;
            }
        }

        // logger.info(
        //     `[止盈] 处理完成: 总计=${processedCount}, 已止盈=${takeProfitCount}, 已撤单=${cancelledCount}, 跳过=${skippedCount}, 错误=${errorCount}`,
        // );

        // 检查是否还有待处理的订单（排除已有错误的订单）
        const remainingPendingOrders = this.takeProfitOrders.filter(
            (order) => !order.takeProfitOrderId && !order.error
        );
        return remainingPendingOrders.length > 0;
    }

    /**
     * 执行止盈：使用最优bid价格直接成交
     */
    async executeTakeProfit(takeProfitOrder, size) {
        const orderKey = takeProfitOrder.orderKey;
        try {
            // 获取最优bid价格
            const [bestBid, bestAsk] = await this.client.getBestPrice(takeProfitOrder.tokenId);
            const bestBidPrice = typeof bestBid === "number" && bestBid > 0 ? bestBid : 0;
            // 先检查价格是否有效
            if (bestBidPrice <= 0) {
                logger.info(
                    `[止盈] ${orderKey} \t======== GG =======\t`,
                );
                return false;
            }

            // 再检查是否满足止盈价格要求
            if (bestBidPrice < this.takeProfitPrice) {
                logger.info(`[止盈] ${orderKey} 最优买价=${bestBidPrice} 小于止盈价格=${this.takeProfitPrice}、跳过`);
                return false;
            }

            logger.info(
                `[止盈] ${orderKey} 提交止盈: --> ${bestBidPrice}@${size}`,
            );

            const takeProfitOrderResp = await this.client.placeOrder(
                bestBidPrice,
                size,
                PolySide.SELL,
                takeProfitOrder.tokenId,
            ).catch(err=>{
                logger.error("place order failed", err)
                return null;
            });

            if (!takeProfitOrderResp?.success) {
                logger.info(
                    `[止盈] ${orderKey} 止盈订单被拒绝`,
                    takeProfitOrderResp?.message ?? takeProfitOrderResp.errorMsg,
                );
                return false;
            }

            const takeProfitOrderId = takeProfitOrderResp.orderID;
            takeProfitOrder.takeProfitOrderId = takeProfitOrderId;

            // 计算利润 = (止盈价格 - 入场价格) * 实际撮合数量
            // 入场价格从signal中获取，不需要查表
            const entryPrice = takeProfitOrder.signal.chosen.price;
            const profit = (bestBidPrice - entryPrice) * size;

            // 更新建仓订单的止盈信息（合并到同一条记录）
            await updateTakeProfit(
                takeProfitOrder.entryOrderId,
                takeProfitOrderId,
                bestBidPrice,
                profit
            ).catch(err => logger.error("Failed to update take profit to DB", err));

            logger.info(
                `[止盈] ${orderKey} ✅ 止盈订单已成功提交, 订单号=${takeProfitOrderId}`,
            );
            return true;
        } catch (err) {
            logger.error(
                `[止盈] ${orderKey} 止盈执行异常`,
                err?.message ?? err,
            );
            throw new Error(`止盈执行异常: ${err?.message ?? err}`);
        }
    }
}

