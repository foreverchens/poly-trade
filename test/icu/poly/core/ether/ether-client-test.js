import { transferPOL, transferUSDC,getPOLBalance,getUSDCeBalance,getConfirmedNonce,getLatestUsedNonce,getNonce,getBalances } from '../../../../../src/icu/poly/core/ether-client.js';

const privateKey = "";
const toAddress = "";


// getNonce(privateKey).then(ele=>{
//     console.log(`nonce: ${ele.current}, pending: ${ele.pending}`);
// }).catch(error=>{
//     console.error(`error: ${error}`);
// });
// getConfirmedNonce(privateKey).then(ele=>{
//     console.log(`confirmed nonce: ${ele}`);
// }).catch(error=>{
//     console.error(`error: ${error}`);
// });

// getLatestUsedNonce(privateKey).then(ele=>{
//     console.log(`latest used nonce: ${ele}`);
// }).catch(error=>{
//     console.error(`error: ${error}`);
// });


// getPOLBalance(toAddress).then(ele=>{
//     console.log(`POL balance: ${ele}`);
// }).catch(error=>{
//     console.error(`error: ${error}`);
// });

// getUSDCeBalance(toAddress).then(ele=>{
//     console.log(`USDC.e balance: ${ele}`);
// }).catch(error=>{
//     console.error(`error: ${error}`);
// });
// getBalances(toAddress).then(ele=>{
//     console.log(`POL balance: ${ele.pol}, USDC.e balance: ${ele.usdc}`);
// }).catch(error=>{
//     console.error(`error: ${error}`);
// });

console.log("transfer POL...");
transferPOL(privateKey, toAddress, "1").then(ele=>{
    console.log(`hash: ${ele.hash}, blockNumber: ${ele.receipt.blockNumber}`);

    console.log("transfer USDC...");
    transferUSDC(privateKey, toAddress, "1").then(ele=>{
        console.log(`hash: ${ele.hash}, blockNumber: ${ele.receipt.blockNumber}`);
    }).catch(error=>{
        console.error(`error: ${error}`);
    });
}).catch(error=>{
    console.error(`error: ${error}`);
});


