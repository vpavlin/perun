import { useEffect, useState } from "react"
import { PairingRequest, RunItem } from "../../lib/types";
import { useStore } from "../../hooks/useStore";
import React from "react";
import { APP_PREFIX, RUN_STORAGE } from "../../constants";
import { Link } from "react-router-dom";
import { useReadLocalStorage } from "usehooks-ts";



const RunList = () => {
    const storeRuns = useStore<RunItem>(RUN_STORAGE)
    const [runs, setRuns] = useState<RunItem[]>()


    useEffect(() => {
        if(!storeRuns) return

        (async () => {
            console.log(storeRuns)
            setRuns(await storeRuns.getAll())
        })()
    }, [storeRuns])

    return (<>
        <div>
            {runs?.filter((v) => v.startTimestamp != undefined).map((v, i) => 
                <div className="rounded shadow bg-primary p-2 m-2 flex justify-between">
                    <Link className="btn" to={`/run/${v.hash}`}>{v.name} ({new Date(v.startTimestamp!).toLocaleString()})</Link>
                </div>)}
        </div>
    </>)
}

export default RunList