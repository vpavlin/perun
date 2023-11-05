import {promises as fsPromises} from "fs"
import { ProtectedData } from "./types";
import { distance_m, duration, pace, velocity_kph } from "./run";
import {Wallet} from "ethers"


(async () => {
  try {
    const iexecOut = process.env.IEXEC_OUT;
    // We are expecting a key as an arg on cmd line for simplicity, otherwise we'd use SMS
    const key = process.argv.length > 2 && process.argv[2];

    if (!key) {
      console.log("You need to provide a prover private key")
      process.exit(1)
    }

    //Init the wallet
    const wallet = new Wallet(key)

    const iexecIn = process.env.IEXEC_INPUT_FILE_NAME_1!
    const data = await fsPromises.readFile(iexecIn, {encoding: 'utf-8'})

    const parsed:ProtectedData = JSON.parse(data)

    //Get run metadata
    const dist = distance_m(parsed.data.points)
    const dur = duration(parsed.data.run)
    const vel = velocity_kph(dur, dist)
    const pace_km_min = pace(dur, dist) 
    
    //Prep message to sign
    const toSign = {distance: dist, duration: dur, velocity: vel, pace: pace_km_min, timestampRun: parsed.data.run.finishTimestamp, timestamp: Date.now(), signer: wallet.address}
    const signature = await wallet.signMessage(JSON.stringify(toSign))

    //Produce output object
    const resultData = {proof: toSign, signature: signature}

    const result = JSON.stringify(resultData)
    // Append some results in /iexec_out/
    await fsPromises.writeFile(`${iexecOut}/result.txt`, result);
    // Declare everything is computed
    const computedJsonObj = {
      "deterministic-output-path": `${iexecOut}/result.txt`,
    };
    await fsPromises.writeFile(
      `${iexecOut}/computed.json`,
      JSON.stringify(computedJsonObj)
    );
  } catch (e) {
    console.log(e);
    process.exit(1);
  }
})();