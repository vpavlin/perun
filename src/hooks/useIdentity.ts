import { useMemo, useRef, useState } from "react";
import { Wallet } from "ethers";


const useIdentity = (name?: string, password?:string) => {
    const [wallet, setWallet] = useState<Wallet>()
    const [percent, setPercent] = useState<number>(0)
    const [publicKey, setPublicKey] = useState<string>()
    const [privateKey, setPrivateKey] = useState<string>()
    const [address, setAddress] = useState<string>()
    const [error, setError ] = useState<string>()

    const initialized = useRef(false)


    if (!name) name = "identity"

    const storageKey = `${name}-key`
    const progress = (percent: number) => {
        setPercent(Math.floor(percent * 100) )
    } 

    useMemo(async () => {
        if (!password || password == "" || initialized.current) return

        initialized.current = true
        let item = localStorage.getItem(storageKey)
        if (!item) {
            const w = Wallet.createRandom()
            item = w.encryptSync(password)
            localStorage.setItem(storageKey, item)

        }

        try {
            const w = await Wallet.fromEncryptedJson(item, password, progress) as Wallet
            setWallet(w)
            setPublicKey(w.signingKey.publicKey.slice(2))
            setPrivateKey(w.privateKey.slice(2))
            setAddress(w.address)
            setError(undefined)
        } catch (e:any) {
            console.error(e)
            setError((e as Error).message)
        }
    }, [name, password])
    

    const result = useMemo(() => ({
        wallet,
        publicKey,
        privateKey,
        percent,
        address,
        error,
    }), [
        wallet,
        percent,
        privateKey,
        publicKey,
        error,
        address
    ])

    return result
}

export default useIdentity;