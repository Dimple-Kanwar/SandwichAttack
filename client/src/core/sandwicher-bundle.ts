import {
  BigNumber,
  constants,
  Contract,
  ethers,
  providers,
  utils,
  Wallet,
} from 'ethers';
import web3 from 'web3';
import { config } from '../config';

import { REVEAL_CONTRACT_ABI, FactoryLive_ABI, ROUTER_ABI } from '../constants';

import {
  calcSandwichStates,
  fetchTokenData,
  getTokenBalance,
  parseError,
  sleep,
} from '../helpers';
import { Token } from '../types';
import { Bytes, keccak256 } from 'ethers/lib/utils';

class Sandwicher {
  private _provider: providers.JsonRpcProvider;
  private _pancakeSwap: utils.Interface;
  private contract: Contract;
  private revealContract: Contract;
  private _broadcastedTx: boolean;
  private uniqueInt: number;
  private signer: Wallet;
  private PUBLIC_KEY: string;

  constructor() {
    // initialize some variables i.e provider, signers, interface

    this._pancakeSwap = new utils.Interface(ROUTER_ABI);
    this._provider = new providers.JsonRpcProvider(config.JSON_RPC);
    this.signer = new Wallet(config.PRIVATE_KEY, this._provider);
    // Increment for each contract created
    this.uniqueInt = parseInt('0');
    this.contract = new Contract(
      config.CONTRACT_ADDRESS!,
      FactoryLive_ABI,
      this.signer
    );
    this.revealContract = new Contract(
      config.REVEAL_CONTRACT_ADDRESS!,
      REVEAL_CONTRACT_ABI,
      this.signer);

    this._broadcastedTx = false;

    this.PUBLIC_KEY = '';
  }

  init = async () => {
    // setup defaults
    console.info(`Setting up defaults`);
    await this.#setDefaults();
    console.info(`- - - `);
    console.info(`Defaults set ✔️\n`);

    // start monitoring
    console.info(`Monitoring mempool...`);
    await this.#monitor();
  };

