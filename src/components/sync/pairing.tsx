import React, { useEffect, useRef, useState } from "react"
import getDispatcher, { DispatchMetadata, Dispatcher, Signer } from "waku-dispatcher"
import { utils } from "@noble/secp256k1"
import { useLocalStorage } from "usehooks-ts"
import {APP_PREFIX, SYNC_CONTENT_TOPIC} from "../../constants"
import { QrScanner } from "@yudiel/react-qr-scanner"
import { sha256 } from "js-sha256"
import QRCode from "react-qr-code"
import { Wallet } from "ethers"
import { PairingRequest } from "../../lib/types"
import { MdDevicesOther } from "react-icons/md"
import { HiOutlineKey } from "react-icons/hi"
import { FaUserSecret } from "react-icons/fa"


interface IProps {
    wallet?: Wallet
    publicKey?: string
    privateKey?: string
}

const Pairing = ({wallet, publicKey, privateKey}: IProps) => {
    const initialized = useRef(false)
    const [pairedAccounts, setPairedAccounts] = useLocalStorage<PairingRequest[]>(`${APP_PREFIX}-paired-accounts`, [])
    const [deviceName, setDeviceName] = useLocalStorage<string>(`${APP_PREFIX}-device-name`, "")

    const [proposedPairing, setProposedPairing] = useState<PairingRequest>()
    const [scanner, setScanner] = useState(false)
    const [ dispatcher, setDispatcher ] = useState<Dispatcher>()

    const [secret, setSecret] = useState<string>()


    const confirm = () => {
        console.log("he?")
        console.log(proposedPairing)
        if (!proposedPairing || !dispatcher) return
        setPairedAccounts((x) => [...x.filter((a) => a.publicKey != proposedPairing.publicKey), proposedPairing])
        setProposedPairing(undefined)
        dispatcher.emit("confirm", {publicKey: publicKey, deviceName: deviceName, confirmed: true, secret: ""} as PairingRequest, wallet, {key: utils.hexToBytes(proposedPairing.publicKey), type: 1})
    }

    useEffect(() => {
        console.log(privateKey)

        if (!privateKey || initialized.current) return
        console.log("Setting up")
        initialized.current = true;
        (async () => {
            setSecret(sha256(Math.random().toString()).slice(0, 6))
            const d = await getDispatcher(undefined, SYNC_CONTENT_TOPIC, `${APP_PREFIX}`, true)
            console.log(d)
            if (!d) return
            d.registerKey(utils.hexToBytes(privateKey))
            d.on("request_pairing", (payload: PairingRequest, signer: Signer, meta: DispatchMetadata) => {
                setProposedPairing((p) => p ? p : payload)
            }, true, true)
            d.on("confirm", (payload: PairingRequest, signer: Signer, meta: DispatchMetadata) => {
                setPairedAccounts((x) => x.map((a) => {
                    if (a.publicKey == payload.publicKey) {
                        a.confirmed = payload.confirmed
                    }

                    return a
                }))
            }, true, true)
            setDispatcher(d)
        })()
    }, [privateKey])

    return (<>
        <div>
            { wallet &&
            <div>
                <div className="m-3">
                    <label className="label">
                        <span className="label-text">Device Name</span>
                        <input type="text" className="input input-primary" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
                    </label>
                    <div>
                        <button className="btn btn-lg btn-neutral" disabled={!dispatcher} onClick={() => setScanner(true)}>Scan{ !dispatcher  && <span className="loading loading-spinner"></span>}</button>
                        {scanner && dispatcher && <QrScanner
                                onDecode={(result:string) => {
                                    const pa = JSON.parse(result)
                                    pa.confirm = false
                                    console.log(pa)
                                    setPairedAccounts((x) => [...x.filter((a) => a.publicKey != pa.publicKey), pa]); 
                                    dispatcher.emit("request_pairing", {publicKey: publicKey, confirmed: false, deviceName: deviceName, secret: pa.secret} as PairingRequest, wallet, {key: utils.hexToBytes(pa.publicKey), type: 1})
                                    setScanner(false)
                                }}
                                onError={(error:any) => console.error(error?.message)}
                        />}
                    </div>
                        {publicKey && deviceName != "" && secret && <QRCode className="m-auto my-3 border-white border-4 rounded-lg" value={JSON.stringify({confirmed:false, deviceName: deviceName, publicKey: publicKey, secret: secret} as PairingRequest)} />}
                    <div>

                    </div>
                </div>
                {proposedPairing && 
                    <div className="text-center my-5 m-auto w-fit ">
                        New device pairing request
                        <div className="flex flex-row justify-start items-center space-x-3">
                            <span><MdDevicesOther size="40" /></span>
                            <span>{proposedPairing.deviceName}</span>
                        </div>
                        <div className="flex flex-row justify-start items-center space-x-3">
                            <span><HiOutlineKey size="40" /></span>
                            <span>{proposedPairing.publicKey.slice(0,10)}...{proposedPairing.publicKey.slice(proposedPairing.publicKey.length-10)}</span>
                        </div>
                        <div className="flex flex-row justify-start items-center space-x-3">
                            <span><FaUserSecret size="40" /></span>
                            <span>{proposedPairing.secret}</span>
                        </div>
                        <button  className="btn btn-lg btn-neutral" onClick={() => confirm()}>Confirm</button>
                    </div>
                }
            </div>
            }
            Paired devices
            {pairedAccounts && 
                pairedAccounts.sort((a, b) => {
                    if (a.confirmed && !b.confirmed) return -1
                    if (!a.confirmed && b.confirmed) return 1

                    return 0
                }).map((pa) => 
                <div className="max-w-[400px] m-auto my-2 shadow p-2 bg-base-300 rounded-xl">
                    <div className="flex flex-row justify-between">
                        <span>Device Name</span>
                        <span>{pa.deviceName}</span>
                    </div>
                    <div className="flex flex-row justify-between">
                        <span>Device Key</span>
                        <span>{pa.publicKey?.slice(0, 20)}...</span>
                    </div>
                    <div className="flex flex-row justify-between">
                        <span>Confirmed</span>
                        <span>{pa.confirmed ? "Yes" : "No"}</span>
                    </div>
                </div>)}
        </div>
    </>)
}

export default Pairing