import { useState } from "react";
import useIdentity from "../hooks/useIdentity";
import { APP_PREFIX, IDENTITY_STORAGE_NAME } from "../constants";
import { useLocalStorage } from "usehooks-ts";
import Pairing from "../components/sync/pairing"
import SyncReceive from "../components/sync/syncreceive"

const Settings = () => {
    const [password, setPassword] = useState<string>()
    const [passInput, setPassInput] = useState<string>()
    const {address, error, wallet, publicKey, privateKey} = useIdentity(IDENTITY_STORAGE_NAME, password)
    const [gpsRate, setGPSRate] = useLocalStorage(`${APP_PREFIX}-gpsrate`, 1000)
    const [pair, setPair] = useState<boolean>()
    const [sync, setSync] = useState<boolean>()



    const unlock = ()  => {
        setPassword(passInput)
    }
    return (<>
        <div>
            {
                <div>
                    <div className="m-1">
                        <label className="label">
                            <span>Password</span>
                            <input type="password" className="input input-bordered" onChange={(e) => setPassInput(e.target.value)} value={passInput} />
                        </label>
                        {wallet ? `Address: ${address}` : <button className="btn btn-neutral" onClick={unlock}>Unlock</button>}
                        {error && <div className="bg-error text-error-content">{error}</div>}
                    </div>
                    <div className="m-1">
                        <label className="label">
                            <input type="range" min={1} max="5" step={1} value={gpsRate/1000} className="range w-2/4" onChange={(e) => setGPSRate(parseInt(e.target.value)*1000)} />
                            <span>Get GPS every {gpsRate / 1000}s</span>
                        </label>
                    </div>

                </div>
            }
            <div className="p-2 text-center">
                <button className="btn btn-lg btn-neutral" onClick={() => {setSync(false); setPair(true)}}>Pair</button>
            </div>
            {pair && <Pairing wallet={wallet} publicKey={publicKey} privateKey={privateKey} />}
            <div className="p-2 text-center">
                <button className="btn btn-lg btn-neutral" onClick={() => {setPair(false);setSync(true);}}>Sync</button>
            </div>
            {sync && <SyncReceive />}
        </div>
    </>)
}

export default Settings;