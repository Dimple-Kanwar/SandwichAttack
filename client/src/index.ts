import { constants, providers, utils } from 'ethers';
import { config } from './config';
import { sandwicher } from './core';
import { withdrawToken } from './helpers';

const Main = async () => {
  console.info(`Starting...\n- - -`);

  // get args
  let args = process.argv.slice(2);

  args.length === 0 && sandwicher.init();

  if (args.length > 0) {
    let action = args[0].toLowerCase();
    let token = args[1];

    if (action === 'sell') {
      // let { sellData } = sandwicher.prepareBuyAndSellData({
        let router = config.PANCAKE_ROUTER_ADDRESS;
        let path = [token, config.WBNB_ADDRESS];
        let amountOutMin = constants.Zero;
        let sellAmountOutMin = constants.Zero;
        let amountIn = constants.Zero;
      // });
      let sell = await sandwicher.sellTx(router,path,amountIn,sellAmountOutMin);
      console.log(sell);
    }

    // if (action === 'transfer') {
      // let provider = new providers.JsonRpcProvider(config.JSON_RPC);
      // let transfer = await withdrawToken(provider, token);
      // console.log(transfer);
    // }

    if (action === 'buy') {
      // let { buyData } = sandwicher.prepareBuyAndSellData({
        let router =  config.PANCAKE_ROUTER_ADDRESS;
        let path =  [config.WBNB_ADDRESS, token];
        let amountOutMin =  constants.Zero;
        let sellAmountOutMin =  constants.Zero;
        let amountIn =  constants.Zero;
      // });

      let buy = await sandwicher.buyTx(router,path,amountIn,amountOutMin);
      console.log(buy);
    }
  }
};

Main();
