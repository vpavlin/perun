import { useLocalStorage, useReadLocalStorage } from "usehooks-ts";
import { useLocation } from "../../hooks/useLocation";
import { APP_PREFIX, GEO_DATA_STORAGE, RUN_STORAGE } from "../../constants";
import { useEffect, useState } from "react";
import { useStore } from "../../hooks/useStore";
import {sha256} from "js-sha256"
import { PairingRequest, RunItem, StoreItem } from "../../lib/types";
import { distance_m, duration, filter, pace, velocity_kph } from "../../lib/run";
import Geohash from "latlon-geohash";
import { download } from "../../lib/utils";
import Sync from "../sync/sync";
import Prove from "./prove";
import Moment from "react-moment";
import moment from "moment";

import {GiPathDistance} from "react-icons/gi"
import {TbTimeDuration15} from "react-icons/tb"
import {BsSpeedometer, BsCalendar3} from "react-icons/bs"
import {PiMetronome} from "react-icons/pi"
import {MdOutlineSyncAlt} from "react-icons/md"


interface IProps  {
    id: string
}

const Overview = ({id}: IProps) => {
    const [run, setRun] = useState<RunItem>()
    const [points, setPoints] = useState<StoreItem[]>()
    const [duratio, setDuration] = useState<number>()
    const [distance, setDistance] = useState<number>()
    const [velocity, setVelocity] = useState<number>()
    const [pace_min_km, setPace] = useState<number>()
    const [publicKey, setPublicKey] = useState<string>()

    const pairedAccounts = useReadLocalStorage<PairingRequest[]>(`${APP_PREFIX}-paired-accounts`)


    const storeGeo = useStore<StoreItem>(GEO_DATA_STORAGE)
    const storeRuns = useStore<RunItem>(RUN_STORAGE)

    useEffect(() =>{
        if (!storeRuns) return
        (async () => {
            const run = await storeRuns.get(id)
            setDuration(duration(run))
            setRun(run)
        })()
    }, [storeRuns])

    useEffect(() =>{
        if (!storeGeo) return
        (async () => {
            const points = await storeGeo.getAll(id)
            let cache:string[] = []
            const filtered = points.filter((v) => {
                const [p, tcache] = filter(v, cache)
                //@ts-ignore
                cache = tcache
                return p != undefined
        })
            setPoints(points.sort((a, b) => {
                if (a.loc.timestamp < b.loc.timestamp) return -1
                if (a.loc.timestamp > b.loc.timestamp) return 1
                return 0
            }))
            setDistance(distance_m(points))
            
        })()
    }, [storeGeo])

    useEffect(() => {
        if (!duratio || !distance) return
        setVelocity(velocity_kph(duratio, distance))
        setPace(pace(duratio, distance))
    }, [distance, duratio])


    
    return (<>
        <div className="rounded-t-xl absolute bottom-0 w-full p-4 bg-base-100 z-20 min-h-16 items-center justify-center text-center">

                {run && points &&
                <div>
                    <div className="flex justify-between text-left flex-row">
                        <div className="flex-col lg:flex-row w-4/6">
                            <div  className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1 min-w-[200px]">Name: {run.name}</div>
                            <div  className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1 min-w-[200px]"><BsCalendar3 size="40" className="m-2" /> <Moment>{run.startTimestamp}</Moment></div>
                        </div>
                        <div className="flex flex-col lg:flex-row justify-center w-full">
                            <div className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1"><TbTimeDuration15 size="40" /> {moment().startOf('day').add(duratio, 'm').format("mm:ss")}</div>
                            <div className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1"><GiPathDistance size="40"  className="m-2" /> {(distance! / 1000).toFixed(3)} km</div>
                            <div className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1"><BsSpeedometer size="40"  className="m-2" /> {velocity?.toFixed(2)} km/h</div>
                            <div className="flex flex-row justify-between items-center shadow-lg p-2 bg-neutral m-1"><PiMetronome size="40"  className="m-2" /> {moment().startOf('day').add(pace_min_km, 'm').format("mm:ss")} min/km</div>
                        </div>
                    </div>
                    {false && 
                    <div className="max-h-[200px] overflow-y-scroll">
                        {points!.map((v) => <div>{v.loc.lat}, {v.loc.lon} ({Geohash.encode(v.loc.lat, v.loc.lon, 7)}</div>)}
                    </div>
                    }
                    {pairedAccounts && <div className="collapse rounded-none my-3 m-auto  lg:w-5/6">
                            <input type="checkbox" />
                            <div className="collapse-title flex flex-row items-center p-2 bg-neutral "><MdOutlineSyncAlt size="40"  className="m-2" /> Sync</div>
                            <div className="collapse-content bg-neutral "> 
                                <ul  tabIndex={0} className="dropdown-content z-[1] menu ">
                                    {pairedAccounts.filter((pa) => pa.confirmed).map((pa) => <li><a onClick={() => setPublicKey(pa.publicKey)}>{pa.deviceName}</a></li>)}
                                </ul>
                            
                            </div>
                            { publicKey &&
                                <Sync run={run} points={points} publicKey={publicKey} />
                            }
                        </div>
                    }
                    {false && <div>
                        <button className="btn btn-lg btn-primary" onClick={() => download(`perun-${run!.hash}.json`, points)}>Export</button>
                    </div>}
                    <Prove points={points} run={run} />
                </div>
            }
        </div>
    </>)
}

export default Overview;