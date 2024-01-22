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
  PancakePairContract,
} from '../helpers';
const {
  FeeMarketEIP1559Transaction,
  AccessListEIP2930Transaction,
  Transaction
} = require("@ethereumjs/tx");
import { ROUTER_ABI } from '../constants';
import { parseUnits } from "@ethersproject/units";
import fetch from "node-fetch";

let wallet: ethers.Wallet;
let wsProvider: ethers.providers.WebSocketProvider;
let puissantProvider;
const IPancakeRouter02 = new utils.Interface(ROUTER_ABI);
let rpcProvider: ethers.providers.JsonRpcProvider;
let router: string;
let routerContract: Contract;
let factoryContract: Contract;
const BN_18 = parseUnits("1");

/**
 *  Monitor mempool for transactions
 */
const monitor = async () => {
  // implement mempool monitoring
  wsProvider = new providers.WebSocketProvider(config.WSS_URL);
  rpcProvider = new providers.JsonRpcProvider(config.JSON_RPC);
  // puissantProvider = await connectToPuissant();
  // wallet = new Wallet(config.PRIVATE_KEY, puissantProvider);
  wallet = new Wallet(config.PRIVATE_KEY, rpcProvider);
  wsProvider.on('pending', async (hash) => {
    try {
      let tx = await wsProvider.getTransaction(hash);
      let receipt = await wsProvider.getTransactionReceipt(hash);

      // Make sure transaction hasn't been mined
      if (receipt !== null) {
        return;
      }
      // Sometimes tx is null for some reason
      if (tx === null) {
        return;
      }
      tx && await process(tx, wallet);
    } catch (error) {
      console.error(error);
    }
  });
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
  const amountIn = value;
  // Get the min recv for token directly after WETH

  routerContract = new Contract(
    router,
    ['function factory() external view returns (address)'],
    rpcProvider
  );

  factoryContract = new Contract(
    await routerContract.factory(),
    [
      'function getPair(address tokenA, address tokenB) external view returns (address pair)',
    ],
    rpcProvider
  );


  // const vSwapContract = new Contract(config.VSWAP_CONTRACT_ADDRESS!,
  //   [
  //     'function vSwap(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address[] calldata pairPath, uint256[] calldata fee, address to, uint256 deadline) external view returns (bool success)'
  //   ],
  //   rpcProvider);

  const tx_data = IPancakeRouter02.parseTransaction({
    data,
  });
  // get function name and arguments from transaction data
  let { args, name } = tx_data;

  // get values from arguments
  let {
    amountOutMin,
    path,
    deadline,
  } = args;


  // If tx deadline has passed, just ignore it
  // As we cannot sandwich it
  if (new Date().getTime() / 1000 > deadline) {
    return;
  }

  let [fromToken, toToken] = path;
  const userMinRecv = await getPancake2ExactFromTokenMinRecv(amountOutMin, path);
  // get reserves
  let reserves = await getReserves(path);
  const [reserveFromToken, reserveToToken] = await getPancake2Reserve(
    reserves.pairAddress,
    fromToken,
    toToken
  );
  // const res = await vSwapContract.vSwap(amountIn, amountOutMin, path, reserves.pairAddress);

  // Get block data to compute bribes etc
  // as bribes calculation has correlation with gasUsed
  const blockNumber = await wsProvider.getBlockNumber();
  const block = await wsProvider.getBlock(blockNumber);
  const targetBlockNumber = blockNumber + 1;
  const nextBaseFee = calcNextBlockBaseFee(block);
  const nonce = await wsProvider.getTransactionCount(wallet.address);

  const victimGasPrice = gasPrice!;
  const frontrunGasPrice = victimGasPrice.add(ethers.utils.parseUnits('1', 'gwei'));
  const backrunGasPrice = victimGasPrice;
  const bribeGasPrice = ethers.utils.parseUnits('60', 'gwei');

  const optimalWethIn = calcSandwichOptimalIn(
    amountIn,
    userMinRecv,
    reserveFromToken,
    reserveToToken
  );

  // Contains 4 states:
  // 1: Bribe state
  // 2: Frontrun state
  // 3: Victim state
  // 4: Backrun state
  const sandwichStates = calcSandwichState(
    optimalWethIn,
    amountIn,
    userMinRecv,
    reserveFromToken,
    reserveToToken
  );

  // Sanity check failed
  if (sandwichStates === null) {
    console.log(
      "sandwich sanity check failed",
      JSON.stringify({
          optimalWethIn,
          reserveToToken,
          reserveFromToken,
          amountIn,
          userMinRecv,
        })
    );
    return;
  }
  // self transfer
  const bribeTx = {
    to: wallet.address,
    value: ethers.utils.parseEther('0.000001'), // 60 gwei * 21000 gas limit
    gasPrice: bribeGasPrice,
    nonce: nonce + 1, // Nonce+1 for backrun
  };

  // front-run the victim txn
  const frontslicePayload = ethers.utils.solidityPack(
    ["uint256", "uint256","address[]", "address[]", "uint256[]","address","uint256"],
    [
      optimalWethIn,
      sandwichStates.frontrun.amountOut,
      path,
      reserves.pairAddress,
      nextBaseFee,
      wallet.address,
      deadline
    ]
  );
  const frontsliceTx = {
    to: config.VSWAP_CONTRACT_ADDRESS,
    from: wallet.address,
    data: frontslicePayload,
    maxPriorityFeePerGas: 0,
    maxFeePerGas: nextBaseFee,
    gasLimit: 250000,
    nonce: nonce + 2
  };
  const frontsliceTxSigned = await wallet.signTransaction(frontsliceTx);

   // execute victim txn
  // const victimTx = getRawTransaction(tx);

  const victimTx = tx;
  
  const backslicePayload = ethers.utils.solidityPack(
    ["uint256", "uint256","address[]", "address[]", "uint256[]","address","uint256"],
    [
      optimalWethIn,
      sandwichStates.backrun.amountOut,
      path,
      reserves.pairAddress,
      nextBaseFee,
      wallet.address,
      deadline
    ]
  );

  const backsliceTx = {
    to: config.VSWAP_CONTRACT_ADDRESS,
    from: wallet.address,
    data: backslicePayload,
    maxPriorityFeePerGas: 0,
    maxFeePerGas: nextBaseFee,
    gasLimit: 250000,
    nonce: nonce + 4,
    // type: 2,
  };
  const backsliceTxSigned = await wallet.signTransaction(backsliceTx);

  const singnedTxns = [bribeTx, frontsliceTxSigned, victimTx, backsliceTxSigned];
  const puissantResponse = await sendBundleToPuissant(singnedTxns, nonce);
  return puissantResponse;

};
const getReserves = async (path: string[]) => {
  let token0 = path[path.length - 2];
  let token1 = path[path.length - 1];
  let pairAddress = await factoryContract.getPair(token0, token1);

  let pairContract: Contract = new Contract(
    pairAddress,
    [
      'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
      `function token0() external view returns (address)`,
    ],
    rpcProvider
  );

  let [reserve0, reserve1] = await pairContract.getReserves();

  let token = await pairContract.token0();
  return {
    reserveBNB: token0 === token ? reserve0 : reserve1,
    reserveToToken: token0 === token ? reserve1 : reserve0,
    pairAddress
  };
};

