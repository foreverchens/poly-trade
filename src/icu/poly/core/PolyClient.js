import "dotenv/config";
import pkg from "@polymarket/clob-client";
import {SignatureType} from "@polymarket/order-utils";
import {Wallet} from "@ethersproject/wallet";
import axios from "axios";

const {ClobClient, OrderType, Side, AssetType} = pkg;

const DEFAULT_HOST = "https://clob.polymarket.com";
const DEFAULT_CHAIN_ID = 137;
const DEFAULT_TOKEN_ID = "87769991026114894163580777793845523168226980076553814689875238288185044414090";

const DEFAULT_ORDER_TYPE = OrderType.GTC;
const DEFAULT_SIGNATURE_TYPE = SignatureType.EOA;
const DEFAULT_REWARDS_HOST = "https://polymarket.com/api";
const DEFAULT_DATA_HOST = "https://data-api.polymarket.com";
const DEFAULT_MARKET_HOST = "https://gamma-api.polymarket.com";

export class PolyClient {
    constructor({
                    host = DEFAULT_HOST,
                    chainId = DEFAULT_CHAIN_ID,
                    tokenId = DEFAULT_TOKEN_ID,
                    privateKey = process.env.PRIVATE_KEY,
                    signatureType = DEFAULT_SIGNATURE_TYPE,
                    funderAddress,
                    orderType = DEFAULT_ORDER_TYPE,
                    rewardsHost = DEFAULT_REWARDS_HOST,
                    dataHost = DEFAULT_DATA_HOST,
                    marketHost = DEFAULT_MARKET_HOST,
                } = {}) {
        if (!privateKey) {
            throw new Error("Missing PRIVATE_KEY for PolyClient");
        }

        this.host = host;
        this.chainId = chainId;
        this.tokenId = tokenId;
        this.signatureType = signatureType;
        this.orderType = orderType;
        this.rewardsHost = rewardsHost;
        this.dataHost = dataHost;
        this.marketHost = marketHost;
        this.signer = new Wallet(privateKey);
        this.funderAddress = funderAddress?.trim() || this.signer.address;
        this.clientPromise = null;
    }

    async getClient() {
        if (!this.clientPromise) {
            this.clientPromise = (async () => {
                const baseClient = new ClobClient(this.host, this.chainId, this.signer);
                const creds = await baseClient.deriveApiKey();
                return new ClobClient(this.host, this.chainId, this.signer, creds, this.signatureType, this.funderAddress,);
            })();
        }
        return this.clientPromise;
    }


    /*================市场API===================*/

    /**
     * 获取盘口最优挂单价格
     * @param side
     * @param tokenId
     * @returns {Promise<*>}
     */
    async getPrice(side, tokenId = this.tokenId) {
        if (!side) {
            throw new Error("side is required to fetch price");
        }

        const client = await this.getClient();
        return (await client.getPrice(tokenId, side)).price;
    }

    /**
     * {
     *   market: '0xcb111226a8271fed0c71bb5ec1bd67b2a4fd72f1eb08466e2180b9efa99d3f32',
     *   asset_id: '87769991026114894163580777793845523168226980076553814689875238288185044414090',
     *   timestamp: '1762410814537',
     *   hash: '8b1e40b2abe4f2ebeead7274a154378fd017776e',
     *   bids: [
     *     { price: '0.62', size: '103009' },
     *     { price: '0.63', size: '59690.95' },
     *     { price: '0.64', size: '53862.45' }
     *   ],
     *   asks: [
     *     { price: '0.67', size: '131578.44' },
     *     { price: '0.66', size: '76207.09' },
     *     { price: '0.65', size: '88731.56' }
     *   ],
     *   min_order_size: '5',
     *   tick_size: '0.01',
     *   neg_risk: true
     * }
     * @param tokenId
     * @returns {Promise<*|OrderBookSummary>}
     */
    async getOrderBook(tokenId = this.tokenId) {
        const client = await this.getClient();
        return client.getOrderBook(tokenId);
    }

