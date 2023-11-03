import { useState } from "react";
import useIdentity from "../hooks/useIdentity";
import { APP_PREFIX, IDENTITY_STORAGE_NAME } from "../constants";
import { useLocalStorage } from "usehooks-ts";

const Settings = () => {
    const [password, setPassword] = useState<string>()
    const [passInput, setPassInput] = useState<string>()
    const {address, error, wallet} = useIdentity(IDENTITY_STORAGE_NAME, password)
    const [gpsRate, setGPSRate] = useLocalStorage(`${APP_PREFIX}-gpsrate`, 1000)


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
                            <input type="password" className="input input-primary" onChange={(e) => setPassInput(e.target.value)} value={passInput} />
                        </label>
                        {wallet ? `Address: ${address}` : <button className="btn btn-primary" onClick={unlock}>Unlock</button>}
                        {error && <div className="bg-error text-error-content">{error}</div>}
                    </div>
                    <div className="m-1">
                        <label className="label">
                            <input type="range" min={0} max="5" step={1} value={gpsRate/1000} className="range range-primary w-2/4" onChange={(e) => setGPSRate(parseInt(e.target.value)*1000)} />
                            <span>{gpsRate}</span>
                        </label>
                    </div>

                </div>
            }
        </div>
    </>)
}

export default Settings;