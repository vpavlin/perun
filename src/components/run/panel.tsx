import { useLocalStorage, useReadLocalStorage } from "usehooks-ts";
import { useLocation } from "../../hooks/useLocation";
import { APP_PREFIX, GEO_DATA_STORAGE, RUN_STORAGE } from "../../constants";
import { useEffect, useState } from "react";
import { useStore } from "../../hooks/useStore";
import {sha256} from "js-sha256"
import { RunItem, StoreItem } from "../../lib/types";

interface IProps  {
    id: string
}

const Panel = ({id}: IProps) => {
    const gpsRate = useReadLocalStorage<number>(`${APP_PREFIX}-gpsrate`)
    const [started, setStarted] = useLocalStorage<boolean>(`${APP_PREFIX}-running`, false)
    const [stopped, setStopped] = useState(false)
    const [run, setRun] = useState<RunItem>()

    const loc = useLocation(gpsRate || 1000);
    const storeGeo = useStore<StoreItem>(GEO_DATA_STORAGE)
    const storeRuns = useStore<RunItem>(RUN_STORAGE)

    useEffect(() => {
        console.log(storeRuns)
        if (!storeRuns || !started) return

        
        (async () => {
            console.log(stopped)
            if (stopped) {
                const run = await storeRuns.get(id)
                console.log(run)
                run.finishTimestamp = Date.now()
                await storeRuns.update(run)
                setRun(run)
                setStarted(false)
            } else {
                const run = await storeRuns.get(id)
                run.startTimestamp = Date.now()
                await storeRuns.update(run)
                setRun(run)
            } 
        })()
            
    }, [started, storeRuns, stopped])

    useEffect(() =>{
        if (!storeRuns) return
        (async () => {
            const run = await storeRuns.get(id)
            setRun(run)
        })()
    }, [storeRuns])


    useEffect(() => {
        if (!storeGeo || !loc || !started) return

        storeGeo.set({
            geoHash: loc.geoHash.slice(0, 4),
            hash: sha256(JSON.stringify(loc)),
            loc: loc,
            runId: id,
        })
    }, [
        loc
    ])
    
    return (<>
        <div className="rounded-t-xl absolute bottom-0 w-full p-4 bg-base-100 z-20 min-h-16 items-center justify-center text-center">
            { started?
                <div className="flex flex-row">
                    <div className="w-5/6 flex flex-row justify-between">
                        <div>Speed: {loc?.speed || 0}</div>
                        <div>Time: {loc?.speed || 0}</div>
                    </div>
                    <div className="w-1/6">
                        <button className="btn btn-lg btn-primary" onClick={() => setStopped(true)}>Stop</button>
                    </div>

                </div>
            :
                run && run.finishTimestamp == undefined &&
                    <div>
                        <button className="btn btn-lg btn-primary" onClick={() => setStarted(true)}>Start</button>
                    </div>
            }
        </div>
    </>)
}

export default Panel;