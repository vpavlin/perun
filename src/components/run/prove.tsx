import { DataObject, IExecDataProtector } from '@iexec/dataprotector';
import { RunItem, StoreItem } from '../../lib/types';
import { useEffect, useState } from 'react';
import useIdentity from '../../hooks/useIdentity';
import { APP_PREFIX } from '../../constants';
import { distance_m, duration, pace, velocity_kph } from '../../lib/run';
import { download } from '../../lib/utils';

interface IProps {
    run: RunItem
    points: StoreItem[]
}
const Prove = ({run, points}: IProps) => {

    const [dataProtector, setDataProtector] = useState<IExecDataProtector>()
    const [processing, setProcessing] = useState(false)
    const {wallet} = useIdentity(`${APP_PREFIX}-master`, "password")

    useEffect(() => {
        if (window.ethereum && !dataProtector) {
            const web3Provider = window.ethereum;
            const dataProtector = new IExecDataProtector(web3Provider);
            setDataProtector(dataProtector)
        }
    }, [window, window.ethereum])

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
        download(`proof-of-run-${run.hash}`, result)

        setProcessing(false)
    }

    return (
        <>
        <div>
            <button className={`btn btn-lg btn-primary`} disabled={!dataProtector || processing || !wallet} onClick={() => prove()}>{processing ? <span className="loading loading-spinner loading-lg"></span> : "Get Proof-of-Run"}</button>
        </div>
        </>
    )
} 

export default Prove;