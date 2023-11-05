import { DataObject, IExecDataProtector } from '@iexec/dataprotector';
import { RunItem, StoreItem } from '../../lib/types';
import { useEffect, useState } from 'react';
import useIdentity from '../../hooks/useIdentity';
import { ABI, APP_PREFIX, COMPLETELY_UNSERCURE_AND_LEAKING_PROVER_KEY, NFT_CONTRACT } from '../../constants';
import { distance_m, duration, pace, velocity_kph } from '../../lib/run';
import { download } from '../../lib/utils';
import { BrowserProvider, Wallet, ethers, Contract } from 'ethers';
import { useAccount } from 'wagmi';

interface IProps {
    run: RunItem
    points: StoreItem[]
}
const Prove = ({run, points}: IProps) => {

    const {address} = useAccount()

    const [dataProtector, setDataProtector] = useState<IExecDataProtector>()
    const [processing, setProcessing] = useState(false)
    //const {wallet} = useIdentity(`${APP_PREFIX}-master`, "password")

    //This is the prover wallet, normally, this PrivateKey would be uploaded to SMS and fetched into running iEXEC task to sign the result of proof generation
    const provider = new ethers.JsonRpcProvider("https://core-blockchain-testnet.rpc.thirdweb.com/")
    const wallet = new Wallet(COMPLETELY_UNSERCURE_AND_LEAKING_PROVER_KEY, provider)
    const signer = new ethers.JsonRpcSigner(provider, wallet.address)

    const [result, setResult] = useState<any>()

    useEffect(() => {
        if (window.ethereum && !dataProtector) {
            const web3Provider = window.ethereum;
            const dataProtector = new IExecDataProtector(web3Provider);
            setDataProtector(dataProtector)
        }
    }, [window, window.ethereum])


    /**
     * This functions generates a "proof-of-run"
     * 
     * Our plan was to use iEXEC's DataProtector, upload the `points` (i.e. list of coordinates representing the route) and calculate the proof result in a trusted environment without risking the leakage.
     * Sadly, we were not able to produce the module - as it could not be sconified during hackathon
     * We also could not upload to DataProtector due to ethers.js dependency conflicts (waku-dispatcher requires v6, iEXEC comes with v5)
     * @returns 
     */
    const prove = async () => {
        if (!wallet) return
        setProcessing(true)
        await new Promise((resolve) => setTimeout(() => resolve(true), 3000))

        const dist = distance_m(points)
        const dur = duration(run)
        const vel = velocity_kph(dur, dist)
        const pace_km_min = pace(dur, dist)   
        
        const toSign = {distance: dist, duration: dur, velocity: vel, pace: pace_km_min, timestampRun: run.finishTimestamp, timestamp: Date.now(), signer: wallet.address}
        const signature = await wallet.signMessage(JSON.stringify(toSign))

        const result = {proof: toSign, signature: signature}
        //download(`proof-of-run-${run.hash}`, result)

        setResult(result)
        setProcessing(false)
    }

    /**
     * The idea here was to mint an NFT based on the proof-of-run, but we were not able to execute the mint function on our contract on CoreDAO EVM compatible blockchian
     * and we did not have any more time to dig deeper.
     * 
     * Generally the ideal path would be send the proof-of-run as an argument to a mint function
     * The mint function would verify that the proof is signed by one of the prover wallets and mint the NFT into user wallet (connected via Web3Modal)
     */
    const mint = async () => {
        const contractInstance = new Contract(NFT_CONTRACT, ABI, signer)
        console.log(await contractInstance.balanceOf(wallet.address))

       
        await contractInstance.mint(address, 0)

    }

    return (
        <>
        { !result ?
        <div>
            <button className={`btn btn-lg btn-primary`} disabled={!dataProtector || processing || !wallet} onClick={() => prove()}>{processing ? <span className="loading loading-spinner loading-lg"></span> : "Get Proof-of-Run"}</button>
        </div>
        :
        <div className='space-y-2'>
            <pre className='text-left text-sm bg-base-300 p-3 overflow-x-auto'>
                {JSON.stringify(result, undefined, "  ")}
            </pre>
            <div>
                <button className="btn btn-neutral" disabled={!address} onClick={mint}>Mint Perun Proof-of-Run</button>
            </div>
        </div>
        }
        </>
    )
} 

export default Prove;