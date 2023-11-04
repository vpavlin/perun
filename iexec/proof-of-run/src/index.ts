import {promises as fsPromises} from "fs"
import { ProtectedData } from "./types";


(async () => {
  try {
    const iexecOut = process.env.IEXEC_OUT;
    // Do whatever you want (let's write hello world here)
    const message = process.argv.length > 2 ? process.argv[2] : "World";

    const iexecIn = process.env.IEXEC_INPUT_FILE_NAME_1!
    const data = await fsPromises.readFile(iexecIn, {encoding: 'utf-8'})

    const parsed:ProtectedData = JSON.parse(data)



    const result = JSON.stringify({})
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