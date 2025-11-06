import "dotenv/config";
import pkg from "@polymarket/clob-client";
import {SignatureType} from "@polymarket/order-utils";
import {Wallet} from "@ethersproject/wallet";

const {ClobClient, OrderType, Side} = pkg;

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const TOKEN_ID = "87769991026114894163580777793845523168226980076553814689875238288185044414090";

const ORDER_TYPE = OrderType.GTC
const SIGNATURE_TYPE = SignatureType.EOA;
const FUNDER_ADDRESS = process.env.POLY_FUNDER;


async function createAuthedClient(host, chainId, signer, signatureType, funder) {
    const client = new ClobClient(host, chainId, signer);
    const creds = await client.createOrDeriveApiKey();
    return new ClobClient(host, chainId, signer, creds, signatureType, funder);
}

async function placeOrder(price, size, side) {
    const privateKey = process.env.PRIVATE_KEY;
    const signer = new Wallet(privateKey);
    const client = await createAuthedClient(HOST, CHAIN_ID, signer, SIGNATURE_TYPE, FUNDER_ADDRESS);
    const [tickSize, negRisk] = await Promise.all([
        client.getTickSize(TOKEN_ID),
        client.getNegRisk(TOKEN_ID),
    ]); // builder enforces price boundaries using market tick size and neg-risk flag

    const orderRequest = {
        tokenID: TOKEN_ID,
        price: price,
        side: side,
        size: size,
        feeRateBps: 0,
    };

    const orderOptions = {
        tickSize,
        negRisk,
    };

    return client.createAndPostOrder(orderRequest, orderOptions, ORDER_TYPE);
}

placeOrder(0.5, 1, Side.BUY).then(rlt => console.log(rlt)).catch(err => console.log(err))
