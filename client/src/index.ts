import dotenv from "dotenv";
import { ethers } from "ethers";
import { config } from "./config";
import { monitor } from "./core/sandwicher-bundle";
dotenv.config();

const Main = async () => {
  console.info(`Starting...\n- - -`);
  const wsProvider = new ethers.providers.WebSocketProvider(
    config.WSS_URL
  );
  console.log("Listening to mempool...\n");
  wsProvider.on('pending', async (hash) => {
    monitor(hash).catch((err)=>{
      console.log(`txhash=${hash} error ${JSON.stringify(err)}`);
    })
  });
};

Main();
