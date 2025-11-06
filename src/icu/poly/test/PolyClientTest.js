import {PolyClient, PolySide} from '../PolyClient.js';

const polyClient = new PolyClient();
const tokenIdA = '57527508293969725929016010432598810481282998125631347013024726997019637985331'
const tokenIdB = '4589745821222679801714536143948817055789206104581183883296167003774519971663'


let listRewardMarketTest = () => {
    polyClient.listRewardMarket().then(rlt => {
        let data = rlt.slice(0, 20).map(ele => {
            // console.log(ele)
            return {
                // event_id:ele.event_id,
                market_id:ele.market_id,
                // condition_id:ele.condition_id,
                question: ele['question'].slice(0, 20),
                // market_slug:ele.market_slug,
                volume_24hr:ele.volume_24hr,
                tokenPriceA: ele.tokens[0].outcome.concat('->').concat(ele.tokens[0].price),
                // tokenIdA: ele.tokens[0].token_id,
                tokenPriceB: ele.tokens[1].outcome.concat('->').concat(ele.tokens[1].price),
                // tokenIdB: ele.tokens[1].token_id,
                reward: ele.rewards_config[0].rate_per_day,
                market_competitiveness: ele['market_competitiveness'],
                rate: (ele.rewards_config[0].rate_per_day / ele['market_competitiveness']).toFixed(1)
            }
        });
        console.table(data);
    }).catch(console.error);
}

/**
 * {
 *   market_id: '541622',
 *   condition_id: '0xaa5041ca3ea8400325d726e0fb44b85180c4d6211dea960d7a3fb4600d5d6c76',
 *   question: 'Will José Antonio Kast win the Chilean presidential election?',
 *   market_slug: 'will-jos-antonio-kast-win-the-chilean-presidential-election',
 *   volume_24hr: 133541.32548800015,
 *   event_id: '23947',
 *   event_slug: 'chile-presidential-election',
 *   image: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/will-jos-antonio-kast-win-the-chilean-presidential-election-DlHl8J4eVpCw.jpg',
 *   maker_address: '0x0000000000000000000000000000000000000000',
 *   tokens: [
 *     {
 *       token_id: '57527508293969725929016010432598810481282998125631347013024726997019637985331',
 *       outcome: 'Yes',
 *       price: 0.635
 *     },
 *     {
 *       token_id: '4589745821222679801714536143948817055789206104581183883296167003774519971663',
 *       outcome: 'No',
 *       price: 0.365
 *     }
 *   ],
 *   rewards_config: [
 *     {
 *       asset_address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
 *       start_date: '2025-05-06',
 *       end_date: '2500-12-31',
 *       rate_per_day: 250,
 *       total_rewards: 0
 *     }
 *   ],
 *   earnings: [
 *     {
 *       asset_address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
 *       earnings: 0,
 *       asset_rate: 0.999799
 *     }
 *   ],
 *   rewards_max_spread: 3.5,
 *   rewards_min_size: 200,
 *   earning_percentage: 0,
 *   spread: 0.01,
 *   market_competitiveness: 9.581548
 * }
 * @param marketId
 */
let getMarketInfo = (marketId) =>{
    polyClient.listRewardMarket().then(rlt => {
        let data = rlt.slice(0, 20)
            .filter(ele=>ele.market_id === marketId)
            .slice(0,1);
        console.log(data[0]);
    }).catch(console.error);
}

let getPriceTest = () => {
    polyClient.getPrice(PolySide.BUY, tokenIdA).then(rlt => {
        console.log('tokenA buy price:' + rlt)
    }).catch(console.error);
    polyClient.getPrice(PolySide.SELL, tokenIdA).then(rlt => {
        console.log('tokenA sell price:' + rlt)
    }).catch(console.error);

    polyClient.getPrice(PolySide.BUY, tokenIdB).then(rlt => {
        console.log('tokenB buy price:' + rlt)
    }).catch(console.error);
    polyClient.getPrice(PolySide.SELL, tokenIdB).then(rlt => {
        console.log('tokenB sell price:' + rlt)
    }).catch(console.error);
}

let getOrderBookTest = () => {
    polyClient.getOrderBook(tokenIdA).then(console.log).catch(console.error);
}

let placeOrderTest = (price, size, side, tokenId = tokenIdA) => {
    polyClient.placeOrder(price, size, side, tokenId).then(console.log).catch(console.error);
}


let listOpenOrdersTest = () => {
    polyClient.listOpenOrders().then(orders => {
        console.log('open orders total:', orders.length);
        console.log(orders.slice(0, 10).map(order => ({
            id: order.id,
            market: order.market,
            asset: order.asset_id,
            side: order.side,
            price: order.price,
            size: order.original_size,
            matched: order.size_matched,
            status: order.status
        })));
    }).catch(console.error);
}

let getUsdcBalanceTest = () => {
    polyClient.getUsdcBalance().then(balance => {
        console.log('USDC balance:', balance);
    }).catch(console.error);
}


let listOrdersTest = ()=>{
    polyClient.listMyTrades().then(rlt => {
        console.log( rlt[0]);
    }).catch(console.error);
}

let listPositionsTest = ()=>{
    polyClient.listPositions().then(console.log)
}





// listPositionsTest()
// 订单列表获取
// listOrdersTest()
//  市场列表获取
// listRewardMarketTest();
// getMarketInfo('541622');
// 价格获取
// getPriceTest();
// 获取订单簿信息
// getOrderBookTest();
// 挂单测试
const price = '0.4';
const size = '5';
const side = PolySide.BUY;
// placeOrderTest(price, size, side, tokenIdA);
// 取消订单测试
// polyClient.cancelOrder("0x8e818dd295884776b0929b768ceaa43104ec2a34866127ca3d765280e3498054").then(console.log).catch(console.error);
// USDC 余额
// getUsdcBalanceTest();


// 挂单列表
/**
 * [
 *   {
 *     id: '0xc77d96bc40081fbe02b880360a7401867e56f7eca2deb0cad501f2f99c4a84df',
 *     market: '0x3df9aa7b133ece96a33d8675a7accc5cb1165e319803bda3b5f020578a352fb6',
 *     asset: '11415059285502382796830815816923630513190785942316132459687330531824368639158',
 *     side: 'BUY',
 *     price: '0.4',
 *     size: '5',
 *     matched: '0',
 *     status: 'LIVE'
 *   }
 * ]
 */
listOpenOrdersTest();
