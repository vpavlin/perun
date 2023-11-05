import { useAccount, useSignMessage } from "wagmi";
import useIdentity from "../../hooks/useIdentity";
import { useEffect, useState } from "react";
import { APP_PREFIX, IDENTITY_STORAGE_NAME } from "../../constants";
import QRCode from "react-qr-code";
import { QrScanner } from "@yudiel/react-qr-scanner";
import { useLocalStorage } from "usehooks-ts";
import { verifyMessage } from "ethers"

type FriendEncryptionInfo = {
    publicKey: string
    address: string
}

type FriendInfoData = {
    address: string,
    encryptionInfo: FriendEncryptionInfo
}

export type FriendInfo = {
    signature: string
    data: FriendInfoData
}

const Profile = () => {
    const [password, setPassword] = useState<string>()
    const [passInput, setPassInput] = useState<string>()
    const [scanner, setScanner] = useState(false)


    const {address, error, publicKey, privateKey} = useIdentity(IDENTITY_STORAGE_NAME, password)

    const [friends, setFriends] = useLocalStorage<FriendInfo[]>(`${APP_PREFIX}-friends`, [])

    const {address: externalAddress} = useAccount()
    const {signMessage, data, isLoading} = useSignMessage()


    const [signature, setSignature] = useState<string>()
    const [contactInfo, setContactInfo] = useState<FriendInfoData>()
    const [friendInfo, setFriendInfo] = useState<FriendInfo>()


    useEffect(() => {
        if (!publicKey || isLoading || contactInfo || scanner || !externalAddress || !address) return
        const d:FriendInfoData = {
            address: externalAddress as string,
            encryptionInfo: {
                publicKey: publicKey,
                address: address
            }
        }
        signMessage({message: JSON.stringify(d)})
        setContactInfo(d)

    }, [publicKey, isLoading])

    useEffect(() =>{
        setSignature(data)
    }, [data])

    useEffect(() => {
        if (!friendInfo) return

        const addr = verifyMessage(JSON.stringify(friendInfo.data), friendInfo.signature)
        if (addr != friendInfo.data.address) {
            console.error("Sender is not signer")
            return
        }

        setFriends((v) => [...v.filter((f) => f.data.address != addr), friendInfo])
        
    }, [friendInfo])

    const unlock = ()  => {
        setPassword(passInput)

    }

    return (
        <>
            <div className="collapse">
                <input type="checkbox" />
                <div className="collapse-title">Share Contact Info</div>
                <div className="m-1 collapse-content">
                    <label className="label">
                        <span>Password</span>
                        <input type="password" className="input input-bordered" onChange={(e) => setPassInput(e.target.value)} value={passInput} />
                    </label>
                    {publicKey ? `Address: ${address}` : <button className="btn btn-neutral" onClick={unlock}>Unlock</button>}
                    {error && <div className="bg-error text-error-content">{error}</div>}
                    {publicKey && signature && <QRCode className="m-auto my-3 border-white border-4 rounded-lg" value={
                            JSON.stringify({
                                data: contactInfo,
                                signature: signature
                            }
                        )} />}

                </div>
            </div>
            <div className="collapse">
                <input type="checkbox" onChange={(e) => setScanner(e.target.checked)} />
                <div className="collapse-title" >Scan Contact Info</div>
                <div className="m-1 collapse-content">
                    <label className="label">
                        <span>Password</span>
                        <input type="password" className="input input-bordered" onChange={(e) => setPassInput(e.target.value)} value={passInput} />
                    </label>
                    {publicKey ? `Address: ${address}` : <button className="btn btn-neutral" onClick={unlock}>Unlock</button>}
                    {error && <div className="bg-error text-error-content">{error}</div>}
                    {scanner && <QrScanner
                                onDecode={(result:string) => {
                                    const pa = JSON.parse(result)
                                    if (pa.signature) {
                                        setFriendInfo(pa)
                                    }
                                    console.log(pa)
                                    setScanner(false)
                                }}
                                onError={(error:any) => console.error(error?.message)}
                        />}

                </div>
            </div>
        </>
    )
}
export default Profile;