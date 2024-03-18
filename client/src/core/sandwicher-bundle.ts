import {
  BigNumber,
  Contract,
  ethers,
  providers,
  utils,
  Wallet,
} from 'ethers';
const Common = require("@ethereumjs/common").default;
import { config } from '../config';
import {
  encodeFunctionCall,
  PancakePairContract,
} from '../helpers';
const {
  FeeMarketEIP1559Transaction,
  AccessListEIP2930Transaction,
  Transaction
} = require("@ethereumjs/tx");
import { IPancakePair_ABI, ROUTER_ABI } from '../constants';
import { parseUnits } from "@ethersproject/units";
import fetch from "node-fetch";
import { eth } from 'web3';
import { fetchTokenData, getTokenBalance } from '../helpers/token';
import { Token } from '../types/token';

let wallet: ethers.Wallet;
let wsProvider: ethers.providers.WebSocketProvider;
const IPancakeRouter02 = new utils.Interface(ROUTER_ABI);
let rpcProvider: ethers.providers.JsonRpcProvider;
let router: string;
let routerContract: Contract;
let factoryContract: Contract;
const BN_18 = parseUnits("1");

const initializeProviders = () => {
  rpcProvider = new providers.JsonRpcProvider(config.JSON_RPC);
  wsProvider = new ethers.providers.WebSocketProvider(config.WSS_URL);
};

/**
 * Monitor mempool for transactions
 */
export const monitor = async (hash: string) => {
  if (!wsProvider) {
    initializeProviders();
  }

  // implement mempool monitoring
  rpcProvider = new providers.JsonRpcProvider(config.JSON_RPC);
  wallet = new Wallet(config.PRIVATE_KEY, rpcProvider);

  try {

    // Get tx data
    const [tx, receipt] = await Promise.all([
      wsProvider.getTransaction(hash),
      wsProvider.getTransactionReceipt(hash)
    ])
    // Sometimes tx is null for some reason
    if (tx === null) {
      console.log("transaction is empty.")
      return;
    }

    // Make sure transaction hasn't been mined
    if (receipt !== null) {
      console.log("transaction is already mined.")
      return;
    }
    // Make sure we are listening to this pancake router v2 address
    if (tx.to != config.PANCAKE_ROUTER_ADDRESS) {
      return;
    }

    // process tx
    tx && await process(tx, wallet);
  } catch (error) {
    console.error(error);
  }
};
const noTaxTokens = ["0xToken1", "0xToken2", /* add more tokens as needed */];

// Initialize providers
initializeProviders();

// Define the function to initiate the sandwich attack
const initiateSandwichAttack = async () => {
  try {
    // Get a list of transactions from the mempool
    const pendingTransactions = await wsProvider.send('eth_pendingTransactions', []);

    // Filter transactions based on your criteria
    const suitableTransaction = pendingTransactions.find((tx: any) => {
      // Add your custom criteria to identify a suitable transaction for the sandwich attack
      const isGoingToPancakeRouter = tx.to === config.PANCAKE_ROUTER_ADDRESS;

      // Add your additional criteria here...
      // For example, you can check if the token is a "no tax" token
      const isNoTaxToken = noTaxTokens.includes(tx.to.toLowerCase());

      return isGoingToPancakeRouter && isNoTaxToken;
    });

    if (suitableTransaction) {

      // If a suitable transaction is found, initiate the sandwich attack
      await monitor(suitableTransaction.hash);
    }
  } catch (error) {
    console.error("Error initiating sandwich attack:", error);
  }
};
/**
 * Process transactions
 * @note: this is where the magic happens
 * # slippage check
 * # calc optimal amount In
 * # rug check
 * # profitablity check
 * @param tx - transaction
 */