  /**
   *  Monitor mempool for transactions
   */
  #monitor = async () => {
    // implement mempool monitoring
    let wsProvider = new providers.WebSocketProvider(config.WSS_URL);
    wsProvider.on('pending', async (hash) => {
      try {
        let receipt = await wsProvider.getTransaction(hash);
        receipt && this.#process(receipt);
      } catch (error) {
        console.error(error);
      }
    });
  };

  #setDefaults = async () => {
    // get the public key
    this.PUBLIC_KEY = await this.signer.getAddress();
  };

  /**
   * Process transactions
   * @note: this is where the magic happens
   * # slippage check
   * # calc optimal amount In
   * # rug check
   * # profitablity check
   * @param receipt - transaction receipt
   */

  #process = async (receipt: providers.TransactionResponse) => {
    let {
      value: targetAmountInWei,
      to: router,
      gasPrice: targetGasPriceInWei,
      gasLimit: targetGasLimit,
      hash: targetHash,
      from: targetFrom,
      data,
    } = receipt;

    let tx: utils.TransactionDescription;
    try {
      // decode tx data
      tx = this._pancakeSwap.parseTransaction({
        data,
      });
    } catch (error) {
      // console.error(error);
      return;
    }

    let { name: targetMethodName, args: targetArgs } = tx;

    let { path, amountOutMin: targetAmountOutMin, deadline } = targetArgs;

    try {
      //if the path or router  is undefined stop execution and return
      if (!path || !router) return;

      // if tx deadline has passed, skip it as we can't sandwich it
      let now = Math.floor(Date.now() / 1000);

      if (deadline.lte(BigNumber.from(now))) {
        console.info(`Transaction deadline has passed`, { targetHash });
        return;
      }

      let [targetFromToken, targetToToken] = await fetchTokenData(
        this._provider,
        [path[0], path[path.length - 1]]
      );

      // ensure target is buying with wbnb or bnb
      if (
        targetFromToken.address.trim().toLowerCase() !=
        config.WBNB_ADDRESS.trim().toLowerCase()
      ) {
        console.info(
          `Skipping: Target is buying with ${targetFromToken.address}`,
          {
            targetHash,
            targetMethodName,
          },
          '\n'
        );
        return;
      }

      // get current execution price
      let executionPrice = await this.#getAmountsOut(
        router,
        path,
        targetAmountInWei
      );

      // calc target slippage
      let { slippage: targetSlippage } = this.#calcSlippage({
        executionPrice,
        targetAmountOutMin,
        targetMethodName,
      });

      if (
        targetSlippage <
        config.MIN_SLIPPAGE_THRESHOLD / 100 //~ 1%
      ) {
        console.log(
          `Skipping: Tx ${targetHash} Target slippage ${parseFloat(
            (targetSlippage * 100).toFixed(4)
          )} is < ${config.MIN_SLIPPAGE_THRESHOLD}%`
        );
        return;
      }

      let amountOut = parseFloat(
        utils.formatUnits(targetAmountOutMin, targetToToken.decimals)
      );

      // if target amount out is 0; then their slippage is 100 %
      // make their slippage  5%
      if (amountOut == 0) {
        console.info(
          `Target slippage is 100%, impossing ${parseFloat(
            (config.MIN_SLIPPAGE_THRESHOLD * 3).toFixed(4)
          )}% slippage`
        );
        amountOut =
          parseFloat(
            utils.formatUnits(executionPrice, targetToToken.decimals)
          ) *
          (1 - (config.MIN_SLIPPAGE_THRESHOLD / 100) * 3);
      }

      let { reserveBNB, reserveToken } = await this.#getReserves(path, router);

      let fmtTargetAmountIn = parseFloat(
        utils.formatUnits(targetAmountInWei, targetFromToken.decimals)
      );
      let amountIn = this.#calcOptimalAmountIn({
        targetAmountIn: fmtTargetAmountIn,
        targetAmountOutMin: amountOut,
        targetFromToken,
        reserve0: parseFloat(
          utils.formatUnits(reserveBNB, targetFromToken.decimals)
        ),
        reserve1: parseFloat(
          utils.formatUnits(reserveToken, targetToToken.decimals)
        ),
      });

      let tokenBalance = await getTokenBalance(
        this._provider,
        targetFromToken.address
      );

      // if amountIn is greater than token balance, just ignore it
      if (amountIn.gt(tokenBalance)) {
        console.log(
          `Skipping: Buy attack amount ${utils.formatUnits(
            amountIn,
            targetFromToken.decimals
          )} ${targetFromToken.symbol} is > our ${targetFromToken.symbol
          } token balance ${utils.formatUnits(
            tokenBalance,
            targetFromToken.decimals
          )} ${targetFromToken.symbol}, Token: ${targetToToken.symbol}\n`
        );
        return;
      }

      if (amountIn.lte(0)) {
        console.log(
          `Skipping: Buy attack amount is <= 0, Token: ${targetToToken.symbol}`
        );
        return;
      }

      let amountOutMin = await this.#getAmountsOut(router, path, amountIn);

      // calc our buy  slippage
      let fmtAmountOutMin = (
        parseFloat(
          parseFloat(
            utils.formatUnits(amountOutMin, targetToToken.decimals)
          ).toFixed(targetToToken.decimals)
        ) *
        (1 - config.MIN_SLIPPAGE_THRESHOLD / 100)
      ).toFixed(targetToToken.decimals);

      amountOutMin = utils.parseUnits(fmtAmountOutMin, targetToToken.decimals);

      // calc our sell slippage

      let fmtSellAmtOutMin = (
        parseFloat(utils.formatUnits(amountIn, targetFromToken.decimals)) *
        (1 - config.MIN_SLIPPAGE_THRESHOLD / 100)
      ).toFixed(targetToToken.decimals);

      let sellAmountOutMin = utils.parseUnits(
        fmtSellAmtOutMin,
        targetFromToken.decimals
      );

      /*let swapAnalysis; 
      console.log(`Checking swap`);
      try{
      swapAnalysis = await this.contract.swapAnalysis(router,amountIn,path);
      if(!swapAnalysis){
        console.log(
          `Skipping: Buy attack stoped because not withdrawable.`);
          return
      }
      }
      
      catch(error){
        console.log('Error',error)
        console.log(
          `Skipping: Buy attack stoped because not withdrawable.`);
          return
      }
      console.log(swapAnalysis);*/
      let { buyData, sellData } = this.prepareBuyAndSellData({
        router,
        path,
        amountIn,
        amountOutMin,
        sellAmountOutMin,
      });

      let { safe, hasTax, buyTax, sellTax, error } = await this.#isSafe({
        buyData,
        sellData,
      });

      // @note currently tokens with tax are considered unsafe
      if (hasTax) {
        console.info(
          `Skipping: Token ${targetToToken.symbol}, ${targetToToken.address
          } has a buy tax of ${(buyTax * 100).toFixed(2) + '%'
          } and a sell tax of ${(sellTax * 100).toFixed(2) + '%'}`
        );
        return;
      }
      if (!safe) {
        console.info(
          `Skipping: Token ${targetToToken.symbol}, ${targetToToken.address} is not safe, ${error}`
        );
        return;
      }

      // calc profit
      let { rawProfit } = this.#calcProfit({
        amountIn,
        targetAmountIn: targetAmountInWei,
        targetAmountOutMin: utils.parseUnits(
          amountOut.toString(),
          targetToToken.decimals
        ),
        reserve0: reserveBNB,
        reserve1: reserveToken,
      });

      let rawProfitFormatted = utils.formatUnits(
        rawProfit,
        targetFromToken.decimals
      );
      console.log({
        rawProfit: rawProfitFormatted,
      });
      let gasPrice = utils.parseUnits(
        Math.max(
          parseFloat(
            utils.formatUnits(targetGasPriceInWei || BigNumber.from(0), 'gwei')
          ) * config.GAS_FACTOR,
          7
        ).toString(),
        'gwei'
      );

      let profitInTargetFromToken = constants.Zero;
      if (parseFloat(rawProfitFormatted) < config.MIN_PROFIT_THRESHOLD) {
        console.log(
          `Skipping: Raw Profit is ${rawProfitFormatted}, Min Profit: ${config.MIN_PROFIT_THRESHOLD}Token: ${targetToToken.symbol}, ${targetToToken.address}`
        );
        return;
      }

      targetGasPriceInWei = targetGasPriceInWei || constants.Zero;

      if (!this._broadcastedTx) {
        this._broadcastedTx = true;
        // broadcast buy tx
        let nonce = await this._provider.getTransactionCount(this.PUBLIC_KEY);
        let {
          success,
          msg: buyErrorMsg,
          hash: buyHash,
        } = await this.buyTx(router, path,
          amountIn,
          amountOutMin, {
          gasPrice,
          gasLimit: config.DEFAULT_GAS_LIMIT,
          nonce,
        });
        console.log({ success, msg: buyErrorMsg || `Buy tx sent` });
        if (success) {
          nonce += 1;
          this.uniqueInt++;
          // broadcast sell tx after 200ms
          await sleep(200);

          let {
            success,
            msg: sellErrorMsg,
            hash: sellHash,
          } = await this.sellTx(router, path,
            amountIn,
            amountOutMin, {
            gasLimit: config.DEFAULT_GAS_LIMIT,
            nonce,
            gasPrice: targetGasPriceInWei,
          });

          console.log({ success, msg: sellErrorMsg || `Sell tx sent` });

          let targetGasFeeInBNB = utils.formatEther(
            targetGasLimit.mul(targetGasPriceInWei || constants.Zero)
          );

          let targetAmount = parseFloat(
            utils.formatUnits(targetAmountInWei, targetFromToken.decimals)
          );

          let targetGasPriceInGwei = `${parseFloat(
            utils.formatUnits(targetGasPriceInWei || constants.Zero, 'gwei')
          ).toString()} Gwei`;

          let profitInTargetToToken = executionPrice.sub(targetAmountOutMin);

          console.log({
            router,
            targetHash,
            targetFrom,
            targetAmount,
            path,
            targetFromToken,
            targetToToken,
            targetMethodName,
            targetGasPriceInGwei,
            targetGasFeeInBNB: parseFloat(targetGasFeeInBNB),
            targetAmountOutMin: utils.formatUnits(
              targetAmountOutMin,
              targetToToken.decimals
            ),
            executionPrice: utils.formatUnits(
              executionPrice,
              targetToToken.decimals
            ),
            profitInTargetFromToken: utils.formatUnits(
              profitInTargetFromToken,
              targetFromToken.decimals
            ),
            profitInTargetToToken: utils.formatUnits(
              profitInTargetToToken,
              targetToToken.decimals
            ),

            targetSlippage,
            amountIn: utils.formatUnits(amountIn, targetFromToken.decimals),
          });

          let msg = `**NEW TRADE NOTIFICATION**\n---`;

          msg += `\nToken: ${targetToToken.name}, ${targetToToken.symbol}, ${targetToToken.decimals}`;
          msg += `\nToken Address: \`${targetToToken.address}\``;
          msg += `\nRouter: \`${targetToToken.address}\``;
          msg += `\n---`;

          msg += `\n**BUY TRADE**\n---`;

          msg += `\nEst. AmountIn: \`${parseFloat(
            utils.formatUnits(amountIn, targetFromToken.decimals)
          ).toString()} ${targetFromToken.symbol}\``;
          msg += `\nAmountIn: \`${parseFloat(
            parseFloat(
              utils.formatUnits(amountIn, targetFromToken.decimals)
            ).toFixed(6)
          )} ${targetFromToken.symbol}\``;
          msg += `\nBuy Status: ${buyErrorMsg?.replaceAll('(', '\\(').replaceAll(')', '\\)') || '✔️'
            }`;
          msg += buyHash
            ? `\nBuy Hash: ${`[${buyHash.toUpperCase()}](${config.EXPLORER_URL
            }/tx/${buyHash})`}`
            : '';

          msg += `\nGas Price: \`${parseFloat(
            parseFloat(utils.formatUnits(gasPrice, 'gwei')).toFixed(6)
          ).toString()} Gwei\``;

          msg += `\n- - -`;

          msg += `\n**TARGET TRADE**\n---`;
          msg += `\nFrom: \`${targetFrom.toUpperCase()}\``;
          msg += `\nTarget Hash: [${targetHash.toUpperCase()}](${config.EXPLORER_URL
            }/tx/${targetHash})`;
          msg += `\nTarget AmountIn: \`${parseFloat(targetAmount.toFixed(6))} ${targetFromToken.symbol
            }\``;
          msg += `\nTarget Slippage: \`${(targetSlippage * 100).toFixed(4)}%\``;

          msg += `\nTarget Gas Price: \`${targetGasPriceInGwei}\``;

          msg += `\n- - -`;

          msg += `\n**SELL TRADE**\n---`;
          msg += `\nSell Status: ${sellErrorMsg?.replaceAll('(', '\\(').replaceAll(')', '\\)') || '✔️'
            }`;
          msg += sellHash
            ? `\nSell Hash: ${`[${sellHash.toUpperCase()}](${config.EXPLORER_URL
            }/tx/${sellHash})`}`
            : '';

          msg += `\n---`;

          msg += `\nExecution Price: \`${parseFloat(
            parseFloat(
              utils.formatUnits(executionPrice, targetToToken.decimals)
            ).toFixed(6)
          )} ${targetToToken.symbol}\``;

          msg += `\nEst. Profit in ${targetFromToken.symbol}: \`${parseFloat(
            parseFloat(
              utils.formatUnits(
                profitInTargetFromToken,
                targetFromToken.decimals
              )
            ).toFixed(6)
          )}\``;
          msg += `\nEst. Profit in ${targetToToken.symbol}: \`${parseFloat(
            parseFloat(
              utils.formatUnits(profitInTargetToToken, targetToToken.decimals)
            ).toFixed(6)
          )}\``;
          msg += `\n---`;

          //sendMessage(msg);

          await sleep(9000);
          this._broadcastedTx = false;
        }
      } else {
        console.info(`Skipping: Tx ${targetHash} already broadcasted`);
      }
      console.log(`- - - `.repeat(10));
    } catch (error) {
      let msg = parseError(error);
      console.error({ msg, path });
      await sleep(6000);
      this._broadcastedTx = false;
    }
  };
  #calcSlippage = (_params: {
    targetMethodName: string;
    executionPrice: any;
    targetAmountOutMin: any;
  }): {
    slippage: number;
  } => {
    let slippage: any = 0; // target is not willing to lose any amountOut tokens

    let { targetMethodName, executionPrice, targetAmountOutMin } = _params;

    if (targetMethodName.startsWith('swapExactETHFor')) {
      slippage = (executionPrice - targetAmountOutMin) / executionPrice;
      console.log('swapETH');
    } else if (
      targetMethodName.startsWith(
        'swapExactTokensForTokensSupportingFeeOnTransferTokens'
      )
    ) {
      slippage = targetAmountOutMin / executionPrice;
      console.log('swapFee')
    }
    // TODO: add support for swapETHForExactTokens
    else {
      throw new Error(`Unsupported Buy Method: ${targetMethodName}`);
    }

    return {
      slippage,
    };
  };

  #calcOptimalAmountIn = (params: {
    targetAmountIn: number;
    targetAmountOutMin: number;
    targetFromToken: Token;
    reserve0: number;
    reserve1: number;
  }) => {
    let {
      targetAmountIn,
      targetAmountOutMin,
      targetFromToken,
      reserve0,
      reserve1,
    } = params;
    let k = reserve0 * reserve1;
    return utils.parseUnits(
      Math.abs(
        this.#calcWorstReserveIn(targetAmountIn, targetAmountOutMin, k) -
        reserve0
      ).toFixed(targetFromToken.decimals),
      targetFromToken.decimals
    );
  };

  #calcWorstReserveIn = (
    amountIn: number,
    amountOut: number,
    k: number,
    fee = 9975
  ) => {
    let negb = fee * amountIn * -1;

    let fourac = (40000 * fee * amountIn * k) / amountOut;

    let b = (fee * amountIn) ** 2 + fourac;
    let squareroot = Math.sqrt(b);

    let worstRIn = (negb + squareroot) / 20000;

    return worstRIn;
  };

  #getReserves = async (path: string[], router: string) => {
    let routerContract = new Contract(
      router,
      ['function factory() external view returns (address)'],
      this._provider
    );

    let factoryContract = new Contract(
      await routerContract.factory(),
      [
        'function getPair(address tokenA, address tokenB) external view returns (address pair)',
      ],
      this._provider
    );

    let token0 = path[path.length - 2];
    let token1 = path[path.length - 1];
    let pairAddress = await factoryContract.getPair(token0, token1);

    let pairContract = new Contract(
      pairAddress,
      [
        'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
        `function token0() external view returns (address)`,
      ],
      this._provider
    );

    let [reserve0, reserve1] = await pairContract.getReserves();

    let token = await pairContract.token0();
    return {
      reserveBNB: token0 === token ? reserve0 : reserve1,
      reserveToken: token0 === token ? reserve1 : reserve0,
    };
  };
  #getAmountsOut = async (
    router: string,
    path: string[],
    amountIn: BigNumber
  ): Promise<BigNumber> => {
    let contract = new Contract(
      router,
      [
        'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
      ],
      this._provider
    );

    let amounts = await contract.getAmountsOut(amountIn, path);

    return amounts[amounts.length - 1];
  };

  #isSafe = async (
    params: {
      buyData: string;
      sellData: string;
    },
    overloads: {
      gasLimit?: number | string;
      nonce?: number;
    } = {
        gasLimit: config.DEFAULT_GAS_LIMIT,
      }
  ): Promise<{
    safe: boolean;
    hasTax: boolean;
    buyTax: number;
    sellTax: number;
    error?: string;
  }> => {
    let { buyData, sellData } = params;

    try {
      let {
        expectedBuy,
        balanceBeforeBuy,
        balanceAfterBuy,
        balanceBeforeSell,
        balanceAfterSell,
        expectedSell,
      }: {
        expectedBuy: BigNumber;
        balanceBeforeBuy: BigNumber;
        balanceAfterBuy: BigNumber;
        balanceBeforeSell: BigNumber;
        balanceAfterSell: BigNumber;
        expectedSell: BigNumber;
      } = await this.contract.callStatic.simulate(buyData, sellData, overloads);
      // cacl buy tax
      let actualBought = balanceAfterBuy.sub(balanceBeforeBuy);

      let numerator: any = expectedBuy.sub(actualBought);

      let denominator: any = expectedBuy.add(actualBought).div(2);

      let buyTax = Math.abs(numerator / denominator);

      // cacl sell tax
      let actualSold = balanceAfterSell.sub(balanceBeforeSell);

      numerator = expectedSell.sub(actualSold);

      denominator = expectedSell.add(actualSold).div(2);

      let sellTax = Math.abs(numerator / denominator);

      // token has tax?
      let hasTax = Math.max(buyTax, sellTax) > 0;

      return {
        safe: true,
        hasTax,
        buyTax,
        sellTax,
      };

      // return true;
    } catch (error: any) {
      error = parseError(error);
      return {
        safe: false,
        hasTax: false,
        buyTax: 0,
        sellTax: 0,
        error,
      };
    }
  };

  prepareBuyAndSellData = (params: {
    router: string;
    path: string[];
    amountIn: BigNumber;
    amountOutMin: BigNumber;
    sellAmountOutMin: BigNumber;
  }) => {
    let { router, amountOutMin, amountIn, sellAmountOutMin, path } = params;
    try {
      let buyData = utils.defaultAbiCoder.encode(
        ['address', 'uint256', 'uint256', 'address[]'],
        [router, amountIn, amountOutMin, path]
      );

      let sell_path = [...params.path].reverse();

      let sellData = utils.defaultAbiCoder.encode(
        ['address', 'address[]', 'uint256'],
        [router, sell_path, sellAmountOutMin]
      );

      return {
        buyData,
        sellData,
      };
    } catch (error: any) {
      throw new Error(error);
    }
  };

  buyTx = async (
    router: string,
    path: string[],
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    overloads: {
      gasLimit?: number | string;
      nonce?: number;
      gasPrice?: BigNumber;
    } = {}
  ): Promise<{
    success: boolean;
    hash?: string;
    msg?: string;
  }> => {
    try {
      console.log('EXECUTING BUY TRANSACTION', new Date().toISOString());
      // BUY OPERATION
      const rawTxns: Bytes[] = [];
      
      // create submarine contract for buy tx
      let { signedRawTx } = await this.createSubmarineContract(
        router,
        amountIn,
        amountOutMin,
        path,
        "BUY",
        overloads
      );
      // const predictedBuySubAddress = predictedSubAddress
      // Return if create submarine contract failed
      // if (!success) {
      //   return {
      //     success,
      //     hash
      //   }
      // }

      // check actual submarine address matches the predicted address
      const matched = await this.checkSubmarineAddressWithPredictedAddress(predictedBuySubAddress);
      // Return if mismatch
      if (!matched) {
        return {
          success: false,
          msg: "Actual buy submarine address mismatch with predicted address!",
        };
      };
      // send funds to submarine address
      let [targetFromToken, targetToToken] = await fetchTokenData(
        this._provider,
        [path[0], path[path.length - 1]]
      );

      let res = await this.sendTokenstoSubmarine(
        targetFromToken.address,
        predictedBuySubAddress,
        amountIn);
      if (!success) {
        return {
          success: res.success,
          hash: res.hash,
          msg: "Failed to transfer funds to buy submarine contract"
        }
      };

      // check funds balance in submarine address
      let status = this.checkSubmarineFunded(targetFromToken.address, predictedBuySubAddress, amountIn);
      if (!status) {
        return {
          success: false,
          msg: "Buy Submarine contract balance mismatch with amountIn"
        }
      }

      // reveal buy tx 
      const reveal_res = await this.revealBuyTransaction(
        router,
        amountIn,
        amountOutMin,
        path,
        predictedBuySubAddress, 
        overloads);
      
      // check balance after reveal buy tx 
      if (!reveal_res.success) {
        return reveal_res;
      }
      
      return {
        success: reveal_res.success,
        hash: reveal_res.hash,
      };
    } catch (error: any) {
      let msg = parseError(error);

      return {
        success: false,
        msg,
      };
    }

  };

  sellTx = async (
    router: string,
    path: string[],
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    overloads: {
      gasLimit?: number | string;
      nonce?: number;
      gasPrice?: BigNumber;
    } = {}
  ): Promise<{
    success: boolean;
    msg?: string;
    hash?: string;
  }> => {
    try {
      console.log('EXECUTING SELL TRANSACTION', new Date().toISOString());
      // SELL OPERATION
      // create submarine contract for sell tx
      let { success, predictedSubAddress, hash } = await this.createSubmarineContract(
        router,
        amountIn,
        amountOutMin,
        path,
        "SELL",
        overloads
      );

      // Return if create submarine contract failed
      if (!success) {
        return {
          success,
          hash,
          msg: "Failed to create submarine contract for sell operation!"
        }
      }
      const predictedSellSubAddress = predictedSubAddress;
      // check actual submarine address matches the predicted address
      const matched = await this.checkSubmarineAddressWithPredictedAddress(predictedSellSubAddress);
      // Return if mismatch
      if (!matched) {
        return {
          success: false,
          msg: "Actual sell submarine address mismatch with predicted address!",
        };
      };
      // send funds to submarine address
      let [targetFromToken, targetToToken] = await fetchTokenData(
        this._provider,
        [path[0], path[path.length - 1]]
      );

      let res = await this.sendTokenstoSubmarine(
        targetFromToken.address,
        predictedSellSubAddress,
        amountIn);
      if (!success) {
        return {
          success: res.success,
          hash: res.hash,
          msg: "Failed to transfer funds to sell submarine contract"
        }
      };

      // check funds balance in submarine address
      let status = this.checkSubmarineFunded(targetFromToken.address, predictedSellSubAddress, amountIn);
      if (!status) {
        return {
          success: false,
          msg: "Sell Submarine contract balance mismatch with amountIn"
        }
      }

      // reveal sell tx 
      const reveal_res = await this.revealSellTransaction(
        router,
        amountOutMin,
        path,
        predictedSellSubAddress, 
        overloads);
      
      // check balance after reveal sell tx 
      if (!reveal_res.success) {
        return reveal_res;
      }

      return {
        success: true,
        hash,
      };
    } catch (error: any) {
      console.error(error);
      let msg = parseError(error);
      return {
        success: false,
        msg,
      };
    }
  };

  #calcProfit = (params: {
    amountIn: BigNumber;
    targetAmountIn: BigNumber;
    reserve0: BigNumber;
    reserve1: BigNumber;
    targetAmountOutMin: BigNumber;
  }): {
    rawProfit: BigNumber;
  } => {
    let { reserve0, reserve1, amountIn, targetAmountIn, targetAmountOutMin } =
      params;

    try {
      let states = calcSandwichStates(
        targetAmountIn,
        targetAmountOutMin,
        reserve0, // Native Token
        reserve1, // Token
        amountIn
      );

      if (!states) {
        throw new Error('Invalid states');
      }

      let rawProfit = states.backrunState.amountOut.sub(amountIn);

      return {
        rawProfit,
      };
    } catch (error: any) {
      console.error({ error });
      error = parseError(error);
      return {
        rawProfit: BigNumber.from(0),
      };
    }
  };

  #isProfitable = async (params: {}): Promise<boolean> => {
    // msg: `Token ${token.symbol}, ${token.address} is not profitable, ${error}`,

    return true;
  };

  // Construct Salt for buy function 
  // Use anything you want for the salt
  // Here we are using the router, amountIn, amountOutMin, path, and uniqueInt
  // The uniqueInt should be incremented each time so that no two addresses are alike
  constructSalt = async (
    router: string,
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    path: string[],
    method: string,
    uniqueInt: number) => {
    const abiSalt = ethers.utils.defaultAbiCoder;
    let params = "";
    if (method == "BUY") {
       params = abiSalt.encode(
        ["address", "uint256", "uint256", "address[]", "uint"],
        [router,
          amountIn,
          amountOutMin,
          path,
          uniqueInt
        ]
      );
  
    } else if(method == "SELL") {
       params = abiSalt.encode(
        ["address","address[]","uint256","uint"],
        [ router,
          path,
          amountOutMin,
          uniqueInt
        ]
      );  
    }
    
    // Convert array to salt format
    const salt = keccak256(params);

    // Return salt
    return salt;
  };

  // Create Submarine Contract
  createSubmarineContract = async (
    router: string,
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    path: string[],
    method: string,
    overloads: {
      gasLimit?: number | string;
      nonce?: number;
      gasPrice?: BigNumber;
    } = {}) => {
    console.log("");
    console.log(`Creating Submarine contract for buy transaction...`);

    // Get salt
    const buy_salt = await this.constructSalt(
      router,
      amountIn,
      amountOutMin,
      path,
      method,
      this.uniqueInt
    );
    console.log("buy_salt (Used again in Step 4): ", buy_salt);

    // Show computed address for buy transaction
    const predictedSubAddress = await this.contract.getPredictedSubAddress(
      buy_salt,
      this.signer.address
    );
    console.log("Submarine predicted buy address: ", predictedSubAddress);

    // Create submarine contract for buy function with the owner as sender

    const contractCreateUnsignedTx = await this.contract.populateTransaction.createSubContract(
      buy_salt,
      this.signer.address, overloads
    );

    console.log("Create submarine address tx: ", contractCreateUnsignedTx);
    const signedRawTx = await this.signer.signTransaction(contractCreateUnsignedTx);
    return {signedRawTx};
    // Print out submarine transaction receipt
    // const txReceipt = await this._provider.getTransaction(contractCreateTx.hash);
    // console.log("Submarine buy contract creation TX Hash: ", txReceipt.hash);

    // Print transaction
    // console.log(txReceipt);

    // return response based on transaction status
    // if (txReceipt && txReceipt.blockNumber) {
    //   return {
    //     success: true,
    //     hash: contractCreateTx.hash,
    //     predictedSubAddress: predictedSubAddress
    //   };
    // }
    // else {
    //   return {
    //     success: false,
    //     hash: contractCreateTx.hash,
    //     predictedSubAddress
    //   }
    // }
  };

  checkSubmarineAddressWithPredictedAddress = async (predSubAddress: string) => {
    console.log("");
    console.log("Checking Submarine contracts...");

    // Show actual address
    const actualSubAddr = await this.contract.getActualSubAddress();
    console.log("Submarine actual address: ", actualSubAddr);
    console.log("Submarine predicted address: ", predSubAddress);


    // Conclude addresses are same
    if (predSubAddress === actualSubAddr) {
      console.log("Submarine actual vs predicted: Exact Match:-)");
      return true;
    } else {
      console.error("ERROR");
      console.error(
        "Check your salt inputs match what you expect for everything"
      );
      return false;
    }
  };

  // Send Tokens(fromTokens) to Submarine Contract
  sendTokenstoSubmarine = async (
    fromToken: string,
    submarineAddress: string,
    amountWei: BigNumber,
    overloads: {
      gasLimit?: number | string;
      nonce?: number;
      gasPrice?: BigNumber;
    } = {}) => {
    console.log("");
    console.log("Sending funds to Submarine contract...");

    const rawTxns: Bytes[] = [];
    // Connect to token Contract
    const humanReadableAbi = [
      "function balanceOf(address owner) view returns (uint balance)",
      "function approve(address spender, uint256 amount) external returns (bool)",
      "function transfer(address recipient, uint256 amount) external returns (bool)"
    ];
    const tokenContract = new ethers.Contract(fromToken!, humanReadableAbi, this.signer);

    // Show current Submarine Contract balance
    const submarineBalance = ethers.utils.formatEther(
      await tokenContract.balanceOf(submarineAddress)
    );

    console.log("Initial fromToken balance in Submarine contract: ", submarineBalance);

    // Allow submarine contract to spend tokens on owner's behalf
    let unsignedRawTx = await tokenContract.populateTransaction.approve(submarineAddress, amountWei, overloads);
    let signedRawTx = await this.signer.signTransaction(unsignedRawTx);
    let signedRawTxBytes = web3.utils.hexToBytes(signedRawTx);
    rawTxns.push(signedRawTxBytes);

    // Send tokens to Submarine contract
    unsignedRawTx = await tokenContract.populateTransaction.transfer(submarineAddress, amountWei, overloads);
    signedRawTx = await this.signer.signTransaction(unsignedRawTx);
    signedRawTxBytes = web3.utils.hexToBytes(signedRawTx);
    rawTxns.push(signedRawTxBytes);
    // Print out submarine transaction receipt
    // const txReceipt = await this._provider.getTransaction(txSend.hash);
    // console.log("Transfer to submarine contract TX Hash: ", txReceipt.hash);


    // Print transaction
    // console.log(txReceipt);

    // return response based on transaction status
    // if (txReceipt && txReceipt.blockNumber) {
    //   return {
    //     success: true,
    //     hash: txSend.hash
    //   };
    // }
    // else {
    //   return {
    //     success: false,
    //     hash: txSend.hash
    //   }
    // }
    return { rawTxns};
  };

  // Check Submarine is Funded
  checkSubmarineFunded = async (fromToken: string, submarineAddress: string, amountInWei: BigNumber) => {
    console.log("");
    console.log("Checking fromToken funds in Submarine contract...");

    // Connect to token Contract
    const humanReadableAbi = [
      "function balanceOf(address owner) view returns (uint balance)",
    ];
    const tokenContract = new ethers.Contract(fromToken!, humanReadableAbi, this.signer);

    // Show balance of submarine transaction
    const balance = await tokenContract.balanceOf(submarineAddress)
    const humanBalance = ethers.utils.formatEther(balance);
    console.log("Current balance of fromToken in Submarine contract: ", humanBalance);
    console.log("");
    if (balance == amountInWei) {
      return true;
    } else return false;
  };

  // Define construct salt again (as exports not working in hardhat with run)
  constructSaltforReveal = async (
    router: string,
    amountOutMin: BigNumber,
    path: string[],
    uniqueInt: number,
    amountIn?: BigNumber) => {
    const abiSalt = ethers.utils.defaultAbiCoder;

    const params = abiSalt.encode(
      ["address", "uint256", "uint256", "address[]", "uint"],
      [router,
        amountIn,
        amountOutMin,
        path,
        uniqueInt
      ]
    );
    const salt = keccak256(params);
    return salt;
  };

  // Define construct salt again (as exports not working in hardhat with run)
  constructDataforReveal = async (
    router: string,
    path: string[],
    amountOutMin: BigNumber,
    amountIn?: BigNumber) => {
    const abiSalt = ethers.utils.defaultAbiCoder;
    const encoded_params = abiSalt.encode(
      ["address", "uint256", "uint256", "address[]"],
      [router,
        amountIn,
        amountOutMin,
        path
      ]
    );
    return encoded_params;
  };


  // Reveal buy operation
  revealBuyTransaction = async (
    router: string,
    amountIn: BigNumber,
    amountOutMin: BigNumber,
    path: string[],
    submarineAddress: string,
    overloads: {
      gasLimit?: number | string;
      nonce?: number;
      gasPrice?: BigNumber;
    } = {}) => {
    console.log("");
    console.log("Performing reveal buy transaction...");

    const rawTxns: Bytes[] = [];
    // Build Salt
    const salt = await this.constructSaltforReveal(
      router,
      amountOutMin,
      path,
      this.uniqueInt,
      amountIn);
    console.log("salt: ", salt);

    // Build encoded param
    const _data = await this.constructDataforReveal(
      router,
      path,
      amountOutMin,
      amountIn);
    console.log("_data: ", _data);

    // Connect to token Contract
    const humanReadableAbi = [
      "function balanceOf(address owner) view returns (uint balance)",
    ];
    const tokenContract = new ethers.Contract(path[0]!, humanReadableAbi, this.signer);

    // Show token balance of sender
    const signerBalance = await tokenContract.balanceOf(this.signer.address);
    const humanSignerBal = ethers.utils.formatEther(signerBalance);
    console.log("Sender current token balance: ", humanSignerBal);

    // Guard: Check address matches
    const subAddress = await this.revealContract.getSubmarineAddress(salt);
    if (subAddress !== submarineAddress) {
      console.error("Submarine address mismatch. Check inputs in the ByteArray.");
      return {
        success: false,
        msg: "Submarine address mismatch. Check inputs in the ByteArray."
      };
    }
    console.log("subAddress: ", subAddress);


    // Execute swap
    let unsignedRawTx = await this.revealContract.populateTransaction.revealBuyExecution(
      salt,
      _data,
      overloads
    );
    let signedRawTx = await this.signer.signTransaction(unsignedRawTx);
    let signedRawTxBytes = web3.utils.hexToBytes(signedRawTx);
    rawTxns.push(signedRawTxBytes);

    // Print out submarine transaction receipt
    // const txReceipt = await this._provider.getTransaction(revealTx.hash);
    // console.log("Reveal buy transaction Hash: ", txReceipt.hash);


    // Print transaction
    // console.log(txReceipt);

    // return response based on transaction status
    // if (txReceipt && txReceipt.blockNumber) {
    //   return {
    //     success: true,
    //     hash: revealTx.hash,
    //     msg: "Buy transaction completed successfully."
    //   };
    // }else {
    //   return {
    //     success: false,
    //     hash: revealTx.hash,
    //     msg: "Buy transaction failed to reveal."
    //   }
    // }

    return { rawTxns };
  };

  // Reveal Sell operation
  revealSellTransaction = async (router: string,
    amountOutMin: BigNumber,
    path: string[],
    submarineAddress: string,
    overloads: {
      gasLimit?: number | string;
      nonce?: number;
      gasPrice?: BigNumber;
    } = {}) => {
  console.log("");
  console.log("Performing reveal sell transaction...");
  const rawTxns: Bytes[] = [];
  // Build Salt
  const sell_salt = await this.constructSaltforReveal(
    router,
    amountOutMin,
    path,
    this.uniqueInt);
  console.log("sell_salt: ", sell_salt);

  // Build encoded param
  const _data = await this.constructDataforReveal(
    router,
    path,
    amountOutMin
    );
  console.log("_data: ", _data);

  // Connect to token Contract
  const humanReadableAbi = [
    "function balanceOf(address owner) view returns (uint balance)",
  ];
  const tokenContract = new ethers.Contract(path[0]!, humanReadableAbi, this.signer);

  // Show token balance of sender
  const signerBalance = await tokenContract.balanceOf(this.signer.address);
  const humanSignerBal = ethers.utils.formatEther(signerBalance);
  console.log("Sender current token balance: ", humanSignerBal);

  // Guard: Check address matches
  const subAddress = await this.revealContract.getSubmarineAddress(sell_salt);
  if (subAddress !== submarineAddress) {
    console.error("Submarine address mismatch. Check inputs in the ByteArray.");
    return {
      success: false,
      msg: "Submarine address mismatch. Check inputs in the ByteArray."
    };
  }
  console.log("subAddress: ", subAddress);


  // Execute reveal
  let unsignedRawTx = await this.revealContract.revealSellExecution(
    sell_salt,
    _data, 
    overloads
  );
  let signedRawTx = await this.signer.signTransaction(unsignedRawTx);
  let signedRawTxBytes = web3.utils.hexToBytes(signedRawTx);
  rawTxns.push(signedRawTxBytes);
  // console.log("Reveal transaction hash: ", revealTx.hash);

  // Print out submarine transaction receipt
  // const txReceipt = await this._provider.getTransaction(revealTx.hash);
  // console.log("Reveal buy transaction Hash: ", txReceipt.hash);


  // Print transaction
  // console.log(txReceipt);

  // // return response based on transaction status
  // if (txReceipt && txReceipt.blockNumber) {
  //   return {
  //     success: true,
  //     hash: revealTx.hash,
  //     msg: "Sell transaction completed successfully."
  //   };
  // }else {
  //   return {
  //     success: false,
  //     hash: revealTx.hash,
  //     msg: "Sell transaction failed to reveal."
  //   }
  // }
  return { rawTxns };
};

}

export const sandwicher = new Sandwicher();