    /**
     * https://polymarket.com/api/rewards/markets?orderBy=rate_per_day&position=DESC&query=&showFavorites=false&tagSlug=all&makerAddress=0x8d544db9152b95cd0c34595183cd54bc0dc37edc&authenticationType=eoa&nextCursor=MA%3D%3D&requestPath=%2Frewards%2Fuser%2Fmarkets&onlyMergeable=false&noCompetition=false&onlyOpenOrders=false&onlyPositions=false
     * @returns {Promise<void>|{
     *   market_id: '570361',
     *   condition_id: '0xcb111226a8271fed0c71bb5ec1bd67b2a4fd72f1eb08466e2180b9efa99d3f32',
     *   question: 'Fed decreases interest rates by 25 bps after December 2025 meeting?',
     *   market_slug: 'fed-decreases-interest-rates-by-25-bps-after-december-2025-meeting',
     *   volume_24hr: 649406.9018239997,
     *   event_id: '35090',
     *   event_slug: 'fed-decision-in-december',
     *   image: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/jerome+powell+glasses1.png',
     *   maker_address: '0x0000000000000000000000000000000000000000',
     *   tokens: [
     *     {
     *       token_id: '87769991026114894163580777793845523168226980076553814689875238288185044414090',
     *       outcome: 'Yes',
     *       price: 0.645
     *     },
     *     {
     *       token_id: '13411284055273560855537595688801764123705139415061660246624128667183605973730',
     *       outcome: 'No',
     *       price: 0.355
     *     }
     *   ],
     *   rewards_config: [
     *     {
     *       asset_address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
     *       start_date: '2025-08-01',
     *       end_date: '2500-12-31',
     *       rate_per_day: 600,
     *       total_rewards: 0
     *     }
     *   ],
     *   earnings: [
     *     {
     *       asset_address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
     *       earnings: 0,
     *       asset_rate: 0.999726
     *     }
     *   ],
     *   rewards_max_spread: 3.5,
     *   rewards_min_size: 200,
     *   earning_percentage: 0,
     *   spread: 0.01,
     *   market_competitiveness: 101.826847
     * }}
     */
    async listRewardMarket({
                               orderBy = "rate_per_day",
                               position = "DESC",
                               limit = 100,
                               query = "",
                               showFavorites = false,
                               tagSlug = "all",
                               makerAddress = "",
                               authenticationType = "eoa",
                               nextCursor = "MA==",
                               requestPath = "/rewards/user/markets",
                               onlyMergeable = false,
                               noCompetition = false,
                               onlyOpenOrders = false,
                               onlyPositions = false,
                           } = {}) {
        const url = `${this.rewardsHost}/rewards/markets`;
        const response = await axios.get(url, {
            params: {
                orderBy,
                position,
                query,
                showFavorites,
                tagSlug,
                makerAddress,
                authenticationType,
                nextCursor,
                requestPath,
                onlyMergeable,
                noCompetition,
                onlyOpenOrders,
                onlyPositions,
            },
        });
        let data = response.data;
        data = data.data.filter(ele => {
            return ele.market_competitiveness > 0;
        }).slice(0, limit).sort((e1, e2) => {
            // 奖励降序
            const s1 = e2.rewards_config[0].rate_per_day - e1.rewards_config[0].rate_per_day;
            // 奖励相等、竞争程度生序
            const s2 = e1['market_competitiveness'] - e2['market_competitiveness'];
            return s1 === 0 ? s2 : s1;
        });
        return data;
    }


    /**
     *
     * @returns {Promise<*>|[{
     *   id: '667904',
     *   question: 'XRP Up or Down on November 7?',
     *   conditionId: '0xac55160440e2c4454489876d9d199d1fdd220d15c112ded3f4073d9990872a26',
     *   slug: 'xrp-up-or-down-on-november-7',
     *   endDate: '2025-11-07T17:00:00Z',
     *   startDate: '2025-11-06T15:45:35.060882Z',
     *   outcomes: '["Up", "Down"]',
     *   outcomePrices: '["0.235", "0.765"]',
     *   createdAt: '2025-11-06T15:43:13.836836Z',
     *   questionID: '0x5a907af36fe26c01bc3e5fd94cf6b2d0b4f88a5745cd237b6a5e7dcc5d75e041',
     *   volumeNum: 15335.862565,
     *   liquidityNum: 4729.564,
     *   endDateIso: '2025-11-07',
     *   startDateIso: '2025-11-06',
     *   volume24hr: 5242.988726000001,
     *   clobTokenIds: '["97711861920064027535319065937365233742617188771659696434894133073960855768916", "68162071516944456424576500851165757545095711828887453678098036980269779289193"]',
     *   events: [
     *     {
     *       id: '74648',
     *       ticker: 'xrp-up-or-down-on-november-7',
     *       slug: 'xrp-up-or-down-on-november-7',
     *       title: 'XRP Up or Down on November 7?',
     *       startDate: '2025-11-06T15:46:37.460046Z',
     *       endDate: '2025-11-07T17:00:00Z',
     *     }
     *   ],
     *   lastTradePrice: 0.26,
     *   bestBid: 0.21,
     *   bestAsk: 0.26,
     *   eventStartTime: '2025-11-06T17:00:00Z',
     * }]}
     */
    async listCryptoMarketSortedByEndDate() {
        const url = `${this.marketHost}/markets`;
        const endDateMin = new Date().toISOString();
        const startDateMax = new Date(new Date().getTime() - 1000 * 60 * 60 * 24).toISOString();
        const params = {
            tag_id: 21,
            closed: false,
            active:true,
            enableOrderBook:true,
            volume_num_min: 0,
            order: 'endDate',
            ascending: true,
            end_date_min: endDateMin,
            start_date_max: startDateMax,
            limit: 100,
        };
        // 仅发送有值的查询参数，避免污染默认查询
        const filteredParams = Object.entries(params).reduce((result, [key, value]) => {
            if (value !== undefined && value !== null && value !== "") {
                result[key] = value;
            }
            return result;
        }, {});

        const response = await axios.get(url, {params: filteredParams});
        let dataArr = response?.data;
        return dataArr.filter(ele => {
            // ele.outcomePrices;
            return ele.lastTradePrice >= 0.01 && ele.lastTradePrice <= 0.99;
        });
    }


