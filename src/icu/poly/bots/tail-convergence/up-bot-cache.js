import dayjs from "dayjs";
import { resolveSlugList, fetchMarkets, checkSellerLiquidity, resolvePositionSize } from "./common.js";

export class UpBotCache {
    constructor(config) {
        this.slugTemplate = config.slug;
        this.maxMinutesToEnd = config.maxMinutesToEnd;

        // 运行时数据存储
        this.store = {
            hour: null,
            targetSlug: null,
            market: null,         // 明确只缓存单个 market 对象
            balance: { val: 0, ts: 0 },
            liquidity: new Map(), // tokenId -> { val: boolean, ts: number }
        };

        // TTL 配置 (毫秒)
        this.TTL = {
            BALANCE: 10_000,      // 余额缓存 10秒
            LIQUIDITY: 5_000      // 流动性缓存 5秒
        };
    }

    /**
     * 检查小时轮转,如果跨小时则重置长效缓存
     */
    _rotate() {
        const currentHour = dayjs().hour();
        if (this.store.hour !== currentHour) {
            console.log(`[UpBotCache] 小时轮转 ${this.store.hour} -> ${currentHour}, 重置缓存`);
            this.store.hour = currentHour;
            this.store.targetSlug = null;
            this.store.market = null;
            this.store.liquidity.clear();
        }
    }

    /**
     * 获取当前 Slug (每小时解析一次)
     */
    getTargetSlug() {
        this._rotate();
        if (!this.store.targetSlug) {
            this.store.targetSlug = resolveSlugList(this.slugTemplate);
            console.log(`[UpBotCache] 重新解析TargetSlug: ${this.store.targetSlug}`);
        }
        // Slug 变化不频繁，不需要每次命中都打印，仅在解析时打印
        return this.store.targetSlug;
    }

    /**
     * 获取单一市场信息 (每小时请求一次)
     * UpBot 场景下一个 Slug 只对应一个 Market
     */
    async getMarket() {
        this._rotate();
        if (!this.store.market) {
            const slug = this.getTargetSlug();
            // false 代表不进行时间过滤(由Bot自行控制)
            const markets = await fetchMarkets(slug, this.maxMinutesToEnd, false);

            if (markets && markets.length > 0) {
                this.store.market = markets[0];
                console.log(`[UpBotCache] 市场已缓存更新: ${this.store.market.slug} (Slug=${slug})`);
            } else {
                console.log(`[UpBotCache] 未找到市场, 缓存为空: ${slug}`);
                return null;
            }
        }
        // 市场对象较大，仅在首次获取时打印，后续不打印命中日志，以免刷屏
        return this.store.market;
    }

    /**
     * 获取余额 (带TTL)
     */
    async getBalance(client) {
        const now = Date.now();
        // 命中缓存
        if (now - this.store.balance.ts <= this.TTL.BALANCE) {
            console.log(`[UpBotCache] 余额使用缓存: ${this.store.balance.val} USDC`);
            return this.store.balance.val;
        }

        // 缓存过期或不存在，重新获取
        console.log(`[UpBotCache] 余额缓存过期，重新请求...`);
        const val = await resolvePositionSize(client);
        this.store.balance = { val, ts: now };
        console.log(`[UpBotCache] 余额更新完毕: ${val} USDC`);
        return this.store.balance.val;
    }

    /**
     * 检查流动性 (带TTL)
     */
    async checkLiquidity(client, tokenId) {
        const now = Date.now();
        const cached = this.store.liquidity.get(tokenId);

        // 如果缓存存在且未过期
        if (cached && (now - cached.ts < this.TTL.LIQUIDITY)) {
            console.log(`[UpBotCache] 流动性[${tokenId}] 使用缓存: ${cached.val}`);
            return cached.val;
        }

        // 缓存过期或不存在
        console.log(`[UpBotCache] 流动性[${tokenId}] 缓存过期/不存在，重新检查...`);
        const val = await checkSellerLiquidity(client, tokenId);
        this.store.liquidity.set(tokenId, { val, ts: now });
        console.log(`[UpBotCache] 流动性[${tokenId}] 更新完毕: ${val}`);
        return val;
    }

    /**
     * 获取数据快照 (供Web端展示用)
     */
    getSnapshot() {
        return {
            ts: dayjs().format("HH:mm:ss"),
            hour: this.store.hour,
            slug: this.store.targetSlug,
            market: this.store.market?.slug ?? "None",
            balance: this.store.balance.val,
            liquidityCacheSize: this.store.liquidity.size
        };
    }
}
