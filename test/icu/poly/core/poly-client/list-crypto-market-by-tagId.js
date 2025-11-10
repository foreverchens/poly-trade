import {createPolyClient} from './test-helper.js';

let on = "bitcoin-price-on-november-13";
let above = "bitcoin-above-on-november-13";
let polyClient = createPolyClient();
let rlt = await polyClient.getEventBySlug(on);
rlt = rlt.markets.filter(ele => {
    let diff = Date.parse(ele.endDate) - Date.now();
    return diff > 0 && diff < (1000 * 60 * 60 * 4) && ((ele.bestAsk > 0.02 && ele.bestAsk < 0.1) || (ele.bestAsk > 0.9 && ele.bestAsk < 0.98));
});
console.log(rlt);