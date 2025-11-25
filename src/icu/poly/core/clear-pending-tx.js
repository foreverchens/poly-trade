// 检查并加速卡住的交易
import 'dotenv/config';
import { checkPendingTransactions, speedUpTransaction } from './ether-client.js';


async function main(privateKey) {
    console.log('正在检查交易状态...\n');

    // 检查是否有 pending 交易
    const status = await checkPendingTransactions(privateKey);

    if (status.hasPending) {
        console.log(`\n发现 ${status.stuckCount} 笔卡住的交易`);
        console.log(`是否需要加速？将发送替换交易...\n`);

        // 从第一个卡住的 nonce 开始加速
        const stuckNonce = status.confirmedNonce;

        console.log(`准备加速 nonce ${stuckNonce}...`);

        try {
            // 使用 1.5 倍的 gas 价格加速
            const result = await speedUpTransaction(privateKey, stuckNonce, {
                gasPriceMultiplier: 3.5
            });

            console.log(`\n✓ 加速成功!`);
            console.log(`新交易hash: ${result.hash}`);
            console.log(`区块号: ${result.receipt.blockNumber}`);
        } catch (error) {
            console.error(`\n✗ 加速失败:`, error.message);
        }
    } else {
        console.log('✓ 没有卡住的交易');
    }
}

const privateKey = "";
main(privateKey).catch(console.error);

