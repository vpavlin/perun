import { useEffect, useState } from "react"
import { PairingRequest, RunItem } from "../../lib/types";
import { useStore } from "../../hooks/useStore";
import React from "react";
import { APP_PREFIX, RUN_STORAGE } from "../../constants";
import { Link } from "react-router-dom";
import { useReadLocalStorage } from "usehooks-ts";

import {GrRun} from "react-icons/gr"
import {FiMap} from "react-icons/fi"
import Moment from "react-moment";
import { duration } from "../../lib/run";
import { TbTimeDuration15 } from "react-icons/tb";
import moment from "moment";
import { BsCalendar3 } from "react-icons/bs";



const RunList = () => {
    const storeRuns = useStore<RunItem>(RUN_STORAGE)
    const [runs, setRuns] = useState<RunItem[]>()


    useEffect(() => {
        if(!storeRuns) return

        (async () => {
            console.log(storeRuns)
            const r = await storeRuns.getAll()
            setRuns(r.sort((a, b ) => {
                if (!a.startTimestamp || !a.finishTimestamp) return 1
                if (!b.startTimestamp || !b.finishTimestamp) return -1

                if (a.finishTimestamp < b.finishTimestamp) return 1
                if (a.finishTimestamp > b.finishTimestamp) return -1

                return 0
            }))
        })()
    }, [storeRuns])

    return (<>
        <div>
            {runs?.filter((v) => v.startTimestamp != undefined).map((v, i) => 
                <div className="collapse shadow-md rounded-none">
                    <input type="checkbox" />
                    <div className="collapse-title flex flex-row justify-between">
                        <span className="flex flex-row items-center">
                            <GrRun size="40" className="text-base-content"/>
                            <span>{v.name}</span>
                        </span>
                        <span>{<Moment format="DD. MM. YYYY">{v.startTimestamp}</Moment>}</span>
                    </div>
                    <div className="collapse-content flex flex-col">
                        <div className="flex flex-row">
                            <span className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1">
                                <TbTimeDuration15 size="35"  className="m-2"/> {moment().startOf('day').add(duration(v), 'm').format("mm:ss")}
                            </span>
                            <span className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1">
                                <BsCalendar3 size="35" className="m-2" /> <Moment format="HH:MM DD. MM. YYYY">{v.finishTimestamp}</Moment>
                            </span>

                        </div>
                        <div className="justify-end text-right w-full"><Link className="btn btn-neutral" to={`/run/${v.hash}`}> <FiMap size="35" /></Link></div>
                    </div>
                </div>)}
        </div>
    </>)
}

export default RunList