    /*================交易API===================*/

    /**
     * 获取所有挂单，可按市场或资产过滤
     * @param market
     * @param assetId
     * @returns {Promise<import("@polymarket/clob-client").OpenOrder[]>}
     */
    async listOpenOrders({market, assetId} = {}) {
        const client = await this.getClient();
        const params = {};
        if (market) {
            params.market = market;
        }
        if (assetId) {
            params.asset_id = assetId;
        }

        const orders = await client.getOpenOrders(Object.keys(params).length ? params : undefined);
        if (!Array.isArray(orders)) {
            throw new Error("Failed to fetch open orders");
        }
        return orders;
    }


    /**
     * curl --request GET \ --url 'https://data-api.polymarket.com/positions?sizeThreshold=1&limit=100&sortBy=TOKENS&sortDirection=DESC&user=0x'
     * @param price
     * @param size
     * @param side
     * @param tokenId
     * @returns {Promise<any>|{
     *   errorMsg: '',
     *   orderID: '0x8e818dd295884776b0929b768ceaa43104ec2a34866127ca3d765280e3498054',
     *   takingAmount: '',
     *   makingAmount: '',
     *   status: 'live',
     *   success: true
     * }|{
     *   side: SELL,
     *   errorMsg: '',
     *   orderID: '0xa8add687ee56023e70bae2d8220e2f67fa159b1f040568c96baa3c4f6d2e54df',
     *   takingAmount: '18.3',
     *   makingAmount: '61',
     *   status: 'matched',
     *   transactionsHashes: [
     *     '0x8c06c5fc194837bcb18a37bb10669b16c772eee76e1d546962f9c23967c35e86'
     *   ],
     *   success: true
     * }}
     */
    async placeOrder(price, size, side, tokenId = this.tokenId) {
        const client = await this.getClient();
        const [tickSize, negRisk] = await Promise.all([client.getTickSize(tokenId), client.getNegRisk(tokenId),]);

        const orderRequest = {
            tokenID: tokenId, price, side, size, feeRateBps: 0,
        };

        const orderOptions = {
            tickSize, negRisk,
        };

        return client.createAndPostOrder(orderRequest, orderOptions, this.orderType);
    }

    /**
     *
     * @param orderID
     * @returns {Promise<*>|{
     *   not_canceled: {},
     *   canceled: [
     *     '0x8e818dd295884776b0929b768ceaa43104ec2a34866127ca3d765280e3498054'
     *   ]
     * }}
     */
    async cancelOrder(orderID) {
        if (!orderID) {
            throw new Error("orderID is required to cancel an order");
        }

        const client = await this.getClient();
        return client.cancelOrder({orderID});
    }


    /*================持仓API===================*/
    /**
     * 获取当前地址的公开持仓（不需要签名）
     * @returns {Promise<any[]>}
     */
    async listPositions() {
        const address = this.funderAddress || this.signer.address;
        const url = `${this.dataHost}/positions`;
        const params = {
            sizeThreshold: 1, limit: 100, sortBy: "TOKENS", sortDirection: "DESC", user: address,
        };

        const response = await axios.get(url, {params});
        return response?.data;
    }


    /*================订单API===================*/
    /**
     * 获取自身相关的成交记录（仅限作为做市方时）
     * @returns {Promise<import("@polymarket/clob-client").Trade[]>}
     */
    async listMyTrades() {
        const client = await this.getClient();
        const address = this.funderAddress || await client.signer.getAddress();
        const trades = await client.getTrades({maker_address: address});
        if (!Array.isArray(trades)) {
            throw new Error("Failed to fetch personal trade history");
        }
        let rlt = trades.reduce((rlt, trade,) => {
            let makerOrders = trade.maker_orders.filter(order => {
                return order.maker_address === address
            });
            rlt.push(makerOrders);
            return rlt;
        }, []);
        return rlt;
    }

    /**
     * 获取 USDC 余额（collateral）
     * @returns {Promise<string>}
     */
    async getUsdcBalance() {
        const client = await this.getClient();
        const response = await client.getBalanceAllowance({asset_type: AssetType.COLLATERAL});
        if (!response) {
            throw new Error("Failed to fetch USDC balance: empty response");
        }
        if (response.error) {
            throw new Error(`Failed to fetch USDC balance: ${response.error}`);
        }

        if (typeof response.balance === "string") {
            return response.balance;
        }

        if (response.balance && typeof response.balance.balance === "string") {
            return response.balance.balance;
        }

        throw new Error("Failed to fetch USDC balance: unexpected response shape");
    }

}


export const PolySide = Side;
export const PolyAssetType = AssetType;