const process = async (tx: ethers.providers.TransactionResponse, wallet: Wallet) => {
  // tx data
  let {
    value,
    to,
    gasPrice,
    gasLimit,
    hash,
    from,
    data,
  } = tx;


  router = to!;

  const tx_data = IPancakeRouter02.parseTransaction({
    data,
  });

  // Basically means its not swapExactETHForToken and you need to add
  // other possibilities
  if (tx_data === null) {
    return;
  }

  // get function name and arguments from transaction data
  let { args, name: targetMethodName } = tx_data;

  if (targetMethodName.startsWith("swapExactETHFor") || targetMethodName.startsWith(
    'swapExactTokensForTokensSupportingFeeOnTransferTokens'
  )) {
    console.log("targetMethodName: ", targetMethodName);
  } else {
    return null;
  }
  // get values from arguments
  let {
    amountOutMin: targetAmountOutMin,
    path,
    deadline,
  } = args;

  if (!path) return;

  // If tx deadline has passed, just ignore it
  // As we cannot sandwich it
  if (new Date().getTime() / 1000 > deadline) {
    return;
  }
  let [targetFromToken, targetToToken] = await fetchTokenData(
    rpcProvider,
    [path[0], path[path.length - 1]]
  );
  // ensure target is buying with wbnb or bnb
  if (
    targetFromToken.address.trim().toLowerCase() !=
    config.WBNB_ADDRESS.trim().toLowerCase()
  ) {
    console.info(
      `Skipping: Target is buying with ${targetFromToken}`,
      {
        hash,
        targetMethodName,
      },
      '\n'
    );
    return;
  }
 
  // Get the min recv for token directly after WETH

  routerContract = new Contract(
    router,
    [
      'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
      'function factory() external pure returns (address)'
    ],
    rpcProvider
  );

  factoryContract = new Contract(
    await routerContract.factory(),
    [
      'function getPair(address tokenA, address tokenB) external view returns (address pair)',
    ],
    rpcProvider
  );
  console.log("value1: ", value); 
  
  console.log("targetAmountOutMin: ", targetAmountOutMin);  
  // get current execution price
  let amounts = await routerContract.getAmountsOut(value, path);
  let executionPrice = amounts[amounts.length - 1];
  console.log("value2: ", value);

   // calc target slippage
   let { slippage: targetSlippage } =  calcSlippage({
    executionPrice,
    targetAmountOutMin,
    targetMethodName,
  });

  if (
    targetSlippage <
    config.MIN_SLIPPAGE_THRESHOLD / 100 //~ 1%
  ) {
    console.log(
      `Skipping: Tx ${hash} Target slippage ${parseFloat(
        (targetSlippage * 100).toFixed(4)
      )} is < ${config.MIN_SLIPPAGE_THRESHOLD}%`
    );
    return;
  }

  // const amountOutMin = await getPancake2ExactFromTokenMinRecv(amountOutMin, path);
  // console.log("amountOutMin: ", amountOutMin, amountOutMin, path);
  // const userAmountIn = value;

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

  const pairAddress = getPairAddress(targetFromToken.address, targetToToken.address);
  // get reserves
  const [reserveFromToken, reserveToToken] = await getReserves(
    pairAddress
  );
  console.log("reserveFromToken: ", reserveFromToken);
  console.log("reserveToToken: ", reserveToToken);
  
  let fmtTargetAmountIn = parseFloat(
    utils.formatUnits(value, targetFromToken.decimals)
  );
  let amountIn = calcOptimalAmountIn({
    targetAmountIn: fmtTargetAmountIn,
    targetAmountOutMin: amountOut,
    targetFromToken,
    reserve0: parseFloat(
      utils.formatUnits(reserveFromToken, targetFromToken.decimals)
    ),
    reserve1: parseFloat(
      utils.formatUnits(reserveToToken, targetToToken.decimals)
    ),
  });

  let tokenBalance = await getTokenBalance(
    rpcProvider,
    targetFromToken.address,
    wallet.address
  );

  // if amountIn is greater than token balance, just ignore it
  if (amountIn.gt(tokenBalance)) {
    console.log(
      `Skipping: Attack amount ${utils.formatUnits(
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
      `Skipping: attack amount is <= 0, Token: ${targetToToken.symbol}`
    );
    return;
  }
  let amountOutMin = await routerContract.getAmountsOut(
    path,
    amountIn
  );

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

 
  
  // const optimalWethIn = calcSandwichOptimalIn(
  //   userAmountIn,
  //   amountOutMin,
  //   reserveFromToken,
  //   reserveToToken
  // );
  // console.log("optimalWethIn: ", optimalWethIn);

  // nothing to sandwich!
  // if (optimalWethIn.lte(ethers.constants.Zero)) {
  //   console.log("optimalWethIn.lte(ethers.constants.Zero): ", optimalWethIn.lte(ethers.constants.Zero))
  //   return;
  // }

  // Contains 4 states:
  // 1: Bribe state
  // 2: Frontrun state
  // 3: Victim state
  // 4: Backrun state
  const sandwichStates = await calcSandwichState(
    amountIn,
    value,
    amountOutMin,
    reserveFromToken,
    reserveToToken
  );
  console.log("sandwichStates: ", sandwichStates);

  // Sanity check failed
  if (sandwichStates === null) {
    console.log(
      "sandwich sanity check failed",
      JSON.stringify({
        amountIn,
        reserveToToken,
        reserveFromToken,
        value,
        amountOutMin,
      })
    );
    return;
  }

  // Cool profitable sandwich :)
  // But will it be post gas?
  console.log(
    "sandwichable target found",
    JSON.stringify(stringifyBN(sandwichStates))
  );

  // Get block data to compute bribes etc
  // as bribes calculation has correlation with gasUsed
  // const blockNumber = await wsProvider.getBlockNumber();
  // console.log("blockNumber: ", blockNumber);
  const block = await wsProvider.getBlock('latest');
  const targetBlockNumber = block.number + 1;
  const nextBaseFee = calcNextBlockBaseFee(block);
  console.log("nextBaseFee: ", nextBaseFee);
  const nonce = await wsProvider.getTransactionCount(wallet.address);
  console.log("nonce: ", nonce);

  // self transfer
  const bribeGasPrice = ethers.utils.parseUnits('60', 'gwei');
  console.log("bribeGasPrice: ", bribeGasPrice);

  const bribeTx = {
    to: wallet.address,
    value: ethers.utils.parseEther('0.000001'), // 60 gwei * 21000 gas limit
    gasPrice: bribeGasPrice,
    nonce: nonce + 1, // Nonce+1 for backrun
  };
  console.log("bribeTx: ", bribeTx);

  // front-run the victim txn

  // fee array = each value relates to equivalent index in pairPath array, (feeArray[0] is the fee associated with pairPath[0]). 
  // Values are represented by multiplying the percentage fee by 100 - therefore pancakeSwapV2 fee of 0.25% becomes 25 - expressed as number
  //example: [pancakeSwap (0.2%), apeSwap (0.2%), pancakeSwapV2 (0.25%)]
  const feeArray = [20, 20, 25];

  const frontslicePayload: string = await encodeFunctionCall(amountIn, sandwichStates.frontrun.amountOut, path, pairAddress, feeArray, wallet.address, deadline);

  console.log("frontslicePayload: ", frontslicePayload);

  const frontsliceTx = {
    type: 2,
    to: config.VSWAP_CONTRACT_ADDRESS,
    from: wallet.address,
    data: frontslicePayload,
    //maxPriorityFeePerGas: 200e9,
    //maxFeePerGas: 2e9,
    gasLimit: 250000,
    nonce: nonce + 2
  };
  console.log("frontsliceTx: ", frontsliceTx);

  const frontsliceTxSigned = await wallet.signTransaction(frontsliceTx);
  console.log("frontsliceTxSigned: ", frontsliceTxSigned);

  // execute victim txn
  // const victimTx = getRawTransaction(tx);

  const victimTx = getRawTransaction(tx);
  console.log("victimTx: ", victimTx);

  const backslicePayload = await encodeFunctionCall(amountIn, sandwichStates.backrun.amountOut, path, pairAddress, feeArray, wallet.address, deadline);
  console.log("backslicePayload: ", backslicePayload);

  const backsliceTx = {
    to: config.VSWAP_CONTRACT_ADDRESS,
    from: wallet.address,
    data: backslicePayload,
    //maxPriorityFeePerGas: 200e9,
    //maxFeePerGas: 2e9,
    gasLimit: 250000,
    nonce: nonce + 4,
    type: 2,
  };
  console.log("backsliceTx: ", backsliceTx);

  const backsliceTxSigned = await wallet.signTransaction(backsliceTx);
  console.log("backsliceTxSigned: ", backsliceTxSigned);

  const singnedTxns = [bribeTx, frontsliceTxSigned, victimTx, backsliceTxSigned];
  console.log("singnedTxns: ", singnedTxns);
  const puissantResponse = await sendBundleToPuissant(singnedTxns, nonce);
  console.log("puissantResponse: ", puissantResponse);
  return puissantResponse;

};
const getReserves = async (pairAddress: string) => {

  let pairContract: Contract = new Contract(
    pairAddress,
    [
      'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
      `function token0() external view returns (address)`,
    ],
    rpcProvider
  );

  let [reserve0, reserve1] = await pairContract.getReserves();

  return [
    reserve0,
    reserve1
  ];
};


const connectToPuissant = async (): Promise<ethers.providers.JsonRpcProvider> => {
  try {
    const puissantProvider = new ethers.providers.JsonRpcProvider(config.PUISSANT_RPC_URL);
    await puissantProvider.getNetwork();
    return puissantProvider;
  } catch (error: any) {
    console.error('Error connecting to Puissant API:', error.message);
    throw error;
  }
}

const sendBundleToPuissant = async (signedTxns: any, id: number): Promise<string> => {
  try {
    const apiUrl = config.PUISSANT_API_URL;
    const headers = {
      'Content-Type': 'application/json',
    };

    const body = {
      id,
      jsonrpc: "2.0",
      method: "eth_sendPrivateRawTransaction",
      params: signedTxns
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }

    const responseData = await response.json();
    return responseData.result || 'Bundle sent successfully!';
  } catch (error: any) {
    console.error('Error sending bundle to Puissant API:', error.message);
    throw error;
  }
}

/*
Computes pair addresses off-chain
*/
// export const getPancake2PairAddress = (tokenA: string, tokenB: string) => {
//   const [token0, token1] = sortTokens(tokenA, tokenB);

//   const salt = ethers.utils.keccak256(token0 + token1.replace("0x", ""));
//   const address = ethers.utils.getCreate2Address(
//     "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", // Factory address (contract creator)
//     salt,
//     "0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5" // init code hash
//   );

//   return address;
// };

/* 
Sorts tokens
*/
export const sortTokens = (tokenA: string, tokenB: string) => {
  if (ethers.BigNumber.from(tokenA).lt(ethers.BigNumber.from(tokenB))) {
    return [tokenA, tokenB];
  }
  return [tokenB, tokenA];
};
/*
 Uniswap v2; x * y = k formula

 How much out do we get if we supply in?
*/
export const getPancake2DataGiveIn = (amountIn: any, reserveA: any, reserveB: any) => {
  const amountInWithFee = amountIn.mul(997);
  const numerator = amountInWithFee.mul(reserveB);
  const denominator = amountInWithFee.add(reserveA.mul(1000));
  const bOut = numerator.div(denominator);

  // Underflow
  let newReserveB = reserveB.sub(bOut);
  if (newReserveB.lt(0) || newReserveB.gt(reserveB)) {
    newReserveB = ethers.BigNumber.from(1);
  }

  // Overflow
  let newReserveA = reserveA.add(amountIn);
  if (newReserveA.lt(reserveA)) {
    newReserveA = ethers.constants.MaxInt256;
  }

  return {
    amountOut: bOut,
    newReserveA,
    newReserveB,
  };
};

export const calcSandwichState = async (
  amountIn: any,
  value: any,
  amountOutMin: any,
  reserveFromToken: any,
  reserveToToken: any
) => {
  // Note that user is going from WETH -> TOKEN
  // So, we'll be pushing the price of TOKEn
  // by swapping WETH -> TOKEN before the user
  // i.e. Ideal tx placement:
  // 1. (Ours) WETH -> TOKEN (pushes up price)
  // 2. (Victim) WETH -> TOKEN (pushes up price more)
  // 3. (Ours) TOKEN -> WETH (sells TOKEN for slight WETH profit)
  const frontrunState = await routerContract.getAmountOut(
    amountIn,
    reserveFromToken,
    reserveToToken
  );

  const victimState = await routerContract.getAmountOut(
    value,
    frontrunState.newReserveA,
    frontrunState.newReserveB
  );
  const backrunState = await routerContract.getAmountOut(
    frontrunState.amountOut,
    victimState.newReserveB,
    victimState.newReserveA
  );

  // Sanity check
  if (victimState.amountOut.lt(amountOutMin)) {
    console.log("victim amountOut is less than amountOutMin");
    return null;
  }
  // Return
  return {
    // NOT PROFIT
    // Profit = post gas
    revenue: backrunState.amountOut.sub(amountIn),
    amountIn,
    userAmountIn: value,
    amountOutMin,
    reserveState: {
      reserveFromToken,
      reserveToToken,
    },
    frontrun: frontrunState,
    victim: victimState,
    backrun: backrunState,
  };
};

export const calcNextBlockBaseFee = (curBlock: ethers.providers.Block) => {
  const baseFee = curBlock.baseFeePerGas || ethers.constants.Zero; // Use Zero if baseFeePerGas is undefined
  const gasUsed = curBlock.gasUsed;
  const targetGasUsed = curBlock.gasLimit.div(2);
  const delta = gasUsed.sub(targetGasUsed);

  const newBaseFee = baseFee.add(
    baseFee.mul(delta).div(targetGasUsed).div(ethers.BigNumber.from(8))
  );

  // Add 0-9 wei so it becomes a different hash each time
  const rand = Math.floor(Math.random() * 10);
  return newBaseFee.add(rand);
};

/*
  Calculate the max sandwich amount
*/
// export const calcSandwichOptimalIn = (
//   amountIn: any,
//   userMinRecvToken: any,
//   fromTokenReserve: any,
//   toTokenReserve: any
// ) => {
//   // Check if userMinRecvToken is undefined or null
//   if (!userMinRecvToken || userMinRecvToken.isZero()) {
//     // Handle this case accordingly, e.g., set a default value or return early
//     return ethers.constants.Zero;
//   }
//   // Note that user is going from WETH -> TOKEN
//   // So, we'll be pushing the price of TOKEn
//   // by swapping WETH -> TOKEN before the user
//   // i.e. Ideal tx placement:
//   // 1. (Ours) WETH -> TOKEN (pushes up price)
//   // 2. (Victim) WETH -> TOKEN (pushes up price more)
//   // 3. (Ours) TOKEN -> WETH (sells TOKEN for slight WETH profit)
//   const calcF = (amountIn: any) => {
//     const frontrunState = getPancake2DataGiveIn(
//       amountIn,
//       fromTokenReserve,
//       toTokenReserve
//     );
//     const victimState = getPancake2DataGiveIn(
//       amountIn,
//       frontrunState.newReserveA,
//       frontrunState.newReserveB
//     );
//     return victimState.amountOut;
//   };

//   // Our binary search must pass this function
//   // i.e. User must receive at least min this
//   const passF = (amountOut: any) => amountOut.gte(userMinRecvToken);

//   // Lower bound will be 0
//   // Upper bound will be 100 ETH (hardcoded, or however much ETH you have on hand)
//   // Feel free to optimize and change it
//   // It shouldn't be hardcoded hehe....
//   const lowerBound = parseUnits("0");
//   const upperBound = parseUnits("100");

//   // Optimal WETH in to push reserve to the point where the user
//   // _JUST_ receives their min recv
//   const optimalWethIn = binarySearch(lowerBound, upperBound, calcF, passF);

//   return optimalWethIn;
// };

const calcOptimalAmountIn  = (params: {
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
      calcWorstReserveIn(targetAmountIn, targetAmountOutMin, k) -
      reserve0
    ).toFixed(targetFromToken.decimals),
    targetFromToken.decimals
  );
};

const calcWorstReserveIn = (
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
/*
  Binary search to find optimal sandwichable amount

  Using binary search here as the profit function isn't normally distributed
*/
export const binarySearch = (
  left: BigNumber, // Lower bound
  right: BigNumber, // Upper bound
  calculateF: { (amountIn: any): any; (arg0: any): any; }, // Generic calculate function
  passConditionF: { (amountOut: any): any; (arg0: any): any; }, // Condition checker
  tolerance = parseUnits("0.01") // Tolerable delta (in %, in 18 dec, i.e. parseUnits('0.01') means left and right delta can be 1%)
): any => {
  if (right.sub(left).gt(tolerance.mul(right.add(left).div(2)).div(BN_18))) {
    const mid = right.add(left).div(2);
    const out = calculateF(mid);

    // If we pass the condition
    // Number go up
    if (passConditionF(out)) {
      return binarySearch(mid, right, calculateF, passConditionF, tolerance);
    }

    // Number go down
    return binarySearch(left, mid, calculateF, passConditionF, tolerance);
  }

  // No negatives
  const ret = right.add(left).div(2);
  if (ret.lt(0)) {
    return ethers.constants.Zero;
  }

  return ret;
};

/*
  Given a finalMinRecv BigNumber and a path of tokens (string), compute the
  minRecv immediately after WETH.

  Basically, calculates how much the user is willing to accept as a min output,
  but specifically tailored for the token after WETH.

  We do this as Univ2 router swaps can swap over "paths". In this example, we're only doing
  WETH <> TOKEN sandwiches. Thus, we only care about the minRecv for the path DIRECTLY AFTER WETH
*/
export const getPancake2ExactFromTokenMinRecv = async (amountOutMin: any, path: string | any[]) => {
  // let amountOutMin = amountOutMin;

  // Only works for swapExactETHForTokens

  // Computes lowest amount of token (directly after WETH)
  for (let i = path.length - 1; i > 1; i--) {
    const fromToken = path[i - 1];
    const toToken = path[i];

    const pair = getPairAddress(fromToken, toToken);
    const [reserveFromToken, reserveTo] = await getReserves(
      pair
    );

    const newReserveData = await factoryContract.getAmountOut(
      amountOutMin,
      reserveFromToken,
      reserveTo
    );
    amountOutMin = newReserveData.amountIn;
  }

  return amountOutMin;
};


/*
  Computes pair addresses off-chain
*/
export const getPairAddress = (tokenA: string, tokenB: string) => {
  const [token0, token1] = sortTokens(tokenA, tokenB);

  const salt = ethers.utils.keccak256(token0 + token1.replace("0x", ""));
  const address = ethers.utils.getCreate2Address(
    "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", // Factory address (contract creator)
    salt,
    "0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5" // init code hash
  );

  return address;
};

export const getRawTransaction = (tx: ethers.providers.TransactionResponse) => {
  let raw;
  let txData = stringifyBN(tx, true);

  const common = new Common({ chainId: 56 });

  if (tx.type === null || tx.type === 0) {
    raw =
      "0x" +
      Transaction.fromTxData(txData, { common }).serialize().toString("hex");
  } else if (tx.type === 1) {
    raw =
      "0x" +
      AccessListEIP2930Transaction.fromTxData(txData, { common })
        .serialize()
        .toString("hex");
  } else if (tx.type === 2) {
    raw =
      "0x" +
      FeeMarketEIP1559Transaction.fromTxData(txData, { common })
        .serialize()
        .toString("hex");
  } else {
    throw new Error("Invalid tx type");
  }

  if (ethers.utils.keccak256(raw) !== tx.hash) {
    throw new Error("Invalid tx signature");
  }

  return raw;
};

// JSON.stringify from ethers.BigNumber is pretty horrendous
// So we have a custom stringify functino
export const stringifyBN = (o: any, toHex = false): any => {
  if (o === null || o === undefined) {
    return o;
  } else if (typeof o == "bigint" || o.eq !== undefined) {
    if (toHex) {
      return o.toHexString();
    }
    return o.toString();
  } else if (Array.isArray(o)) {
    return o.map((x) => stringifyBN(x, toHex));
  } else if (typeof o == "object") {
    const res: any = {};
    const keys = Object.keys(o);
    keys.forEach((k) => {
      res[k] = stringifyBN(o[k], toHex);
    });
    return res;
  } else {
    return o;
  }
};

const calcSlippage = (_params: {
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

// Add this line to the end of your code to initiate the sandwich attack every 2 minutes
setInterval(initiateSandwichAttack, 3000);
