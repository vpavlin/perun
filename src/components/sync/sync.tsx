import React, { useEffect, useRef, useState } from "react";
import { useReadLocalStorage } from "usehooks-ts";
import { PairingRequest, RunItem, StoreItem, SyncData } from "../../lib/types";
import { APP_PREFIX, IDENTITY_STORAGE_NAME, SYNC_CONTENT_TOPIC } from "../../constants";
import getDispatcher, { DispatchMetadata, Dispatcher, Signer } from "waku-dispatcher";
import useIdentity from "../../hooks/useIdentity";
import { utils } from "@noble/secp256k1"


interface IProps {
    run: RunItem
    points: StoreItem[]
    publicKey: string
}

const Sync = ({run, points, publicKey}: IProps) => {
    const initialized = useRef(false)
    const pairedAccounts = useReadLocalStorage<PairingRequest[]>(`${APP_PREFIX}-paired-accounts`)
    const [password, setPassword] = useState<string>()
    const [passInput, setPassInput] = useState<string>()
    const {address, error, wallet, privateKey} = useIdentity(IDENTITY_STORAGE_NAME, password)

    const [ dispatcher, setDispatcher ] = useState<Dispatcher>()


    useEffect(() => {
        if (!privateKey || initialized.current) return
        console.log("Setting up")
        initialized.current = true;
        (async () => {
            const d = await getDispatcher(undefined, SYNC_CONTENT_TOPIC, `${APP_PREFIX}`, true)
            console.log(d)
            if (!d) return
            d.registerKey(utils.hexToBytes(privateKey))
            d.on("request_pairing", (payload: PairingRequest, signer: Signer, meta: DispatchMetadata) => {
            }, true, true)
            d.on("confirm_sync", (payload: PairingRequest, signer: Signer, meta: DispatchMetadata) => {
                console.log("Done!")
                console.log(payload)
            }, true, true)
            setDispatcher(d)
        })()
    }, [privateKey])

    useEffect(() => {
        if (!dispatcher || !wallet) return
        (async () => {
            await dispatcher.emit("sync_data", {run: run, points: points} as SyncData, wallet, {key: utils.hexToBytes(publicKey), type: 1})
        })()
    }, [dispatcher, wallet])


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
                        {error && <div className="bg-error text-error-content">{error}</div>}
                    </div>
                </div>
            }
        </div>
    </>)
}

export default Sync;