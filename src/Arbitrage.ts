import * as _ from "lodash";
import {BigNumber, Contract, Wallet} from "ethers";
import {FlashbotsBundleProvider, FlashbotsTransaction} from "@flashbots/ethers-provider-bundle";
import {WETH_ADDRESS} from "./addresses";
import {EthMarket} from "./EthMarket";
import {ETHER, bigNumberToDecimal} from "./utils";

export interface CrossedMarketDetails {
    profit: BigNumber,
    volume: BigNumber,
    tokenAddress: string,
    buyFromMarket: EthMarket,
    sellToMarket: EthMarket,
    checkGain: boolean,
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
const TEST_VOLUMES = [
    ETHER.div(1000),
    ETHER.div(100),
    ETHER.div(10),
    ETHER.div(6),
    ETHER.div(4),
    ETHER.div(2),
    ETHER.div(1),
    ETHER.mul(2),
    ETHER.mul(5),
    ETHER.mul(10),
]

export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string, checkGain: boolean): CrossedMarketDetails | undefined {
    let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
    // if (tokenAddress === "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599") {
    //   console.log("found wBTC");
    //   console.log("markets: ", crossedMarkets)
    // }
    for (const crossedMarket of crossedMarkets) {
        const sellToMarket = crossedMarket[0]
        const buyFromMarket = crossedMarket[1]
        for (const size of TEST_VOLUMES) {
            const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, size);
            const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tokensOutFromBuyingSize)
            const profit = proceedsFromSellingTokens.sub(size);
            if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
                // If the next size up lost value, meet halfway. TODO: replace with real binary search
                const trySize = size.add(bestCrossedMarket.volume).div(2)
                const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, trySize);
                const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tryTokensOutFromBuyingSize)
                const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
                if (tryProfit.gt(bestCrossedMarket.profit)) {
                    bestCrossedMarket = {
                        volume: trySize,
                        profit: tryProfit,
                        tokenAddress,
                        sellToMarket,
                        buyFromMarket,
                        checkGain
                    }
                }
                break;
            }
            bestCrossedMarket = {
                volume: size,
                profit: profit,
                tokenAddress,
                sellToMarket,
                buyFromMarket,
                checkGain
            }
        }
    }
    return bestCrossedMarket;
}

export class Arbitrage {
    private flashbotsProvider: FlashbotsBundleProvider;
    private bundleExecutorContract: Contract;
    private executorWallet: Wallet;

    constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
        this.executorWallet = executorWallet;
        this.flashbotsProvider = flashbotsProvider;
        this.bundleExecutorContract = bundleExecutorContract;
    }

    static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
        const buyTokens = crossedMarket.buyFromMarket.tokens
        const sellTokens = crossedMarket.sellToMarket.tokens
        console.log(
            `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
            `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
            `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
            `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
            `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
            `\n`
        )
    }


    async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
        const bestCrossedMarkets = new Array<CrossedMarketDetails>()

        for (const tokenAddress in marketsByToken) {
            const markets = marketsByToken[tokenAddress]
            const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
                return {
                    ethMarket: ethMarket,
                    buyTokenPrice: ethMarket.getTokensIn(tokenAddress, WETH_ADDRESS, ETHER.div(100)),
                    sellTokenPrice: ethMarket.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER.div(100)),
                }
            });

            const isBtc = tokenAddress === "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
            // const isBtc = false;


            const crossedMarkets = new Array<Array<EthMarket>>()
            for (const pricedMarket of pricedMarkets) {
                _.forEach(pricedMarkets, pm => {

                    if (pricedMarket.ethMarket.marketAddress === pm.ethMarket.marketAddress) {
                        return
                    }

                    if (isBtc || pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
                        crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket])
                    }
                })
            }

            // if (isBtc) {
            //   console.log("found wBTC");
            //   console.log("price markets: ", pricedMarkets)
            //   console.log("cross markets: ", crossedMarkets)
            // }

            const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress, !isBtc);
            // if (isBtc) {
            //     console.log("bestCrossedMarket: ", bestCrossedMarket);
            // }
            if (bestCrossedMarket !== undefined && (isBtc || bestCrossedMarket.profit.gt(ETHER.div(1000)))) {
                bestCrossedMarkets.push(bestCrossedMarket)
            }
        }
        bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)
        return bestCrossedMarkets
    }

    // TODO: take more than 1
    async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[], blockNumber: number, minerRewardPercentage: number): Promise<void> {
        for (const bestCrossedMarket of bestCrossedMarkets) {

            console.log("Send this much WETH", bestCrossedMarket.volume.toString(), "get this much profit", bestCrossedMarket.profit.toString())
            const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(WETH_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
            const inter = bestCrossedMarket.buyFromMarket.getTokensOut(WETH_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume)
            const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, this.bundleExecutorContract.address);

            const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress]
            const payloads: Array<string> = [...buyCalls.data, sellCallData]
            console.log({targets, payloads})

            let minerReward = bestCrossedMarket.profit.mul(minerRewardPercentage).div(100);
            // TEST: make sure minerReward is positive
            if (!bestCrossedMarket.checkGain) {
                minerReward = minerReward.abs().mul(3)
            }
            // const gasPrice = await this.bundleExecutorContract.provider.getGasPrice()
            console.log("paying miner reward: ", minerReward.toString())
            const feeData = await this.bundleExecutorContract.provider.getFeeData()
            const gasMultiplier = BigNumber.from(4)
            const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(bestCrossedMarket.volume, minerReward, targets, payloads, bestCrossedMarket.checkGain, {
                type: 2,
                // gasPrice: BigNumber.from(0),
                gasLimit: BigNumber.from(1000000),
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.mul(gasMultiplier) || BigNumber.from("2500000000"),
                maxFeePerGas: feeData.maxFeePerGas?.mul(gasMultiplier) || undefined
            });



            try {

                const estimateGas = await this.bundleExecutorContract.provider.estimateGas(
                    {
                        ...transaction,
                        from: this.executorWallet.address
                    })

                if (estimateGas.gt(1400000)) {
                    console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString())
                    continue
                }
                // const estimateGas = BigNumber.from("1000000");
                transaction.gasLimit = estimateGas.mul(gasMultiplier.add(1)); //2
                transaction.gasPrice = transaction.maxFeePerGas;
                transaction.chainId = 1;

                console.log("fees => gasPrice: ", transaction.gasPrice?.toString(), " gasLimit: ", transaction.gasLimit.toString(), " maxPriorityFeePerGas: ", transaction.maxFeePerGas?.toString(), " maxFeePerGas: ", transaction.maxFeePerGas?.toString());
                // transaction.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || BigNumber.from("2500000000"); //web3.utils.toHex(maxPriorityFeePerGas)
                // transaction.maxFeePerGas = feeData.maxFeePerGas || undefined;//web3.utils.toHex(maxFeePerGas)
            } catch (e) {
                console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)} `, e)
                continue
            }
            const bundledTransactions = [
                {
                    signer: this.executorWallet,
                    transaction: transaction
                }
            ];
            console.log(bundledTransactions)
            const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions)
            const startBlockOffset = 2
            const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + startBlockOffset)
            if ("error" in simulation || simulation.firstRevert !== undefined) {
                console.log(`Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`)
                console.log(`Simulation Error: `, simulation)
                continue
            }
            console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`)

            const blockNumbers =    [...Array(10).keys()].map(i => blockNumber + i + startBlockOffset)
            //const blockNumbers = [blockNumber + 1, blockNumber + 2]
            const bundlePromises = _.map(blockNumbers, targetBlockNumber =>
                this.flashbotsProvider.sendRawBundle(
                    signedBundle,
                    targetBlockNumber
                ))
            console.log("target block numbers: ", blockNumbers)
            const fts = await Promise.all(bundlePromises)

            /////////////////////print result ////////////////////
            for(let i = 0; i < fts.length; i++) {
                const t = fts[i];
                if ('error' in t) {

                    console.log("flashbot transaction failed: ", t)

                } else {
                    if (i == 0) {
                        const rec = await t.receipts()
                        // const sim = await t.simulate()
                        console.log("flashbot transaction receipts: ", rec)
                        // console.log("flashbot transaction sim: ", sim)
                        console.log("bundled transaction hash: ", t.bundleTransactions[0].hash)

                    }
                    const stats = await this.flashbotsProvider.getBundleStatsV2(t.bundleHash, blockNumbers[i])
                    if (!('error' in stats)) {
                        if (stats.consideredByBuildersAt) {
                            console.log(`flashbot transaction considered (${blockNumbers[i]}): `, stats.consideredByBuildersAt)
                        }
                    } else {
                        console.log("bundle stats error: ", stats)
                    }


                }
            }

            // }
            /////////////////////print result ////////////////////

            return
        }
        throw new Error("No arbitrage submitted to relay")
    }
}
