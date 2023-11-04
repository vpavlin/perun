import { MapContainer, TileLayer, Marker, Polyline } from "react-leaflet";
import {type LatLngExpression} from "leaflet";
import { useReadLocalStorage } from "usehooks-ts";
import { APP_PREFIX, GEO_DATA_STORAGE } from "../../constants";
import { useLocation } from "../../hooks/useLocation";
import { id } from "ethers";
import { useEffect, useState } from "react";
import { useStore } from "../../hooks/useStore";
import { distance_m } from "../../lib/run";
import { StoreItem } from "../../lib/types";

interface IProps  {
    id?: string
}

const Map = ({id}: IProps) => {
    const gpsRate = useReadLocalStorage<number>(`${APP_PREFIX}-gpsrate`)
    const loc = useLocation(gpsRate || 1000);
    const storeGeo = useStore<StoreItem>(GEO_DATA_STORAGE)
    const [points, setPoints] = useState<StoreItem[]>()
    const [polyline, setPolyline] = useState<LatLngExpression[]>([])


    useEffect(() =>{
        if (!storeGeo || !id) return
        (async () => {
            const points = await storeGeo.getAll(id)
            setPoints(points)
            setPolyline(points.map((v) => [v.loc.lat, v.loc.lon]))
        })()
    }, [storeGeo, id])

    return (<>
        {loc &&
            <MapContainer className="min-w-full w-full w-fill min-h-[1000px] h-full z-0" style={{width: "100%", height: "100%"}} center={[loc.lat, loc.lon]} zoom={15} >
                <TileLayer
                    attribution='&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                { points && polyline ?
                    //points.map((v) => <Marker key={v.hash} position={[v.loc.lat, v.loc.lon]} />)
                    <Polyline positions={polyline}/>
                :
                    <Marker position={[loc.lat, loc.lon]} />
                }
            </MapContainer>
        }
    </>)
}

export default Map;