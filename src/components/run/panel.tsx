import { useLocalStorage, useReadLocalStorage } from "usehooks-ts";
import { useLocation } from "../../hooks/useLocation";
import { APP_PREFIX, GEO_DATA_STORAGE, RUN_STORAGE } from "../../constants";
import { useEffect, useState } from "react";
import { useStore } from "../../hooks/useStore";
import {sha256} from "js-sha256"
import { RunItem, StoreItem } from "../../lib/types";
import Overview from "./overview";

import {BsPlayCircle, BsSignStop, BsSpeedometer} from "react-icons/bs"
import { GrRun } from "react-icons/gr";
import { TbRun, TbTimeDuration15 } from "react-icons/tb";
import Moment from "react-moment";
import moment from "moment";

interface IProps  {
    id: string
}

const Panel = ({id}: IProps) => {
    const gpsRate = useReadLocalStorage<number>(`${APP_PREFIX}-gpsrate`)
    const [started, setStarted] = useLocalStorage<boolean>(`${APP_PREFIX}-running`, false)
    const [stopped, setStopped] = useState(false)
    const [run, setRun] = useState<RunItem>()
    const [duration, setDuration] = useState<string>()

    const loc = useLocation(gpsRate || 1000);
    const storeGeo = useStore<StoreItem>(GEO_DATA_STORAGE)
    const storeRuns = useStore<RunItem>(RUN_STORAGE)

    useEffect(() => {
        console.log(storeRuns)
        if (!storeRuns || !started) return

        
        (async () => {
            console.log(stopped)
            const run = await storeRuns.get(id)
            console.log(run)
            if (stopped) {
                console.log(run)
                run.finishTimestamp = Date.now()
                await storeRuns.update(run)
                setRun(run)
                setStarted(false)
            } else if (!run.startTimestamp) {
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

        (async () => {
            try {
                await storeGeo.set({
                    geoHash: loc.geoHash.slice(0, 4),
                    hash: sha256(JSON.stringify(loc)),
                    loc: loc,
                    runId: id,
                })
            } catch (e) {
                console.log(e)
            }
        })()
    }, [
        loc
    ])

    useEffect(() => {
        if (!started  || !run || !run.startTimestamp) return

        const interval = setInterval(() => {
            if (!run || !run.startTimestamp) return
            setDuration(moment().startOf('day').add((Date.now() - run.startTimestamp)/1000, 's').format("mm:ss"))
        }, 1000)
    },[started, run])
    
    return (<>
    { run && run.finishTimestamp ?
        <Overview id={id} />
        :
        <div className="rounded-t-sm absolute bottom-0 w-full p-4 bg-base-100 z-10 items-center justify-center text-center">
            { started && run && run.startTimestamp && loc?
                <div className="flex flex-col">
                    <div className=" flex flex-row justify-between">
                        <div className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1 w-full"><BsSpeedometer size="40"  className="m-2" /> {loc?.speed && loc.speed*3.6 || 0}</div>
                        <div className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1 w-full"><TbTimeDuration15 size="40" /> {duration}</div>
                    </div>
                    <div className="">
                        <button className="btn w-fit h-fit p-3 bg-neutral" onClick={() => setStopped(true)}><BsSignStop size="100"  /></button>
                    </div>

                </div>
            :
                run && run.finishTimestamp == undefined &&
                    <div className="min-h-[100px]">
                        <button className="btn w-fit h-fit p-3 bg-neutral" onClick={() => setStarted(true)}><TbRun size="100" stroke="#FFF" color="#FFF"   style={{color: "white"}}/></button>
                    </div>
            }
        </div>
    }
    </>)
}

export default Panel;