export const sendPuissantBundle = async ()=> {
  try {
    await monitor();
  } catch (error: any) {
    console.error('Error sending Puissant bundle:', error.message);
    throw error;
  }
}

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

const sendBundleToPuissant = async (signedTxns:any, id: number): Promise<string> => {
  try {
    const apiUrl = config.PUISSANT_API_URL;
    const headers = {
      'Content-Type': 'application/json',
    };

    const body = {
      id,
      jsonrpc: "2.0",
      method: "eth_sendPuissant",
      params: [
        {
          txs: signedTxns,
          maxTimestamp: Date.now() + 60,
          acceptRevert: []
        }
      ]
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
    return responseData.successMessage || responseData.result || 'Bundle sent successfully!';
  } catch (error: any) {
    console.error('Error sending bundle to Puissant API:', error.message);
    throw error;
  }
}

sendPuissantBundle()
  .then((result) => {
    console.log(result);
  })
  .catch((error) => {
    console.error('Error:', error.message);
  });

/*
Computes pair addresses off-chain
*/
export const getPancake2PairAddress = (tokenA: string, tokenB: string) => {
  const [token0, token1] = sortTokens(tokenA, tokenB);

  const salt = ethers.utils.keccak256(token0 + token1.replace("0x", ""));
  const address = ethers.utils.getCreate2Address(
    "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73", // Factory address (contract creator)
    salt,
    "0x00fb7f630766e6a796048ea87d01acd3068e8ff67d078148a3fa3f4a84f69bd5" // init code hash
  );

  return address;
};

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

export const calcSandwichState = (
  optimalSandwichWethIn: any,
  userWethIn: any,
  userMinRecv: any,
  reserveFromToken: any,
  reserveToToken: any
) => {
  const frontrunState = getPancake2DataGiveIn(
    optimalSandwichWethIn,
    reserveFromToken,
    reserveToToken
  );
  const victimState = getPancake2DataGiveIn(
    userWethIn,
    frontrunState.newReserveA,
    frontrunState.newReserveB
  );
  const backrunState = getPancake2DataGiveIn(
    frontrunState.amountOut,
    victimState.newReserveB,
    victimState.newReserveA
  );

  // Sanity check
  if (victimState.amountOut.lt(userMinRecv)) {
    return null;
  }

  // Return
  return {
    // NOT PROFIT
    // Profit = post gas
    revenue: backrunState.amountOut.sub(optimalSandwichWethIn),
    optimalSandwichWethIn,
    amountIn: userWethIn,
    userMinRecv,
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
  const baseFee = curBlock.baseFeePerGas!;
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
export const calcSandwichOptimalIn = (
  amountIn: any,
  userMinRecvToken: any,
  fromTokenReserve: any,
  toTokenReserve: any
) => {
  // Note that user is going from WETH -> TOKEN
  // So, we'll be pushing the price of TOKEn
  // by swapping WETH -> TOKEN before the user
  // i.e. Ideal tx placement:
  // 1. (Ours) WETH -> TOKEN (pushes up price)
  // 2. (Victim) WETH -> TOKEN (pushes up price more)
  // 3. (Ours) TOKEN -> WETH (sells TOKEN for slight WETH profit)
  const calcF = (amountIn: any) => {
    const frontrunState = getPancake2DataGiveIn(
      amountIn,
      fromTokenReserve,
      toTokenReserve
    );
    const victimState = getPancake2DataGiveIn(
      amountIn,
      frontrunState.newReserveA,
      frontrunState.newReserveB
    );
    return victimState.amountOut;
  };

  // Our binary search must pass this function
  // i.e. User must receive at least min this
  const passF = (amountOut: any) => amountOut.gte(userMinRecvToken);

  // Lower bound will be 0
  // Upper bound will be 100 ETH (hardcoded, or however much ETH you have on hand)
  // Feel free to optimize and change it
  // It shouldn't be hardcoded hehe....
  const lowerBound = parseUnits("0");
  const upperBound = parseUnits("100");

  // Optimal WETH in to push reserve to the point where the user
  // _JUST_ receives their min recv
  const optimalWethIn = binarySearch(lowerBound, upperBound, calcF, passF);

  return optimalWethIn;
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
export const getPancake2ExactFromTokenMinRecv = async (finalMinRecv: any, path: string | any[]) => {
  let userMinRecv = finalMinRecv;

  // Only works for swapExactETHForTokens

  // Computes lowest amount of token (directly after WETH)
  for (let i = path.length - 1; i > 1; i--) {
    const fromToken = path[i - 1];
    const toToken = path[i];

    const pair = getPairAddress(fromToken, toToken);
    const [reserveFromToken, reserveTo] = await getPancake2Reserve(
      pair,
      fromToken,
      toToken
    );

    const newReserveData = await getPancake2DataGivenOut(
      userMinRecv,
      reserveFromToken,
      reserveTo
    );
    userMinRecv = newReserveData.amountIn;
  }

  return userMinRecv;
};

/*
  Computes pair addresses off-chain
*/
export const getPairAddress = (tokenA: string, tokenB: string) => {
  const [token0, token1] = sortTokens(tokenA, tokenB);

  const salt = ethers.utils.keccak256(token0 + token1.replace("0x", ""));
  const address = ethers.utils.getCreate2Address(
    "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Factory address (contract creator)
    salt,
    "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f" // init code hash
  );

  return address;
};

/*
  Get reserve helper function
*/
export const getPancake2Reserve = async (pair: string, tokenA: string, tokenB: string) => {
  const [token0] = sortTokens(tokenA, tokenB);
  const [reserve0, reserve1] = await PancakePairContract.attach(pair).getReserves();

  if (tokenA == token0) {
    return [reserve0, reserve1];
  }
  return [reserve1, reserve0];
};

/*
 Uniswap v2; x * y = k formula

 How much in do we get if we supply out?
*/
export const getPancake2DataGivenOut = (bOut: any, reserveA: any, reserveB: any) => {
  // Underflow
  let newReserveB = reserveB.sub(bOut);
  if (newReserveB.lt(0) || reserveB.gt(reserveB)) {
    newReserveB = ethers.BigNumber.from(1);
  }

  const numerator = reserveA.mul(bOut).mul(1000);
  const denominator = newReserveB.mul(997);
  const aAmountIn = numerator.div(denominator).add(ethers.constants.One);

  // Overflow
  let newReserveA = reserveA.add(aAmountIn);
  if (newReserveA.lt(reserveA)) {
    newReserveA = ethers.constants.MaxInt256;
  }

  return {
    amountIn: aAmountIn,
    newReserveA,
    newReserveB,
  };
};

export const getRawTransaction = (tx: ethers.providers.TransactionResponse) => {
  let raw;
  let txData = stringifyBN(tx, true);

  const common = new Common({ chainId: 56});

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
export const stringifyBN = (o:any, toHex = false):any => {
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
    const res:any = {};
    const keys = Object.keys(o);
    keys.forEach((k) => {
      res[k] = stringifyBN(o[k], toHex);
    });
    return res;
  } else {
    return o;
  }
};