import React, { useEffect, useRef, useState } from "react";
import { useReadLocalStorage } from "usehooks-ts";
import { PairingRequest, RunItem, StoreItem, SyncData } from "../../lib/types";
import { APP_PREFIX, GEO_DATA_STORAGE, IDENTITY_STORAGE_NAME, RUN_STORAGE, SYNC_CONTENT_TOPIC } from "../../constants";
import getDispatcher, { DispatchMetadata, Dispatcher, Signer } from "waku-dispatcher";
import useIdentity from "../../hooks/useIdentity";
import { utils } from "@noble/secp256k1"
import { useStore } from "../../hooks/useStore";
import { Link } from "react-router-dom";



const SyncReceive = () => {
    const initialized = useRef(false)
    const pairedAccounts = useReadLocalStorage<PairingRequest[]>(`${APP_PREFIX}-paired-accounts`)
    const [password, setPassword] = useState<string>()
    const [passInput, setPassInput] = useState<string>()
    const {address, error, wallet, privateKey, publicKey} = useIdentity(IDENTITY_STORAGE_NAME, password)

    const [ dispatcher, setDispatcher ] = useState<Dispatcher>()


    const storeGeo = useStore<StoreItem>(GEO_DATA_STORAGE)
    const storeRuns = useStore<RunItem>(RUN_STORAGE)

    const [data, setData] = useState<SyncData>() 
    const [done, setDone] = useState(false)

    useEffect(() => {
        if (!storeRuns || !storeGeo || !data) return

        (async () => {
            await storeRuns.set(data.run)
            for (const point of data.points) {
                await storeGeo.set(point)
            }
        })()
    }, [storeGeo, storeRuns, data])

    useEffect(() => {
        if (!privateKey || !publicKey || initialized.current) return
        console.log("Setting up")
        initialized.current = true;
        (async () => {
            const d = await getDispatcher(undefined, SYNC_CONTENT_TOPIC, `${APP_PREFIX}`, true)
            console.log(d)
            if (!d) return
            d.registerKey(utils.hexToBytes(privateKey))
            d.on("sync_data", async (payload: SyncData, signer: Signer, meta: DispatchMetadata) => {
                console.log("Got data!")
                setData(payload)

            }, true, true)

            setDispatcher(d)
        })()
    }, [privateKey, publicKey])


    const unlock = ()  => {
        setPassword(passInput)
    }
    return (<>
        <div>
            {
                <div>
                    <div className="m-1">
                        {!wallet &&
                            <div>
                                <label className="label">
                                    <span>Password</span>
                                    <input type="password" className="input input-primary" onChange={(e) => setPassInput(e.target.value)} value={passInput} />
                                </label>
                        
                                <button className="btn btn-primary" onClick={unlock}>Unlock</button>
                            </div>
                        }
                        {wallet && (dispatcher ? (!done || !data ? <div>Awaiting data...</div> : <div>New run synced: <Link to={`/run/${data.run.hash}`}>{data.run.name}</Link></div>): <div>Connecting...</div>)}
                        {error && <div className="bg-error text-error-content">{error}</div>}
                    </div>
                </div>
            }
        </div>
    </>)
}

export default SyncReceive;